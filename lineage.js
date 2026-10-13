'use strict';

window.CalculationLineage = (() => {
  const common = {
    roleUsers: ['profileTokens','concurrency','throughputNeed','contextLoad','cloudCost','cardCount','localCost','decision'],
    roleActive: ['concurrency','throughputNeed','contextLoad','cloudCost','cardCount','localCost','decision'],
    rolePrefill: ['profileTokens','inputRatio','prefillNeed','cloudCost','cardCount','localCost','decision'],
    roleDecode: ['profileTokens','inputRatio','throughputNeed','cloudCost','cardCount','localCost','decision'],
    roleRequests: ['profileTokens','inputRatio','prefillNeed','throughputNeed','cloudCost','cardCount','localCost','decision'],
    roleContext: ['contextLoad','kvCache','cardCount','nodes','hardware','energy','localCost','decision']
  };

  const roleNames = { code: '研发', product: '产品', office: '职能', agent: 'AI / Agent' };
  const roleInputs = Object.entries(roleNames).flatMap(([key, name]) => [
    { id: `${key}Users`, label: `${name}人数`, unit: '人', affects: common.roleUsers, formula: '人数 × 每日请求 × 单次 Token；人数 × 活跃率 × 并行任务', impact: '同时改变 Token 量、峰值并发、KV 驻留量，进而影响云端费用和本地卡数。' },
    { id: `${key}ActivePct`, label: `${name}峰值活跃率`, unit: '%', affects: common.roleActive, formula: '人数 × 活跃率 × 并行任务 = 该岗位并发', impact: '并发提高会抬高 Decode 吞吐需求与并发上下文，可能增加同模型部署组数。' },
    { id: `${key}PrefillK`, label: `${name} Prefill`, unit: 'K / 请求', affects: common.rolePrefill, formula: '人数 × 请求次数 × Prefill；并发 × Prefill = 输入上下文', impact: '增加输入 Token、Prefill 吞吐与 KV 上下文，可能同时推高 API 与卡数。' },
    { id: `${key}DecodeK`, label: `${name} Decode`, unit: 'K / 请求', affects: common.roleDecode, formula: '人数 × 请求次数 × Decode；并发 × Decode = 输出上下文', impact: '增加输出 Token 与 KV 驻留量；持续负载模式下还会改变输入/输出比例。' },
    { id: `${key}Requests`, label: `${name}每日请求`, unit: '次 / 人·天', affects: common.roleRequests, formula: '人数 × 每日请求 × 单次 Token', impact: '直接放大日 Token 量；组织画像模式下同时提高 Prefill / Decode 吞吐需求。' },
    { id: `${key}SessionContextK`, label: `${name}会话上下文`, unit: 'K Token', affects: common.roleContext, formula: '并发 × 会话上下文 = KV 驻留总量', impact: '决定每路并发占用的 KV 显存；与每请求新增输入相互独立，长会话场景需单独校准。' }
  ]);

  const groups = [
    { id: 'workload', label: '01 使用画像', inputs: [
      ...roleInputs,
      { id: 'streamSpeed', label: '单路输出速度', unit: 'tok/s', affects: ['continuousLoad','throughputNeed','cloudCost','cardCount','localCost','decision'], formula: '规划并发 × 单路速度 × 12 × 3600', impact: '持续使用模式下决定日输出 Token，也形成并发 Decode 吞吐下限。' }
    ]},
    { id: 'cloud', label: '02 云端计价', inputs: [
      { id: 'cloudMode', label: '云端成本口径', unit: '', affects: ['profileTokens','continuousLoad','prefillNeed','throughputNeed','contextLoad','cloudCost','cloudAnnual','cardCount','localCost','decision'], formula: '实际日账单：云端直接记账、本地按组织画像；12 小时持续使用：云端与本地共用持续负载', impact: '切换后会改写云端计价来源，并决定容量侧采用组织画像还是 12 小时持续负载。' },
      { id: 'actualDailyCost', label: '实际日账单', unit: '¥ / 使用日', affects: ['cloudCost','cloudAnnual','decision'], formula: '实际日账单 × 年使用天数', impact: '仅覆盖云端成本；本地容量仍由使用画像计算。' },
      { id: 'apiPriceProfile', label: 'API 计价基准', unit: '', affects: ['cloudCost','cloudAnnual','decision'], formula: '载入命中输入、未命中输入、输出及峰谷规则', impact: '替换整组 Token 单价。' },
      { id: 'cacheRate', label: '缓存命中率', unit: '%', affects: ['cloudSplit','cloudCost','cloudAnnual','decision'], formula: '输入 Token × 命中率 / 未命中率', impact: '只改变输入费用，不改变本地卡数。' },
      { id: 'peakShare', label: '高峰用量占比', unit: '%', affects: ['peakFactor','cloudCost','cloudAnnual','decision'], formula: '谷时基价 × (1 + 高峰占比)', impact: '仅对采用峰谷价的 API 生效。' },
      { id: 'apiHitPrice', label: '命中输入单价', unit: '¥ / M Token', affects: ['cloudCost','cloudAnnual','decision'], formula: '命中输入量 × 命中价', impact: '只影响云端费用与临界点。' },
      { id: 'apiMissPrice', label: '未命中输入单价', unit: '¥ / M Token', affects: ['cloudCost','cloudAnnual','decision'], formula: '未命中输入量 × 未命中价', impact: '只影响云端费用与临界点。' },
      { id: 'apiOutPrice', label: '输出单价', unit: '¥ / M Token', affects: ['cloudCost','cloudAnnual','decision'], formula: '输出 Token × 输出价', impact: '输出通常是 API 成本最敏感的单价项。' },
      { id: 'workdays', label: '年使用天数', unit: '天', affects: ['cloudAnnual','energy','localCost','decision'], formula: '云端日成本 × 使用日；本地按使用日 / 非使用日拆分功耗', impact: '同时影响云端年费和本地全年电耗。' }
    ]},
    { id: 'capacity', label: '03 模型与容量', inputs: [
      { id: 'modelSelect', label: '部署模型', unit: '', affects: ['weights','kvCache','cardCount','localCost','decision'], formula: '总参数决定权重；层数 / KV 头决定 KV Cache', impact: '模型参数和注意力结构会显著改变每个同模型部署组的显存与总卡数。' },
      { id: 'cardSelect', label: '算力卡', unit: '', affects: ['usableMemory','parallelEfficiency','cardCount','nodes','hardware','energy','localCost','decision'], formula: '显存、互联、TDP、单卡价格共同进入计算', impact: '同时改变显存约束、吞吐效率、节点数、采购价和电费。' },
      { id: 'weightPrecision', label: '权重精度', unit: '', affects: ['weights','replicaThroughput','cardCount','hardware','energy','localCost','decision'], formula: '模型总参数 B × 每参数 byte = 权重 GB；吞吐按基线字节 ÷ 当前字节缩放', impact: '精度越低权重越小、吞吐越高；只展示芯片与模型共同支持的格式。' },
      { id: 'kvPrecision', label: 'KV 精度', unit: '', affects: ['kvCache','cardCount','hardware','energy','localCost','decision'], formula: 'KV 结构 × 层数 × KV byte × 上下文', impact: '长上下文和高并发场景对 KV 精度非常敏感。' },
      { id: 'decodePerCard', label: '单卡 Decode', unit: 'tok/s', affects: ['replicaThroughput','cardCount','nodes','hardware','energy','localCost','decision'], formula: '单卡 Decode × 每组卡数 × 并行效率', impact: '数值降低会增加 Decode 所需的同模型部署组数及总卡数。' },
      { id: 'prefillPerCard', label: '单卡 Prefill', unit: 'tok/s', affects: ['replicaThroughput','cardCount','nodes','hardware','energy','localCost','decision'], formula: '单卡 Prefill × 每组卡数 × 并行效率', impact: '数值降低会增加 Prefill 所需的同模型部署组数及总卡数。' },
      { id: 'capacityBuffer', label: '容量余量', unit: '倍', affects: ['prefillNeed','throughputNeed','cardCount','nodes','hardware','energy','localCost','decision'], formula: 'Prefill / Decode 需求 × 容量余量', impact: '对吞吐需求整体放大，可能跨过整数部署组台阶。' },
      { id: 'ttftSlo', label: '首Token目标', unit: '秒', affects: ['prefillNeed','cardCount','nodes','hardware','energy','localCost','decision'], formula: 'Σ(并发 × 输入K) ÷ (首字目标 − 调度通信)', impact: '目标越严格，Prefill 峰值需求越大；长输入高并发场景常因此成为卡数主导约束。' },
      { id: 'ttftBurstShare', label: '同时预填比例', unit: '% 并发', affects: ['prefillNeed','cardCount','nodes','hardware','energy','localCost','decision'], formula: '规划并发 × 同时预填比例 = 峰值期处于 Prefill 的路数', impact: '一次请求里 Decode 占时长远高于 Prefill，同一瞬间只有部分并发在预填；比例越高配卡越多。' },
      { id: 'memoryUtilization', label: '显存利用率', unit: '%', affects: ['usableMemory','cardCount','nodes','hardware','energy','localCost','decision'], formula: '单卡显存 × 利用率 = 可用显存', impact: '利用率降低会增加每个同模型部署组的卡数。' },
      { id: 'runtimeReserve', label: '运行时余量', unit: '% 权重', affects: ['weights','cardCount','nodes','hardware','energy','localCost','decision'], formula: '权重 GB × 运行时余量', impact: '为框架、临时张量等预留显存，可能触发拓扑取整。' },
      { id: 'nodeCardCapacity', label: '单台服务器卡槽', unit: '卡 / 台', affects: ['nodes','hardware','energy','localCost','decision'], formula: '节点数 = 向上取整(总卡数 ÷ 单台卡数)', impact: '不改变总卡数，但改变服务器台数、平台件、基础功耗与整机报价。' }
    ]},
    { id: 'cost', label: '04 本地价格与运维', inputs: [
      { id: 'pricingMode', label: '本地报价口径', unit: '', affects: ['hardware','maintenance','localCost','decision'], formula: '组件模式：卡价 + 平台件 + 集成；整机模式：节点数 × 单台报价', impact: '选择进入硬件 CapEx 的报价分支，并继续影响维保、回本天数与三年 TCO。' },
      { id: 'cardPriceWan', label: '单卡价格', unit: '万元 / 卡', affects: ['hardware','localCost','decision'], formula: '总卡数 × 单卡价格', impact: '按组件报价模式直接改变硬件 CapEx。' },
      { id: 'platformPriceWan', label: '平台件', unit: '万元 / 台', affects: ['hardware','localCost','decision'], formula: '节点数 × 平台件价格', impact: '节点越多，平台件成本越高。' },
      { id: 'integrationPct', label: '网络集成', unit: '%', affects: ['hardware','localCost','decision'], formula: '(卡价 + 平台件) × (1 + 集成比例)', impact: '按比例放大组件硬件价。' },
      { id: 'nodeQuoteWan', label: '单台整机报价', unit: '万元 / 台', affects: ['hardware','localCost','decision'], formula: '节点数 × 单台全包报价', impact: '仅在整机报价模式生效。' },
      { id: 'platformPowerKw', label: '平台基础功耗', unit: 'kW / 台', affects: ['energy','localCost','decision'], formula: '节点数 × 平台基础功耗', impact: '与卡 TDP 一起形成活跃功耗。' },
      { id: 'idlePowerRatio', label: '非业务时段功耗', unit: '%', affects: ['energy','localCost','decision'], formula: '活跃功耗 × 空闲比例 × 空闲小时', impact: '影响每天剩余 12 小时及非使用日电耗。' },
      { id: 'pue', label: '机房 PUE', unit: '系数', affects: ['energy','localCost','decision'], formula: 'IT 电耗 × PUE = 设施总电耗', impact: '按比例放大制冷与供配电后的电费。' },
      { id: 'electricityRate', label: '电价', unit: '¥ / kWh', affects: ['energy','localCost','decision'], formula: '设施总电耗 × 电价', impact: '只改变年电费。' },
      { id: 'maintenancePct', label: '年维保', unit: '% 硬件价', affects: ['maintenance','localCost','decision'], formula: '硬件 CapEx × 年维保比例', impact: '只按硬件价计提，不含一次性软件费。' },
      { id: 'softwareOnceWan', label: '一次性软件费', unit: '万元', affects: ['localCost','decision'], formula: '硬件 CapEx + 一次性软件费', impact: '增加初始投入和回本天数。' },
      { id: 'softwareYearWan', label: '年软件订阅', unit: '万元 / 年', affects: ['localCost','decision'], formula: '年电费 + 维保 + 年订阅 + 运维', impact: '增加本地年 OpEx。' },
      { id: 'opsMonthlyWan', label: '运维人力', unit: '万元 / 月', affects: ['localCost','decision'], formula: '月度运维 × 12', impact: '通常是本地运行成本中的重要固定项。' }
    ]}
  ];

  const stages = [
    { id:'profileTokens', lane:'工作负载', label:'岗位日 Token', formula:'Σ 人数 × 请求 × Prefill / Decode' },
    { id:'concurrency', lane:'工作负载', label:'规划并发', formula:'ceil(Σ 人数 × 活跃率 × 并行任务)' },
    { id:'inputRatio', lane:'工作负载', label:'输入 / 输出比', formula:'画像输入 Token ÷ 画像输出 Token' },
    { id:'continuousLoad', lane:'工作负载', label:'12 小时 Token', formula:'并发 × tok/s × 43,200 秒' },
    { id:'prefillNeed', lane:'容量需求', label:'Prefill 需求', formula:'max(有效输入 ÷ 43,200, 并发输入 ÷ TTFT预算) × 余量' },
    { id:'throughputNeed', lane:'容量需求', label:'Decode 需求', formula:'max(日输出均值, 并发 × tok/s) × 余量' },
    { id:'contextLoad', lane:'容量需求', label:'并发上下文', formula:'Σ 并发 × (Prefill + Decode)' },
    { id:'cloudSplit', lane:'云端成本', label:'命中 / 未命中输入', formula:'输入 Token × 缓存命中率' },
    { id:'peakFactor', lane:'云端成本', label:'峰谷系数', formula:'1 + 高峰用量占比' },
    { id:'cloudCost', lane:'云端成本', label:'云端使用日成本', formula:'命中输入费 + 未命中输入费 + 输出费' },
    { id:'cloudAnnual', lane:'云端成本', label:'云端年成本', formula:'使用日成本 × 年使用天数' },
    { id:'weights', lane:'本地容量', label:'权重与运行时显存', formula:'总参数 × 权重 byte × (1 + 运行时余量)' },
    { id:'kvCache', lane:'本地容量', label:'KV Cache', formula:'KV / Token × 上下文 × KV byte' },
    { id:'usableMemory', lane:'本地容量', label:'单卡可用显存', formula:'卡显存 × 显存利用率' },
    { id:'parallelEfficiency', lane:'本地容量', label:'多卡并行效率', formula:'拓扑规模 × 高速互联修正' },
    { id:'replicaThroughput', lane:'本地容量', label:'单组吞吐', formula:'单卡吞吐 × 每组卡数 × 并行效率 × 精度倍率' },
    { id:'cardCount', lane:'本地容量', label:'总卡数', formula:'每组卡数 × max(KV, Decode, Prefill 所需组数)' },
    { id:'nodes', lane:'本地成本', label:'服务器台数', formula:'ceil(总卡数 ÷ 单台卡槽)' },
    { id:'hardware', lane:'本地成本', label:'硬件 CapEx', formula:'组件价或节点全包价' },
    { id:'energy', lane:'本地成本', label:'年电费', formula:'活跃 / 空闲电耗 × PUE × 电价' },
    { id:'maintenance', lane:'本地成本', label:'年维保', formula:'硬件 CapEx × 维保比例' },
    { id:'localCost', lane:'本地成本', label:'本地 CapEx / OpEx', formula:'硬件 + 软件；电费 + 维保 + 订阅 + 人力' },
    { id:'decision', lane:'最终结论', label:'临界点与三年 TCO', formula:'CapEx ÷ 日节省；比较云端 / 本地三年累计' }
  ];

  return { groups, stages };
})();
