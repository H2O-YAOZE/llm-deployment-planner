'use strict';

window.CostEngine = (() => {
  const clamp = (value, min, max) => Math.min(Math.max(Number(value) || 0, min), max);
  const positive = (value, fallback = 0) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  };

  function topologyRound(cards) {
    if (cards <= 1) return 1;
    if (cards <= 2) return 2;
    if (cards <= 4) return 4;
    if (cards <= 8) return 8;
    return Math.ceil(cards / 8) * 8;
  }

  function parallelEfficiency(cards, hasHighSpeedLink) {
    let base = 1;
    if (cards <= 1) base = 1;
    else if (cards <= 2) base = 0.92;
    else if (cards <= 4) base = 0.88;
    else if (cards <= 8) base = 0.82;
    else if (cards <= 16) base = 0.74;
    else base = 0.65;
    return hasHighSpeedLink || cards <= 1 ? base : base * 0.82;
  }

  // 公式化吞吐推导：Prefill 吃算力，Decode 吃显存带宽。
  // 公式固定，参数全部来自所选卡 / 所选模型对象；系数 μ（算力利用率）与 β（带宽效率）
  // 由 910C + DeepSeek V4-Flash（W8A8）实测反标定，可在界面调整。
  // 系数默认值取工程规划常用的理论区间中位（不是实测标定值）：
  //   μ 算力利用率 45%（Prefill MFU 典型 40%~50%）
  //   β 带宽效率 70%（大块权重顺序读取，实测可达峰值的 60%~80%）
  // 这是「理论上限」口径，不含框架调度开销；与 910C 实测的差距见 renderReverse 的实测对照行。
  const DEFAULT_MFU = 0.45;
  const DEFAULT_BANDWIDTH_EFF = 0.7;

  // 按「计算走哪条管线」取卡的算力档位，而不是按权重字节猜：
  //   W8A8（int8）：权重与激活都走 INT8 管线，取 int8 档（通常 2× fp16）
  //   仅权重 INT8（W8A16 / int8wo）：权重 1 byte 但矩阵乘仍走 FP16 管线，取 fp16 档
  //   FP8 / FP4 走各自的低精度管线；缺失时按 fp8 → int8 → fp16 逐级回退
  function cardComputeTFLOPS(card, computeKey, weightBytes) {
    const table = (card && card.computeTflops) || {};
    const key = computeKey || (weightBytes === 1 ? 'int8' : weightBytes <= 0.5 ? 'fp8' : 'fp16');
    if (key === 'int8') return positive(table.int8, positive(table.fp8, positive(table.fp16, 0)));
    if (key === 'fp8') return positive(table.fp8, positive(table.int8, positive(table.fp16, 0)));
    return positive(table.fp16, 0);
  }

  function perCardThroughput(card, model, weightBytes, coeff, computeKey) {
    const P = positive(model && (model.activeParamsB ?? model.totalParamsB), 0);
    const F = cardComputeTFLOPS(card, computeKey, weightBytes);
    const BW = positive(card && card.bandwidthGBs, 0);
    const mu = clamp(coeff && coeff.mfu != null ? coeff.mfu : DEFAULT_MFU, 0.02, 1);
    const beta = clamp(coeff && coeff.bandwidthEff != null ? coeff.bandwidthEff : DEFAULT_BANDWIDTH_EFF, 0.02, 1);
    // Prefill：每 Token 计算量 = 2 × 激活参数（FLOP）；Decode：每 Token 读权重 = 激活参数 × 权重字节（Byte）
    const flopsPerToken = P > 0 ? 2 * P * 1e9 : 0;
    const bytesPerToken = P > 0 ? P * weightBytes * 1e9 : 0;
    const prefill = F > 0 && flopsPerToken > 0 ? F * 1e12 * mu / flopsPerToken : NaN;
    const decode = BW > 0 && bytesPerToken > 0 ? BW * 1e9 * beta / bytesPerToken : NaN;
    return {
      activeParamsB: P, computeTFLOPS: F, bandwidthGBs: BW, mfu: mu, bandwidthEff: beta,
      flopsPerToken, bytesPerToken, prefill, decode,
      prefillByFormula: Number.isFinite(prefill), decodeByFormula: Number.isFinite(decode)
    };
  }

  // 理论吞吐模型（全部参数来自所选卡 / 所选模型对象，公式固定）
  //   Prefill（算力瓶颈）：单卡吞吐 ＝ F × μ ÷ (2 × P_act)
  //   Decode（带宽瓶颈） ：单卡吞吐 ＝ B × BW × β ÷ (W + B × KV_会话)
  //     W = P_act × b_w 为激活权重；B = 每组承载路数。
  //     一个 decode step 读一次权重 + B 路各自的 KV，产出 B 个 token；
  //     组内 n 张卡做 TP，权重与 KV 各分片 1/n，因此单卡读取量 ÷ n、step 时间也 ÷ n，
  //     两项抵消后单卡吞吐仍为上式（B 指的是整组承载的路数）。
  function theoryThroughput(input) {
    const { card, model, weightBytes, kvBytes, coeff, cardsPerGroup, concurrency, contextK, computeKey } = input;
    const P = positive(model && (model.activeParamsB ?? model.totalParamsB), 0);
    const F = cardComputeTFLOPS(card, computeKey, weightBytes);
    const BW = positive(card && card.bandwidthGBs, 0);
    const mu = clamp(coeff && coeff.mfu != null ? coeff.mfu : DEFAULT_MFU, 0.02, 1);
    const beta = clamp(coeff && coeff.bandwidthEff != null ? coeff.bandwidthEff : DEFAULT_BANDWIDTH_EFF, 0.02, 1);
    const weightsActiveGB = P * weightBytes;
    const kvSeqGB = P > 0 ? (kvPerTokenKB(model, kvBytes) / 1024) * positive(contextK, 0) : 0;
    const flopsPerToken = 2 * P * 1e9;
    const prefillPerCard = F > 0 && flopsPerToken > 0 ? F * 1e12 * mu / flopsPerToken : NaN;
    const decodePerCardAt = streams => {
      const B = positive(streams, 0);
      if (!(BW > 0) || !(weightsActiveGB > 0)) return NaN;
      const bytesPerStep = (weightsActiveGB + B * kvSeqGB) / Math.max(cardsPerGroup, 1);
      const stepSeconds = bytesPerStep / (BW * beta);
      return stepSeconds > 0 ? B / stepSeconds / Math.max(cardsPerGroup, 1) : 0;
    };
    // Decode 容量闭式解：反解「单路速度 ≥ v」允许的最大 batch
    //   s(B) = n × BW × β / (W + B × KV) ≥ v
    //   → B ≤ (n × BW × β / v − W) / KV ＝ B_max（单组可承载路数）
    //   → 组数 = ⌈并发 ÷ B_max⌉
    // B 越小单路越快，因此这是「最少需要几组」的下界；batch 再大就保不住目标速度。
    const decodeSizing = (targetSpeed = 30, parallelEff = 1) => {
      const v = Math.max(1, positive(targetSpeed, 30));
      const groupBandwidthGB = BW * beta * Math.max(cardsPerGroup, 1) * positive(parallelEff, 1);
      const budgetGB = groupBandwidthGB / v;          // 保住 v 时允许的总读取量
      const headroomGB = budgetGB - weightsActiveGB;  // 扣掉权重后留给 KV 的余量
      const streamsPerGroup = kvSeqGB > 0 ? headroomGB / kvSeqGB : (headroomGB > 0 ? Infinity : 0);
      const sloMet = headroomGB > 0;
      const capped = Number.isFinite(streamsPerGroup) ? Math.max(0, streamsPerGroup) : streamsPerGroup;
      return {
        targetSpeed: v, parallelEff, groupBandwidthGB, budgetGB, headroomGB,
        streamsPerGroup: capped, sloMet,
        // 单路速度理论上限：batch 越薄越快，极限是只服务一路时
        maxPerStreamSpeed: groupBandwidthGB / (weightsActiveGB + (kvSeqGB > 0 ? kvSeqGB : 0)),
        perStreamSpeedAt: streams => groupBandwidthGB / (weightsActiveGB + positive(streams, 0) * kvSeqGB)
      };
    };
    return {
      activeParamsB: P, computeTFLOPS: F, bandwidthGBs: BW, mfu: mu, bandwidthEff: beta,
      weightsActiveGB, kvSeqGB, flopsPerToken, prefillPerCard, decodePerCardAt, decodeSizing,
      bytesPerStepAt: streams => (weightsActiveGB + positive(streams, 0) * kvSeqGB) / Math.max(cardsPerGroup, 1),
      stepSecondsAt: streams => (weightsActiveGB + positive(streams, 0) * kvSeqGB) / Math.max(cardsPerGroup, 1) / (BW * beta),
      prefillByFormula: Number.isFinite(prefillPerCard), decodeByFormula: BW > 0 && weightsActiveGB > 0,
      concurrency
    };
  }

  function normalizeRoles(roles) {
    return roles.map(role => ({
      ...role,
      users: positive(role.users),
      prefillK: positive(role.prefillK),
      decodeK: positive(role.decodeK),
      requests: positive(role.requests),
      activePct: clamp(role.activePct, 0, 100),
      parallelTasks: positive(role.parallelTasks, 1),
      prefixReuse: clamp(role.prefixReuse, 0, 0.95),
      // 会话总上下文（决定 KV 占用）与每请求新增输入（决定 Prefill 吞吐）是两个独立量；
      // 未填时按旧口径回退为 输入+输出，保持兼容
      sessionContextK: positive(role.sessionContextK) || (positive(role.prefillK) + positive(role.decodeK))
    }));
  }

  function computeWorkload(state) {
    const roles = normalizeRoles(state.roles);
    const roleLoads = roles.map(role => ({
      ...role,
      inputM: role.users * role.requests * role.prefillK / 1000,
      outputM: role.users * role.requests * role.decodeK / 1000,
      concurrency: role.users * role.activePct / 100 * role.parallelTasks,
      contextK: role.sessionContextK
    }));
    const profileInputM = roleLoads.reduce((sum, role) => sum + role.inputM, 0);
    const profileOutputM = roleLoads.reduce((sum, role) => sum + role.outputM, 0);
    const scenarioConcurrencyRaw = roleLoads.reduce((sum, role) => sum + role.concurrency, 0);
    const scenarioConcurrency = Math.max(1, Math.ceil(scenarioConcurrencyRaw));
    const activeHours = 12;
    const activeSeconds = activeHours * 3600;
    const streamSpeed = Math.max(positive(state.streamSpeed, 50), 1);
    const inputOutputRatio = profileOutputM > 0 ? profileInputM / profileOutputM : 1;
    const continuousOutputM = scenarioConcurrency * streamSpeed * activeSeconds / 1e6;
    const continuousInputM = continuousOutputM * inputOutputRatio;
    const isContinuous = state.cloudMode === 'continuous';
    const inputM = isContinuous ? continuousInputM : profileInputM;
    const outputM = isContinuous ? continuousOutputM : profileOutputM;
    const effectiveProfileInputM = roleLoads.reduce((sum, role) => sum + role.inputM * (1 - role.prefixReuse), 0);
    const weightedReuse = profileInputM > 0 ? 1 - effectiveProfileInputM / profileInputM : 0;
    const effectivePrefillM = inputM * (1 - weightedReuse);
    const capacityBuffer = Math.max(positive(state.capacityBuffer, 1.2), 1);

    const volumeDecodeNeed = outputM * 1e6 / activeSeconds;
    const volumePrefillNeed = effectivePrefillM * 1e6 / activeSeconds;
    const concurrencyDecodeNeed = scenarioConcurrency * streamSpeed;
    const decodeNeed = Math.max(volumeDecodeNeed, concurrencyDecodeNeed) * capacityBuffer;

    const contextScale = scenarioConcurrencyRaw > 0 ? scenarioConcurrency / scenarioConcurrencyRaw : 0;
    const totalContextK = roleLoads.reduce((sum, role) => sum + role.concurrency * role.contextK, 0) * contextScale;
    const prefillContextK = roleLoads.reduce((sum, role) => sum + role.concurrency * role.prefillK, 0) * contextScale;
    const decodeContextK = roleLoads.reduce((sum, role) => sum + role.concurrency * role.decodeK, 0) * contextScale;
    const activeRoles = roleLoads.filter(role => role.users > 0);
    const maxContextK = activeRoles.length ? Math.max(...activeRoles.map(role => role.contextK)) : 0;

    // TTFT 峰值口径：同时处于 Prefill 的并发，要在首 Token 预算内出字所需的 Prefill 吞吐。
    // 与 Decode 的峰值口径（并发×满速）对称；两项物理修正：
    //   1) 前缀复用：命中部分无需重新 Prefill（与日均口径一致）
    //   2) 同时预填比例 ttftBurstShare：一次请求里 Decode 占时长远高于 Prefill，
    //      同一瞬间只有部分并发处于 Prefill；默认 25% 为工程经验值，可调。
    const ttftSlo = Math.max(0.1, positive(state.ttftSlo, 10));
    const ttftInterconnect = (state.card && state.card.interconnect) || '';
    const ttftOverhead = /HCCS/i.test(ttftInterconnect) ? 0.6 : /NVLink/i.test(ttftInterconnect) ? 0.4 : 1;
    const ttftBudget = Math.max(0.1, ttftSlo - ttftOverhead);
    const ttftBurstShare = clamp(state.ttftBurstShare === undefined ? 0.25 : Number(state.ttftBurstShare), 0, 1);
    const ttftPrefillNeed = roleLoads.reduce((sum, role) => sum + role.concurrency * role.prefillK * 1000 * (1 - role.prefixReuse), 0) * contextScale * ttftBurstShare / ttftBudget;
    const prefillNeedSource = ttftPrefillNeed > volumePrefillNeed ? 'TTFT 峰值' : '日均量';
    const prefillNeed = Math.max(volumePrefillNeed, ttftPrefillNeed) * capacityBuffer;

    return {
      roles: roleLoads,
      profileInputM,
      profileOutputM,
      inputM,
      outputM,
      inputOutputRatio,
      weightedReuse,
      effectivePrefillM,
      scenarioConcurrencyRaw,
      scenarioConcurrency,
      activeHours,
      activeSeconds,
      streamSpeed,
      volumeDecodeNeed,
      volumePrefillNeed,
      concurrencyDecodeNeed,
      decodeNeed,
      prefillNeed,
      ttftSlo,
      ttftBudget,
      ttftOverhead,
      ttftBurstShare,
      ttftPrefillNeed,
      prefillNeedSource,
      totalContextK,
      prefillContextK,
      decodeContextK,
      maxContextK,
      capacityBuffer,
      sourceLabel: isContinuous ? '12 小时持续负载' : '组织画像'
    };
  }

  function computeCloud(state, workload) {
    const workdays = clamp(state.workdays, 1, 365);
    const price = state.apiPrice;
    const hitRate = clamp(state.cacheRate, 0, 1);
    const hitM = workload.inputM * hitRate;
    const missM = workload.inputM - hitM;
    const peakFactor = price.peakPricing ? 1 + clamp(state.peakShare, 0, 1) : 1;
    const tokenDaily = (hitM * positive(state.apiHitPrice, price.hit) +
      missM * positive(state.apiMissPrice, price.miss) +
      workload.outputM * positive(state.apiOutPrice, price.out)) * peakFactor;
    const usageDayCost = state.cloudMode === 'actual'
      ? positive(state.actualDailyCost)
      : tokenDaily;
    const annualCost = usageDayCost * workdays;
    return {
      usageDayCost,
      annualCost,
      averageDayCost: annualCost / 365,
      tokenDaily,
      hitM,
      missM,
      peakFactor,
      workdays
    };
  }

  function kvPerTokenKB(model, kvBytes) {
    const bytes = positive(kvBytes, 2) || 2;
    if (model.attentionType.startsWith('DSA')) {
      return model.layers * 576 * bytes / 1024 * 0.1;
    }
    if (model.attentionType.startsWith('MLA')) {
      return model.layers * 576 * bytes / 1024;
    }
    return 2 * model.layers * (model.kvHeads || 8) * (model.headDim || 128) * bytes / 1024;
  }

  function computeCapacity(state, workload) {
    const model = state.model;
    const card = state.card;
    const benchmark = state.benchmark;
    const weightBytes = positive(state.weightBytes, 1) || 1;
    const kvBytes = positive(state.kvBytes, 2) || 2;
    const memoryUtilization = clamp(state.memoryUtilization, 0.5, 0.95);
    const runtimeReserve = clamp(state.runtimeReserve, 0, 0.5);
    const weightsGB = model.totalParamsB * weightBytes;
    const runtimeGB = weightsGB * runtimeReserve;
    const perTokenKB = kvPerTokenKB(model, state.kvBytes);
    const kvPerKGB = perTokenKB / 1024;
    const sessionKvGB = kvPerKGB * workload.maxContextK;
    const totalKvGB = kvPerKGB * workload.totalContextK;
    const usableCardGB = card.memoryGB * memoryUtilization;
    const rawCardsPerReplica = Math.max(1, Math.ceil((weightsGB + runtimeGB + sessionKvGB) / usableCardGB));
    const cardsPerReplica = topologyRound(rawCardsPerReplica);
    const replicaUsableGB = cardsPerReplica * usableCardGB;
    const kvBudgetPerReplica = Math.max(0, replicaUsableGB - weightsGB - runtimeGB);
    const replicasKv = kvBudgetPerReplica > 0 ? Math.max(1, Math.ceil(totalKvGB / kvBudgetPerReplica)) : Infinity;
    // PCIe 互联（含 "PCIe 4.0" / "PCIe 5.0"）没有 NVLink / HCCS 级带宽，多卡并行要打折
    const hasHighSpeedLink = !/无 NVLink|PCIe/i.test(card.interconnect) && !/RTX/.test(card.name);
    const efficiency = parallelEfficiency(cardsPerReplica, hasHighSpeedLink);
    const benchmarkFallbackDecode = Math.max(positive(state.decodePerCard, benchmark.decode), 1);
    const benchmarkFallbackPrefill = Math.max(positive(state.prefillPerCard, benchmark.prefill), 1);
    const benchEff = Number.isFinite(benchmark.efficiencyOverride) ? benchmark.efficiencyOverride : efficiency;
    // 精度感知吞吐：低精度权重读取量减半（Decode 带宽瓶颈）且算力约翻倍（Prefill 算力瓶颈），统一按权重字节反比缩放。
    // 仅用于「卡缺算力 / 带宽或模型缺激活参数」而回退工程基线的场合；走公式时精度已内置，不再重复缩放。
    const precisionScale = (positive(benchmark.baseWeightBytes, weightBytes) || weightBytes) / weightBytes;
    const tput = perCardThroughput(card, state.model, weightBytes, { mfu: state.mfu, bandwidthEff: state.bandwidthEff }, state.computeKey);
    // 理论吞吐（公式驱动，参数全部来自所选卡 / 所选模型对象）
    // 理论吞吐（公式驱动，参数全部来自所选卡 / 所选模型对象）
    //   Prefill：单卡吞吐 ＝ F × μ ÷ (2 × P_act)          —— 算力瓶颈
    //   Decode ：单卡吞吐 ＝ B × BW × β ÷ (W + B × KV_会话) —— 带宽瓶颈，含 TP 分片与 batch 分摊
    //     W = P_act × b_w（激活权重），B = 每组承载路数；一个 step 读一次权重 + B 路各自 KV，产出 B 个 token
    const theory = theoryThroughput({
      card, model: state.model, weightBytes, kvBytes, coeff: { mfu: state.mfu, bandwidthEff: state.bandwidthEff },
      cardsPerGroup: cardsPerReplica, concurrency: workload.scenarioConcurrency, contextK: workload.maxContextK,
      computeKey: state.computeKey
    });
    const prefillPerCardTheory = theory.prefillPerCard;
    // Decode 约束的正确解法是闭式的，不能迭代：
    //   单路速度 s(B) = n × BW × β / (W + B × KV_会话)，B 越小（batch 越薄）单路越快
    //   要 s(B) ≥ v（目标单路速度）→ B ≤ (n × BW × β / v − W) / KV_会话 = B_max
    //   组数 = ⌈并发 ÷ B_max⌉。若按「聚合吞吐 ÷ 单组能力」迭代，会因 B 随组数变小而正向发散。
    //   B_max ≤ 0 表示这张卡跑这个模型连一路都撑不到 v（权重读取本身就超过时间预算），
    //   属于 SLO 不可达——此时 Decode 不参与定规模，改由显存 / Prefill 决定，并在界面上告警。
    const decodeSizing = theory.decodeSizing(workload.streamSpeed, benchEff);
    const bMax = decodeSizing.streamsPerGroup;
    const replicasDecodeTheory = bMax > 0 ? Math.max(1, Math.ceil(workload.scenarioConcurrency / bMax)) : 1;
    let replicas = Math.max(replicasKv, replicasDecodeTheory, 1);
    let streamsPerGroup = workload.scenarioConcurrency / replicas;
    let decodePerCardTheory = theory.decodePerCardAt(streamsPerGroup);
    let replicaDecode = Number.isFinite(decodePerCardTheory) && decodePerCardTheory > 0
      ? decodePerCardTheory * cardsPerReplica * benchEff
      : benchmarkFallbackDecode * cardsPerReplica * benchEff * precisionScale;
    let replicaPrefill = Number.isFinite(prefillPerCardTheory) && prefillPerCardTheory > 0
      ? prefillPerCardTheory * cardsPerReplica * benchEff
      : benchmarkFallbackPrefill * cardsPerReplica * benchEff * precisionScale;
    // Prefill 不依赖 batch，直接按吞吐口径求组数；最终取三条约束的最大值
    const replicasPrefillTheory = replicaPrefill > 0 ? Math.max(1, Math.ceil(workload.prefillNeed / replicaPrefill)) : 1;
    replicas = Math.max(replicasKv, replicasDecodeTheory, replicasPrefillTheory, 1);
    streamsPerGroup = workload.scenarioConcurrency / replicas;
    decodePerCardTheory = theory.decodePerCardAt(streamsPerGroup);
    replicaDecode = Number.isFinite(decodePerCardTheory) && decodePerCardTheory > 0
      ? decodePerCardTheory * cardsPerReplica * benchEff
      : benchmarkFallbackDecode * cardsPerReplica * benchEff * precisionScale;
    const replicasPrefill = replicasPrefillTheory;
    const replicasDecode = replicasDecodeTheory;
    const cards = replicas * cardsPerReplica;
    const nodeCardCapacity = [1, 2, 4, 8].includes(Number(state.nodeCardCapacity)) ? Number(state.nodeCardCapacity) : 8;
    const nodes = Math.ceil(cards / nodeCardCapacity);
    const bottlenecks = [];
    if (replicas === 1) bottlenecks.push('完整权重底座');
    else {
      if (replicasKv === replicas) bottlenecks.push('KV Cache');
      if (replicasDecode === replicas) bottlenecks.push('Decode 吞吐');
      if (replicasPrefill === replicas) bottlenecks.push(workload.prefillNeedSource === 'TTFT 峰值' ? 'Prefill · TTFT 峰值' : 'Prefill 日均量');
    }
    return {
      weightsGB,
      runtimeGB,
      perTokenKB,
      sessionKvGB,
      totalKvGB,
      usableCardGB,
      rawCardsPerReplica,
      cardsPerReplica,
      replicaUsableGB,
      kvBudgetPerReplica,
      replicasKv,
      replicasDecode,
      replicasPrefill,
      replicas,
      cards,
      nodeCardCapacity,
      nodes,
      efficiency,
      replicaDecode,
      replicaPrefill,
      precisionScale,
      throughput: tput,
      theory: {
        ...theory,
        streamsPerGroup,
        bytesPerStep: theory.bytesPerStepAt(streamsPerGroup),
        stepSeconds: theory.stepSecondsAt(streamsPerGroup),
        decodePerCard: decodePerCardTheory,
        prefillPerCard: prefillPerCardTheory,
        decodeSizing,
        decodeSloMet: decodeSizing.sloMet,
        maxPerStreamSpeed: decodeSizing.maxPerStreamSpeed,
        perStreamSpeed: decodeSizing.perStreamSpeedAt(streamsPerGroup),
        replicaDecode,
        replicaPrefill
      },
      installedDecode: replicas * replicaDecode,
      installedPrefill: replicas * replicaPrefill,
      bottleneck: bottlenecks.join(' / '),
      hasHighSpeedLink
    };
  }

  function computeLocalCost(state, capacity, workload) {
    const cardPriceWan = positive(state.cardPriceWan);
    const platformPriceWan = positive(state.platformPriceWan);
    const integrationPct = clamp(state.integrationPct, 0, 1);
    const componentHardwareWan = (capacity.cards * cardPriceWan + capacity.nodes * platformPriceWan) * (1 + integrationPct);
    const quoteHardwareWan = capacity.nodes * positive(state.nodeQuoteWan);
    const hardwareWan = state.pricingMode === 'nodeQuote' ? quoteHardwareWan : componentHardwareWan;
    const softwareOnceWan = positive(state.softwareOnceWan);
    const capex = (hardwareWan + softwareOnceWan) * 10000;
    const hardwareCapex = hardwareWan * 10000;

    const platformPowerKw = positive(state.platformPowerKw, 0.6);
    const activePowerKw = capacity.cards * state.card.tdpW / 1000 + capacity.nodes * platformPowerKw;
    const idleRatio = clamp(state.idlePowerRatio, 0, 1);
    const workdays = clamp(state.workdays, 1, 365);
    const activeDayKWh = activePowerKw * workload.activeHours + activePowerKw * idleRatio * (24 - workload.activeHours);
    const offDayKWh = activePowerKw * idleRatio * 24;
    const annualFacilityKWh = (activeDayKWh * workdays + offDayKWh * (365 - workdays)) * positive(state.pue, 1.3);
    const annualElectricity = annualFacilityKWh * positive(state.electricityRate, 0.7);
    const annualMaintenance = hardwareCapex * clamp(state.maintenancePct, 0, 0.5);
    const annualSoftware = positive(state.softwareYearWan) * 10000;
    const annualOps = positive(state.opsMonthlyWan) * 10000 * 12;
    const annualOpex = annualElectricity + annualMaintenance + annualSoftware + annualOps;
    return {
      componentHardwareWan,
      quoteHardwareWan,
      hardwareWan,
      capex,
      hardwareCapex,
      activePowerKw,
      idleRatio,
      activeDayKWh,
      offDayKWh,
      annualFacilityKWh,
      annualElectricity,
      annualMaintenance,
      annualSoftware,
      annualOps,
      annualOpex,
      averageDayOpex: annualOpex / 365
    };
  }

  function compute(state) {
    const workload = computeWorkload(state);
    const cloud = computeCloud(state, workload);
    const capacity = computeCapacity(state, workload);
    const local = computeLocalCost(state, capacity, workload);
    const dailySaving = cloud.averageDayCost - local.averageDayOpex;
    const breakevenDays = dailySaving > 0 ? local.capex / dailySaving : null;
    const cloudTco3 = cloud.annualCost * 3;
    const localTco3 = local.capex + local.annualOpex * 3;
    return {
      workload,
      cloud,
      capacity,
      local,
      dailySaving,
      breakevenDays,
      cloudTco3,
      localTco3,
      winner3: localTco3 < cloudTco3 ? 'local' : 'cloud'
    };
  }

  function computeReverseCapacity(state) {
    const card = state.card;
    const totalCards = Math.max(1, Math.floor(positive(state.deviceCount, 1))) *
      Math.max(1, Math.floor(positive(state.cardsPerDevice, 8)));
    const memoryUtilization = clamp(state.memoryUtilization, 0.5, 0.95);
    const runtimeReserve = clamp(state.runtimeReserve, 0, 0.5);
    const weightBytes = positive(state.weightBytes, 1) || 1;
    const kvBytes = positive(state.kvBytes, 2) || 2;
    const maxContextK = Math.max(1, positive(state.maxContextK, 128));
    const typicalInputK = Math.max(0.001, positive(state.typicalInputK, 32));
    const decodeOutputK = Math.max(0.001, positive(state.decodeOutputK, 1));
    const targetUserSpeed = Math.max(1, positive(state.targetUserSpeed, 30));
    const plannedConcurrency = Math.max(1, Math.floor(positive(state.plannedConcurrency, 20)));
    const userRequestsPerHour = Math.max(0.01, positive(state.userRequestsPerHour, 2));
    const userRequestRate = userRequestsPerHour / 3600;
    const prefixCache = clamp(state.prefixCache, 0, 0.95);
    const ttftSlo = Math.max(0.1, positive(state.ttftSlo, 10));
    const benchmark = state.benchmark || { decode: 1, prefill: 1 };
    const precisionScale = (positive(benchmark.baseWeightBytes, weightBytes) || weightBytes) / weightBytes;
    const usableCardGB = card.memoryGB * memoryUtilization;

    const results = (state.models || []).map(model => {
      const weightsGB = model.totalParamsB * weightBytes;
      const runtimeGB = weightsGB * runtimeReserve;
      const perTokenKB = kvPerTokenKB(model, kvBytes);
      const kvPerKGB = perTokenKB / 1024;
      const sessionKvGB = kvPerKGB * maxContextK;
      const rawCardsPerGroup = Math.max(1, Math.ceil((weightsGB + runtimeGB + sessionKvGB) / usableCardGB));
      const cardsPerGroup = topologyRound(rawCardsPerGroup);
      // Catalog context values use the common 1K = 1,024-token convention.
      const contextCapacityK = Math.max(positive(model.contextK), positive(model.extendedContextK)) * 1.024;
      const contextCompatible = contextCapacityK >= maxContextK;
      const usesExtendedContext = contextCompatible && positive(model.contextK) * 1.024 < maxContextK;
      const memoryFits = cardsPerGroup <= totalCards;
      const deployable = memoryFits && contextCompatible;
      const groupCount = deployable ? Math.floor(totalCards / cardsPerGroup) : 0;
      const usedCards = groupCount * cardsPerGroup;
      const spareCards = totalCards - usedCards;
      const groupUsableGB = cardsPerGroup * usableCardGB;
      const kvBudgetPerGroupGB = Math.max(0, groupUsableGB - weightsGB - runtimeGB);
      const totalKvBudgetGB = kvBudgetPerGroupGB * groupCount;
      const memoryConcurrency = deployable && sessionKvGB > 0
        ? Math.max(0, Math.floor(totalKvBudgetGB / sessionKvGB)) : 0;
      const hasHighSpeedLink = !/无 NVLink|PCIe/i.test(card.interconnect) && !/RTX/.test(card.name);
      const efficiency = parallelEfficiency(cardsPerGroup, hasHighSpeedLink);
      const benchEff = Number.isFinite(benchmark.efficiencyOverride) ? benchmark.efficiencyOverride : efficiency;
      // 理论吞吐（公式驱动）。Decode 吞吐随并发变化（batch 分摊），用阻尼迭代求自洽解：
      // 并发越高 → 每组 batch 越大 → 权重读取摊得越薄 → 单卡吞吐越高 → 又能撑更多并发
      const theory = theoryThroughput({
        card, model, weightBytes, kvBytes, coeff: { mfu: state.mfu, bandwidthEff: state.bandwidthEff },
        cardsPerGroup, concurrency: plannedConcurrency, contextK: maxContextK,
        computeKey: state.computeKey
      });
      let streamsGuess = Math.max(1, positive(plannedConcurrency, 20));
      let decodePerCardTheory = NaN;
      for (let i = 0; i < 8; i += 1) {
        decodePerCardTheory = theory.decodePerCardAt(deployable ? streamsGuess / groupCount : 0);
        const totalNow = Number.isFinite(decodePerCardTheory) && decodePerCardTheory > 0
          ? decodePerCardTheory * cardsPerGroup * groupCount * benchEff
          : benchmark.decode * cardsPerGroup * groupCount * benchEff * precisionScale;
        const next = Math.max(1, Math.min(totalNow / Math.max(targetUserSpeed, 1), streamsGuess * 2 + 8));
        if (Math.abs(next - streamsGuess) < 1) { streamsGuess = next; break; }
        streamsGuess = streamsGuess * 0.5 + next * 0.5;
      }
      const streamsPerGroup = deployable ? streamsGuess / groupCount : 0;
      decodePerCardTheory = theory.decodePerCardAt(streamsPerGroup);
      const totalDecode = Number.isFinite(decodePerCardTheory) && decodePerCardTheory > 0
        ? decodePerCardTheory * cardsPerGroup * groupCount * benchEff
        : groupCount * benchmark.decode * cardsPerGroup * benchEff * precisionScale;
      const prefillPerCardTheory = theory.prefillPerCard;
      const totalPrefill = Number.isFinite(prefillPerCardTheory) && prefillPerCardTheory > 0
        ? prefillPerCardTheory * cardsPerGroup * groupCount * benchEff
        : groupCount * benchmark.prefill * cardsPerGroup * benchEff * precisionScale;
      const instantDecodeConcurrency = deployable ? Math.floor(totalDecode / targetUserSpeed) : 0;
      const requestSeconds = decodeOutputK * 1000 / targetUserSpeed;
      const decodeConcurrency = deployable
        ? Math.floor(totalDecode / Math.max(decodeOutputK * 1000 * userRequestRate, 0.001)) : 0;
      const effectiveInputTokens = typicalInputK * 1000 * (1 - prefixCache);
      const prefillConcurrency = deployable
        ? Math.floor(totalPrefill / Math.max(effectiveInputTokens * userRequestRate, 0.001)) : 0;
      const schedulingOverheadSeconds = cardsPerGroup > 1 ? 1 : 0.55;
      const ttftComputeBudgetSeconds = Math.max(0, ttftSlo - schedulingOverheadSeconds);
      const prefillTtftConcurrency = deployable
        ? Math.max(0, Math.floor(totalPrefill * ttftComputeBudgetSeconds / Math.max(effectiveInputTokens, 1))) : 0;
      const activeConcurrency = Math.max(0, Math.min(memoryConcurrency, instantDecodeConcurrency, prefillTtftConcurrency));
      const onlineConcurrency = Math.max(0, Math.min(memoryConcurrency, decodeConcurrency, prefillConcurrency));
      const finalConcurrency = activeConcurrency;
      const averageActiveStreams = plannedConcurrency * Math.min(1, requestSeconds * userRequestRate);
      const plannedUserSpeed = plannedConcurrency > 0
        ? Math.min(targetUserSpeed, totalDecode / Math.max(averageActiveStreams, 1)) : 0;
      const requestThroughput = typicalInputK > 0 ? totalPrefill / (typicalInputK * 1000) : 0;
      const activeConstraints = [
        ['显存 / KV', memoryConcurrency],
        ['Decode 瞬时生成', instantDecodeConcurrency],
        ['Prefill / TTFT', prefillTtftConcurrency]
      ];
      const onlineConstraints = [
        ['显存 / KV', memoryConcurrency],
        ['Decode 持续负载', decodeConcurrency],
        ['Prefill 持续负载', prefillConcurrency]
      ];
      const activeBottleneckValue = Math.min(...activeConstraints.map(x => x[1]));
      const onlineBottleneckValue = Math.min(...onlineConstraints.map(x => x[1]));
      const bottlenecks = deployable ? activeConstraints.filter(x => x[1] === activeBottleneckValue).map(x => x[0]) :
        [!contextCompatible ? `模型最高支持 ${contextCapacityK}K 上下文` : '完整权重无法装入'];
      const onlineBottlenecks = deployable ? onlineConstraints.filter(x => x[1] === onlineBottleneckValue).map(x => x[0]) : bottlenecks;
      return {
        model, deployable, contextCompatible, contextCapacityK, usesExtendedContext, memoryFits, totalCards, usedCards, spareCards, cardsPerGroup, rawCardsPerGroup,
        groupCount, weightsGB, runtimeGB, usableCardGB, groupUsableGB, perTokenKB,
        sessionKvGB, kvBudgetPerGroupGB, totalKvBudgetGB, memoryConcurrency,
        instantDecodeConcurrency, prefillTtftConcurrency, activeConcurrency, decodeConcurrency, prefillConcurrency, onlineConcurrency, finalConcurrency, totalDecode, totalPrefill,
        requestThroughput, targetUserSpeed, plannedConcurrency, plannedUserSpeed, userRequestsPerHour, userRequestRate,
        efficiency, bottleneck: bottlenecks.join(' / '), activeBottleneck: bottlenecks.join(' / '), onlineBottleneck: onlineBottlenecks.join(' / '), schedulingOverheadSeconds, ttftComputeBudgetSeconds, maxContextK, typicalInputK,
        decodeOutputK, precisionScale,
        theory: {
          ...theory,
          streamsPerGroup,
          bytesPerStep: theory.bytesPerStepAt(streamsPerGroup),
          stepSeconds: theory.stepSecondsAt(streamsPerGroup),
          decodePerCard: decodePerCardTheory,
          prefillPerCard: prefillPerCardTheory,
          decodeSizing: theory.decodeSizing(targetUserSpeed, benchEff),
          perStreamSpeed: theory.decodeSizing(targetUserSpeed, benchEff).perStreamSpeedAt(streamsPerGroup)
        },
        estimateGrade: 'C'
      };
    });
    results.sort((a, b) => Number(b.deployable) - Number(a.deployable) ||
      b.finalConcurrency - a.finalConcurrency || a.model.totalParamsB - b.model.totalParamsB);
    return { totalCards, deviceCount: state.deviceCount, cardsPerDevice: state.cardsPerDevice, card, results };
  }

  return { compute, computeReverseCapacity, kvPerTokenKB, topologyRound, parallelEfficiency };
})();
