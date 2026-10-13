'use strict';
/* Pure, deterministic planning engine. All storage uses decimal GB; K = 1000.
 * No benchmark is silently reused. See CALCULATION-V3.md for applicability. */
(function (root) {
  const VERSION = '4.3.0';
  const fmt = n => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 5}).format(n) : '不可达';
  const precision = {
    fp16: {name:'FP16 / BF16 路径', bytes:2, compute:'fp16'},
    fp8: {name:'FP8 权重与矩阵', bytes:1, compute:'fp8'},
    int8: {name:'W8A8 / INT8 矩阵', bytes:1, compute:'int8'},
    int8ref: {name:'W8A8 / INT8（仅假设适配）', bytes:1, compute:'int8'},
    int4: {name:'W4A16（需框架验证）', bytes:.5, compute:'fp16'}
  };
  // Catalog lacks query-head metadata: these are editable reference assumptions,
  // NOT newly verified official specifications. Do not confuse Q heads with KV heads.
  const qHeads = {dsr1:128,dsv32:128,kimik2:64,qwen235:64,qwencoder:96,qwennext:16,glm45:96,llama4m:40,gptoss120:64,gptoss20:64,mistral31:32,qwen3b8:32};
  function modelDefaults(m) {
    const compressed = /MLA|DSA/.test(m.attentionType);
    return {totalB:m.totalParamsB,activeB:m.activeParamsB,layers:m.layers,qHeads:qHeads[m.id]||128,
      qkDim:compressed?192:m.headDim||128,vDim:128 === m.headDim || compressed?128:m.headDim||128,
      kvWidth:compressed?576:2*(m.kvHeads||8)*(m.headDim||128), attentionFraction:1,...(m.verifiedStructure||{})};
  }
  function supported(m,c) {
    if(m.catalogOnly)return [];
    const s=(m.supportedPrecisions||[]).join(' '), p=(c.precisions||[]).join(' '), f=c.computeTflops||{},routes=m.deploymentPaths?.[c.id]?.estimable||[];
    const capability=k=>!!f[k]||(c.manualCompute&&({fp16:/BF16|FP16/,fp8:/FP8/,int8:/INT8/})[k].test(p));
    return Object.keys(precision).filter(k=>!(c.blockedPrecisions||[]).includes(k)).filter(k=>k==='fp16'?capability('fp16')&&/BF16|FP16/.test(s):
      k==='fp8'?capability('fp8')&&/FP8/.test(p)&&/FP8/.test(s):
      k==='int8'?capability('int8')&&/INT8/.test(p)&&(/INT8|W8A8/.test(s)||routes.includes('int8')):
      k==='int8ref'?c.id==='a910c'&&capability('int8')&&!(/INT8|W8A8/.test(s)||routes.includes('int8')):capability('fp16')&&/INT4/.test(s));
  }
  function defaults(data) {
    const model='qwen3b8',card='a910c',m=data.models[model],c=data.cards[card];
    return {mode:'forward',model,card,precision:'fp16',inputK:8,outputK:1,concurrency:20,ttft:8,speed:30,
      servers:1,slots:8,multiNode:true,maxTP:128,mfu:.4,attentionMfu:.3,bwEff:.65,parallelLoss:.08,
      reserve:.15,scratchGB:2,weightOverhead:1.1,kvBytes:2,kvReplication:1,kvTraffic:2,
      unionGrowth:.5,stepMs:.2,transportMs:100,...modelDefaults(m),
      memoryGB:c.memoryGB,bandwidth:c.bandwidthGBs||0,matrixTF:c.computeTflops.fp16||0,attentionTF:c.computeTflops.fp16||0,
      cardWan:c.cardPriceWan,platformWan:c.platformPriceWan||10,hostW:500,tdpW:c.tdpW,
      pue:1.3,electricity:.8,powerHours:24,days:30,years:3,maintenance:.03,
      costMode:'continuous',manualDaily:1000,api:'dsFlash',apiHit:data.apiPrices.dsFlash.hit,
      apiMiss:data.apiPrices.dsFlash.miss,apiOut:data.apiPrices.dsFlash.out,apiCache:0,peakShare:.5};
  }
  // Exact discrete sum of max(a+b*s, c+d*s) across integer context positions.
  function sumRoofline(a,b,c,d,lo,hi) {
    if(hi<lo) return 0;
    const crossing=(c-a)/(b-d), cuts=[lo,hi+1];
    if(Number.isFinite(crossing)) {const cut=Math.floor(crossing)+1;if(cut>lo&&cut<=hi)cuts.push(cut);}
    cuts.sort((x,y)=>x-y);
    let total=0;
    for(let i=0;i<cuts.length-1;i++) {const l=cuts[i],h=cuts[i+1]-1,n=h-l+1,s=(l+h)/2;
      total+=n*((a+b*s>=c+d*s)?a+b*s:c+d*s);}
    return total;
  }
  // v4 adds goal selection around the unchanged v3 workload equations.
  // Omitted SLOs are genuinely inactive; they are not replaced by hidden targets.
  function calculate(s,data,options={}) {
    // The current workbench opts into one model instance. Historical callers can
    // still replay archived replicated scenarios with the legacy default.
    const singleInstance=options.singleInstance===true;
    const trace=[], errors=[],warnings=[], inputs=Object.keys(s);
    const ignored=new Set(options.ignoreTargets||[]);
    if(s.costMode==='manual')for(const key of ['apiHit','apiMiss','apiOut','apiCache','peakShare'])ignored.add(key);
    const costFields=new Set(['cardWan','platformWan','hostW','tdpW','pue','electricity','powerHours','days','years','maintenance','manualDaily','apiHit','apiMiss','apiOut','apiCache','peakShare']);
    // Audit notes describe remaining defects; they do not silently change equations.
    const auditNotes={
      context:'A01/A07：旧目录混用原生/扩展上下文和 K 单位；最大输出字段尚未校验。超限需核对具体版本，不能据此判断硬件跑不动。',
      topology:'A03：未验证 Q 头整除、框架允许的 TP，以及物理模组与逻辑 NPU 的映射。候选不是可直接执行的部署命令。',
      kvSession:'A04：复制系数没有随 TP 自动变化。常规头分片 GQA 在 TP 大于 KV 头数时会复制 KV；可能低估显存与访存。',
      usable:'A10/A12：依赖图缺少 chosenTP 到本节点的连接；workspace 为固定占位，不随输入、批量和分块变化。',
      union:'A11：Prefill 与 Decode 共用按请求数增长的专家并集；长输入内部访问更多专家没有单独建模。',
      prefillTraffic:'A11/A12：不是实际逐层 HBM 流量；临时激活、分块和专家加载仍需实测。',
      prefillTime:'A13：整阶段 Roofline 和统一 TP 折损不是逐层通信模型；没有模拟 CP、EP、分块调度或 P/D 分离。',
      decodeStep:'A05/A13：O=1 时虽然实际 Decode 为 0 步，当前仍检查末端速度；这是尚待修复的边界问题。',
      caps:'A03/A04/A14：容量边界在当前方程内复算通过，但 TP、KV 分片与稀疏结构限制会改变真实容量。',
      activeCards:singleInstance?'单实例模式：参与计算卡数属于同一个模型实例。整机采购卡位可多于参与卡数，不自动运行额外实例。':'A09：已有设备模式把可布置的所有副本都计为参与计算；少量请求时包含空闲副本。',
      dailyAPI:'A07/A15：未校验所选 API 的上下文/最大输出/阶梯价限制；12 小时用量是目标体验下的情景，不是实际账单。',
      apiPriceSource:'A16：旧方案读取会把 null 未知价格替换成默认方案价格；读取待核价 API 的方案后，请逐项重新填写单价再比较，不要直接使用回填价格。',
      localMonthly:'A15：TDP 满载功率、固定报价和维护费率为预算假设；不含网络建设、人工、资金成本等。',
      payback:'A15：交点算术已复算通过；价格、有效工作量和可部署卡数未压测时，回本不是承诺。'
    };
    const add=(id,title,deps,formula,value,unit='',note='')=>{trace.push({id,title,deps,formula,value,unit,note:[note,auditNotes[id]?'审计备注（2026-09-07）：'+auditNotes[id]:''].filter(Boolean).join(' ')});return value;};
    const m=data.models[s.model], c=data.cards[s.card], p=precision[s.precision];
    if(!m||!c||!p)return {ok:false,errors:['模型、芯片或精度标识无效'],trace,warnings};
    if(m.catalogOnly)return {ok:false,errors:['此模型已收录到数据页，但当前架构/精度或公开参数不足，不能据此推算本地卡数。请在云端 API 对比中选用，或选择已建模的本地模型。'],trace,warnings};
    const bounds={inputK:[.001,10000],outputK:[.001,10000],concurrency:[1,100000],ttft:[.001,36000],speed:[.001,100000],servers:[1,10000],slots:[1,8],maxTP:[1,128],mfu:[.001,1],attentionMfu:[.001,1],bwEff:[.001,1],parallelLoss:[0,.4],reserve:[0,.9],scratchGB:[0,10000],weightOverhead:[1,3],kvBytes:[.5,4],kvReplication:[1,128],kvTraffic:[1,1000],unionGrowth:[0,1],stepMs:[0,10000],transportMs:[0,100000],totalB:[.001,10000],activeB:[.001,10000],layers:[1,1000],qHeads:[1,1000],qkDim:[1,4096],vDim:[1,4096],kvWidth:[1,1000000],attentionFraction:[.0001,1],memoryGB:[.001,10000],bandwidth:[.001,100000],matrixTF:[.001,100000],attentionTF:[.001,100000],cardWan:[.0001,10000],platformWan:[0,100000],hostW:[0,100000],tdpW:[0,100000],pue:[1,5],electricity:[0,100],powerHours:[0,24],days:[1,366],years:[.01,100],maintenance:[0,1],manualDaily:[0,1e10],apiHit:[0,1e7],apiMiss:[0,1e7],apiOut:[0,1e7],apiCache:[0,1],peakShare:[0,1]};
    for(const [k,[min,max]] of Object.entries(bounds))if(!ignored.has(k)&&!(options.performanceOnly&&costFields.has(k))&&(typeof s[k]!=='number'||!Number.isFinite(s[k])||s[k]<min||s[k]>max))errors.push(`${k} 需在 ${min}～${max} 内；未知硬件参数或报价需先补齐`);
    for(const k of ['concurrency','servers','slots','maxTP','layers','qHeads','qkDim','vDim','kvWidth','days'])if(!(options.performanceOnly&&costFields.has(k))&&!Number.isInteger(s[k]))errors.push(`${k} 必须为整数`);
    if(![1,2,4,8].includes(s.slots))errors.push('每台卡位仅支持 1 / 2 / 4 / 8');
    if(!['forward','reverse'].includes(s.mode)||(!options.performanceOnly&&!['manual','continuous'].includes(s.costMode)))errors.push('计算模式无效');
    if(!options.performanceOnly&&s.costMode==='continuous'&&!data.apiPrices[s.api])errors.push('API 方案无效');
    if(!options.performanceOnly&&s.costMode==='continuous'&&data.apiPrices[s.api]?.validUntil) {
      if((options.now??Date.now())>=Date.parse(data.apiPrices[s.api].validUntil))errors.push('所选 API 促销已到期，请切换常规价或手动每日账单，不再按过期促销推算。');
      else warnings.push('当前为限时促销价；月费/多年成本是按此价格固定外推的情景，不代表折扣持续。长期预算请选择常规价。');
    }
    if(!options.performanceOnly&&s.costMode==='continuous'&&![s.apiHit,s.apiMiss,s.apiOut].every(Number.isFinite))errors.push('API 单价未核实或未填写：请填写人民币输入、输出、缓存命中价，或切换每日账单。未核实不等于免费。');
    if(c.manualCompute&&(!s.matrixTF||!s.attentionTF))errors.push('此卡支持所选格式，但稠密峰值尚未核实。请展开“硬件效率与运行假设”，填写对应矩阵峰值与 FP16/BF16 峰值；不要填写 AI TOPS。');
    if(!supported(m,c).includes(s.precision))errors.push('当前模型与芯片没有共同的可估算精度路径');
    if(s.activeB>s.totalB)errors.push('激活参数不能大于总参数');
    if(!options.performanceOnly&&s.days>31)errors.push('每月计费天数不能超过 31 天');
    if(!options.performanceOnly&&s.costMode==='continuous'&&s.powerHours<12)errors.push('12 小时连续对比中，本地每日计电时长不能低于 12 小时');
    if(options.responseSlo!==undefined&&(!Number.isFinite(options.responseSlo)||options.responseSlo<=0))errors.push('完整响应限时需大于 0 秒');
    const I=Math.round(s.inputK*1000),O=Math.round(s.outputK*1000),S=I+O;
    if(S>m.contextK*1000)errors.push(`单路输入 + 输出超过目录原生 ${m.contextK}K 上限；扩展上下文需单独验证`);
    if(errors.length)return {ok:false,errors,warnings,trace,inputs};
    warnings.push('理论规划值，不是实测承诺。算子、框架、通信、调度及硬件目录均需目标配置压测。');
    warnings.push('全链路审计发现尚未修复的边界与建模问题，已在相关计算步骤逐项备注；详见 CALCULATION-AUDIT-20260907.md。不能把本轮测试通过当作采购验证。');
    if(s.card==='a910c')warnings.push('910C 支持 W8A8 / INT8 矩阵路径，不支持 FP8。权重格式、Attention 与 KV 缓存精度是三个独立口径。');
    if(s.precision==='int8ref')warnings.push('当前选择“W8A8 仅假设适配”：硬件具备 INT8 能力，但本模型的精确量化权重/框架路径未核实。下面只估算假设适配后的资源，不保证能启动、精度质量或性能。');
    if(m.deploymentPaths?.[c.id]?.note)warnings.push(m.deploymentPaths[c.id].note);
    warnings.push(m.verifiedStructure?'Q 头数与 QK/V 维度已按官方配置填写；KV 简化不含额外索引/线性状态，仍非实际内核性能。':'Q 头数、QK/V 维度为可编辑参考假设，未在本次联网核验；不是 KV 头数。');
    if(/DSA|Hybrid/.test(m.attentionType)||/gptoss|llama4/.test(m.id))warnings.push('当前使用全注意力参考情景；稀疏、混合、滑窗结构未建专用内核模型，不应据此直接采购。');
    if(s.attentionFraction!==1)warnings.push('Attention 比例由用户指定，仅缩放注意力运算量，不自动缩减 KV 或证明真实加速。');
    if(s.precision!=='fp16')warnings.push('量化权重、激活与框架内核支持尚需验证；Attention 仍按 FP16/BF16 路径，不套用 INT8/FP8 峰值。');
    if(s.multiNode)warnings.push('已启用跨节点 TP：通信仅用效率衰减近似，必须验证互连与软件栈。');
    if(!options.performanceOnly)warnings.push('API 采用所填人民币单价；目录核验日期、国际/国内站与折扣见价格依据。非实时同步，未含额外工具与思考 Token，跨模型不保证质量/体验等价。');
    if(m.note)warnings.push(m.note);
    add('input','单路最大输入',['inputK'],`${fmt(s.inputK)} × 1000，四舍五入到 Token`,I,'Token');
    add('output','单路最大输出',['outputK'],`${fmt(s.outputK)} × 1000，四舍五入到 Token`,O,'Token','首 Token 由 Prefill 产生，其余 O−1 个由 Decode 产生。');
    add('context','单路预留上下文',['input','output','model'],`${I} + ${O}`,S,'Token','不叠加其他用户、全天请求或历史轮数；输入需已经包含本次携带的历史。');
    add('batch','首批同时请求',['concurrency'],`${s.concurrency}，全部同时到达，无 25% 突发折扣`,s.concurrency,'路');
    if(s.card==='a910c')add('precisionPath','910C 精度与适配边界',['card','model','precision','matrixTF','attentionTF','kvBytes'],`权重 ${p.bytes} bytes；矩阵 ${p.compute}，${s.matrixTF} TOP/s 或 TFLOP/s；Attention ${s.attentionTF} TFLOP/s；KV ${s.kvBytes} bytes`,s.precision==='int8ref'?'仅假设适配':s.precision==='int8'?(m.deploymentPaths?.a910c?.estimable?.includes('int8')?'有模型部署文档；性能未验证':'目录量化路径；框架仍需核实'):'按所选精度估算','','A02：910C 的 W8A8 不再因原始权重是 FP8 而完全消失；“仅假设适配”不是已验证路径。FP8 仍禁止。');
    const weight=add('weight','完整模型权重',['totalB','precision','weightOverhead'],`${s.totalB} × 10⁹ × ${p.bytes} × ${s.weightOverhead} ÷ 10⁹`,s.totalB*p.bytes*s.weightOverhead,'GB','MoE 全部权重必须存储；1 GB = 10⁹ bytes。');
    const activeWeight=add('activeWeight','单路激活权重参考',['activeB','precision','weightOverhead'],`${s.activeB} × ${p.bytes} × ${s.weightOverhead}`,s.activeB*p.bytes*s.weightOverhead,'GB');
    const kv=add('kv','每 Token 的 KV 字节',['layers','kvWidth','kvBytes'],`${s.layers} × ${s.kvWidth} × ${s.kvBytes}`,s.layers*s.kvWidth*s.kvBytes,'bytes','GQA 宽度 = 2×KV头×headDim；MLA 参考宽度 576。不使用未经证实的 0.1 压缩系数。');
    const kvSession=add('kvSession','单路峰值 KV',['kv','context','kvReplication'],`${kv} × ${S} × ${s.kvReplication} ÷ 10⁹`,kv*S*s.kvReplication/1e9,'GB','复制系数显式设置；不假定任意 TP 都能完美分片。');
    const pairs=add('pairs','Prefill 因果注意力对数',['input'],`${I} × (${I} + 1) ÷ 2`,I*(I+1)/2,'Token 对','首批冷启动；无本地前缀缓存命中折扣。');
    const a=add('attentionCoef','每 Token 对的 Attention 运算',['layers','qHeads','qkDim','vDim','attentionFraction'],`2 × ${s.layers} × ${s.qHeads} × (${s.qkDim} + ${s.vDim}) × ${s.attentionFraction}`,2*s.layers*s.qHeads*(s.qkDim+s.vDim)*s.attentionFraction,'FLOP/对','QKᵀ 与 AV 两部分；乘加按 2 FLOP。');
    const pm=add('prefillMatrix','单路 Prefill 参数运算',['activeB','input'],`2 × ${s.activeB} × 10⁹ × ${I}`,2*s.activeB*1e9*I,'FLOP','2P 近似投影/MLP 成本，不含下方 QKᵀ、AV；路由、归一化等未逐算子建模。');
    const pa=add('prefillAttention','单路 Prefill Attention',['attentionCoef','pairs'],`${a} × ${pairs}`,a*pairs,'FLOP');
    const dm=add('decodeMatrix','每路每步参数运算',['activeB'],`2 × ${s.activeB} × 10⁹`,2*s.activeB*1e9,'FLOP');
    add('decodeAttention','单路末端 Attention',['attentionCoef','context'],`${a} × ${S}`,a*S,'FLOP/步','按预留上限 S 做末端速度保守检查；实际第 j 步采用 I+j。');
    const efficiencies=tp=>Math.pow(1-s.parallelLoss,Math.log2(tp));
    function work(tp,B) {
      const eta=efficiencies(tp), matrix=tp*s.matrixTF*1e12*s.mfu*eta, attention=tp*s.attentionTF*1e12*s.attentionMfu*eta, bw=tp*s.bandwidth*1e9*s.bwEff*eta;
      const union=Math.min(weight,activeWeight*(1+(B-1)*s.unionGrowth));
      const usable=tp*(s.memoryGB*(1-s.reserve)-s.scratchGB), used=weight+B*kvSession;
      const pCompute=B*(pm/matrix+pa/attention), pTraffic=union*1e9+B*I*kv*s.kvReplication*s.kvTraffic,
        pMemory=pTraffic/bw, prefill=Math.max(pCompute,pMemory)+s.stepMs/1000,ttft=s.transportMs/1000+prefill;
      const ca=B*dm/matrix,cb=B*a/attention,ma=union*1e9/bw,mb=B*kv*s.kvReplication/bw, overhead=s.stepMs/1000;
      const startStep=Math.max(ca+cb*(I+1),ma+mb*(I+1))+overhead,endCompute=ca+cb*S,endMemory=ma+mb*S,endStep=Math.max(endCompute,endMemory)+overhead;
      const decode=sumRoofline(ca,cb,ma,mb,I+1,I+O-1)+(O-1)*overhead;
      return {tp,B,eta,matrix,attention,bw,union,usable,used,pCompute,pTraffic,pMemory,prefill,ttft,ca,cb,ma,mb,startStep,endCompute,endMemory,endStep,speed:1/endStep,decode,response:ttft+decode,
        fits:used<=usable,ttftOK:ignored.has('ttft')||ttft<=s.ttft,speedOK:ignored.has('speed')||1/endStep>=s.speed};
    }
    function capacity(tp,kind,limit) {
      if((kind==='ttft'&&ignored.has('ttft'))||(kind==='decode'&&ignored.has('speed')))return limit;
      const pass=B=>{const w=work(tp,B);return kind==='kv'?w.fits:kind==='ttft'?w.ttftOK:w.speedOK;};
      let lo=0,hi=limit;
      while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(pass(mid))lo=mid;else hi=mid-1;}return lo;
    }
    const tps=singleInstance&&s.mode==='reverse'
      ? (s.multiNode||s.servers===1?[s.servers*s.slots]:[])
      : [1,2,4,8,16,32,64,128].filter(tp=>(s.multiNode?tp<=s.maxTP:tp<=s.slots)&&(s.mode!=='reverse'||tp<=s.servers*s.slots));
    const limit=s.mode==='forward'?s.concurrency:100000;
    const candidates=tps.map(tp=>{
      const kvCap=capacity(tp,'kv',limit),ttftCap=capacity(tp,'ttft',limit),decodeCap=capacity(tp,'decode',limit),bcap=Math.min(kvCap,ttftCap,decodeCap);
      const perServer=tp<=s.slots?Math.floor(s.slots/tp):0;
      const groups=singleInstance?1:s.mode==='forward'?(bcap?Math.ceil(s.concurrency/bcap):0):tp<=s.slots?s.servers*perServer:Math.floor(s.servers/(tp/s.slots));
      const servers=singleInstance?(s.mode==='forward'?Math.ceil(tp/s.slots):s.servers):s.mode==='forward'?(groups?(tp<=s.slots?Math.ceil(groups/perServer):groups*(tp/s.slots)):0):s.servers;
      const B=groups?Math.ceil(s.concurrency/groups):1,w=work(tp,B);
      const proof={};
      for(const [kind,cap] of Object.entries({kv:kvCap,ttft:ttftCap,decode:decodeCap})) {
        const read=B=>{const x=work(tp,B);return kind==='kv'?x.used:kind==='ttft'?x.ttft:x.speed;};
        const inactive=(kind==='ttft'&&ignored.has('ttft'))||(kind==='decode'&&ignored.has('speed'));
        proof[kind]={cap,at:cap>0?read(cap):null,next:cap<limit?read(cap+1):null,limit:inactive?null:kind==='kv'?w.usable:kind==='ttft'?s.ttft:s.speed,capped:cap===limit,inactive};
      }
      const responseOK=options.responseSlo===undefined||w.response<=options.responseSlo;
      return {tp,kvCap,ttftCap,decodeCap,bcap,groups,servers,B,capacity:bcap*groups,activeCards:tp*groups,purchasedCards:servers*s.slots,w,single:work(tp,1),proof,responseOK,valid:groups>0&&bcap>0&&w.fits&&w.ttftOK&&w.speedOK&&responseOK};
    });
    // Loading a model is not the same question as meeting a latency target.
    const perCard=s.memoryGB*(1-s.reserve)-s.scratchGB;
    const minimumWeightCards=perCard>0?Math.ceil(weight/perCard):null;
    const minimumRequestCards=perCard>0?Math.ceil((weight+kvSession)/perCard):null;
    const loading=candidates.filter(q=>q.single.usable>=weight);
    const runnable=candidates.filter(q=>q.single.fits);
    const referenceOnly=s.precision==='int8ref'||/DSA|Hybrid/.test(m.attentionType)||/gptoss|llama4/.test(m.id);
    const performanceEvidence={referenceOnly,reason:referenceOnly?'此架构尚未建立匹配的稀疏/混合 Attention 性能模型；当前为完整 Attention 参考情景。未模拟 EP、CP、P/D 分离及 MTP，不能据此断言实际跑不动或形成采购保证。':'显式假设下的理论估算，仍需同模型、精度、长度和框架压测。'};
    if(s.precision==='int8ref')performanceEvidence.reason='910C 具备 W8A8 硬件能力，但本模型的纯 W8A8 适配路径尚未核实。当前是假设适配后的全 Attention 资源估算；不是已验证部署或性能。';
    const diagnostics={minimumWeightCards,minimumRequestCards,perCard,weightFits:loading.length>0,requestFits:runnable.length>0,loadingTP:loading[0]?.tp||null,requestTP:runnable[0]?.tp||null,maxTP:tps.at(-1)||0,crossNodeAllowed:s.multiNode,availableCards:s.mode==='reverse'?s.servers*s.slots:null,
      singleInstance,
      fastestSingleTTFT:runnable.length?Math.min(...runnable.map(q=>q.single.ttft)):null,
      fastestSingleSpeed:runnable.length?Math.max(...runnable.map(q=>q.single.speed)):null,
      blockers:candidates.map(q=>({tp:q.tp,weightFits:q.single.usable>=weight,oneRequestFits:q.single.fits,ttftOK:q.single.ttftOK,speedOK:q.single.speedOK,actualBatchFits:q.w.fits,actualTTFTOK:q.w.ttftOK,actualSpeedOK:q.w.speedOK,responseOK:q.responseOK}))};
    add('weightCardFloor','仅权重的显存卡数下限',['weight','memoryGB','reserve','scratchGB'],perCard>0?`ceil(${fmt(weight)} ÷ [${s.memoryGB} × (1 − ${s.reserve}) − ${s.scratchGB}])`:'扣除预留后无可用显存',minimumWeightCards??'不可装载','张','只看显存容量；没有包含 KV、拓扑装箱或时延要求，不是最终采购卡数。');
    add('requestCardFloor','权重加一路完整 KV 的卡数下限',['weight','kvSession','memoryGB','reserve','scratchGB'],perCard>0?`ceil((${fmt(weight)} + ${fmt(kvSession)}) ÷ ${fmt(perCard)})`:'扣除预留后无可用显存',minimumRequestCards??'不可装载','张','仅一路请求；实际拓扑与并发还需下面逐候选验证。');
    add('loadingCheck','当前搜索范围内的模型装载检查',['weightCardFloor','requestCardFloor','slots','multiNode','maxTP','mode',...(s.mode==='reverse'?['servers']:[])],`搜索 TP = ${tps.join(' / ')}；仅权重可装载：${loading.length>0?'是':'否'}；一路完整 KV 可容纳：${runnable.length>0?'是':'否'}`,loading.length>0?'模型可装载':'当前范围装不下','','模型可装载不等于满足 TTFT、Decode、并发或真实框架内核要求。');
    const valid=candidates.filter(x=>x.valid);
    valid.sort(options.objective==='speed'?(x,y)=>y.w.speed-x.w.speed||x.w.ttft-y.w.ttft:
      options.objective==='ttft'?(x,y)=>x.w.ttft-y.w.ttft||y.w.speed-x.w.speed:
      s.mode==='forward'?(x,y)=>x.purchasedCards-y.purchasedCards||x.activeCards-y.activeCards:(x,y)=>y.capacity-x.capacity||x.w.response-y.w.response);
    // A failing reverse work point remains inspectable, but never receives a success badge.
    const chosen=valid[0]||(s.mode==='reverse'?candidates.filter(x=>x.groups>0).sort((x,y)=>y.capacity-x.capacity)[0]:null);
    add('topology',singleInstance?'单实例物理卡规模':'枚举可用 TP',['slots','multiNode','maxTP','mode',...(singleInstance&&s.mode==='reverse'?['servers']:[])],`${singleInstance?'单实例物理卡规模':'TP'} ∈ {${tps.join(', ')}}；搜索整数批量 0…${limit}`,tps.join(' / '),singleInstance?'卡/实例':'卡/副本',singleInstance?'仅部署一个模型实例，不自动增加副本。已有设备模式按全部所填设备联合估算，maxTP仅限制正向搜索。这里的物理卡规模不是可直接复制到框架的逻辑TP参数，互连/分片仍需验证。':'每个候选分别检查显存、TTFT、末端速度；不允许把一条请求拆给多个副本。');
    if(!chosen) {warnings.push('当前搜索范围和参考方程下未找到满足全部目标的拓扑；请分别查看模型装载、KV 和时延诊断，不代表设备无法运行该模型。');return {ok:true,feasible:false,errors,warnings,trace,inputs,candidates,I,O,S,weight,kvSession,diagnostics,performanceEvidence};}
    const q=chosen,w=q.w,validPoint=q.valid;
    const bind=['显存','首 Token','末端 Decode'][[q.kvCap,q.ttftCap,q.decodeCap].indexOf(q.bcap)];
    add('chosenTP','选中每副本卡数',['topology','mode',...(s.mode==='reverse'?['servers']:[]),'batch','weight','activeWeight','kvSession','prefillMatrix','prefillAttention','decodeMatrix','decodeAttention','memoryGB','reserve','scratchGB','matrixTF','attentionTF','mfu','attentionMfu','bandwidth','bwEff','parallelLoss','kv','input','output','kvReplication','kvTraffic','unionGrowth','stepMs','transportMs',...['ttft','speed'].filter(k=>!ignored.has(k)),...(options.responseSlo!==undefined?['responseSlo']:[])],`对 ${candidates.length} 个 TP 候选分别搜索显存/体验边界；选中 TP = ${q.tp}`,q.tp,'卡/副本',options.objective==='speed'?'在可部署候选中取末端速度最高者。':options.objective==='ttft'?'在可部署候选中取首 Token 延迟最短者。':s.mode==='forward'?'满足约束后优先最少整机卡位，再优先最少运行卡。':'满足当前条件后优先最大可承接并发。各 TP 的边界与下一路检查见候选表。');
    add('efficiency','组内并行效率',['chosenTP','parallelLoss'],`(1 − ${s.parallelLoss}) ^ log₂(${q.tp})`,w.eta,'比例','统一规划折损，不套用 910C 的跨模型“实测效率=1”。');
    add('matrixRate','组内有效矩阵算力',['matrixTF','mfu','efficiency'],`${q.tp} × ${s.matrixTF} × 10¹² × ${s.mfu} × ${fmt(w.eta)}`,w.matrix,'FLOP/s');
    add('attentionRate','组内有效 Attention 算力',['attentionTF','attentionMfu','efficiency'],`${q.tp} × ${s.attentionTF} × 10¹² × ${s.attentionMfu} × ${fmt(w.eta)}`,w.attention,'FLOP/s','独立半精度运算路径。');
    add('bandwidthRate','组内有效显存带宽',['bandwidth','bwEff','efficiency'],`${q.tp} × ${s.bandwidth} × 10⁹ × ${s.bwEff} × ${fmt(w.eta)}`,w.bw,'bytes/s');
    add('usable','组内可用于权重与 KV 的显存',['memoryGB','reserve','scratchGB','topology'],`${q.tp} × (${s.memoryGB} × (1 − ${s.reserve}) − ${s.scratchGB})`,w.usable,'GB','固定 workspace 每卡扣除；临时激活峰值需压测校准。');
    add('caps','每副本整数容量',['usable','kvSession','weight','activeWeight','prefillMatrix','prefillAttention','decodeMatrix','decodeAttention','kv','input','kvReplication','matrixRate','attentionRate','bandwidthRate','ttft','speed','unionGrowth','stepMs','transportMs','kvTraffic'].filter(k=>!ignored.has(k)),`min(显存 ${q.kvCap}, TTFT ${ignored.has('ttft')?'不设目标':q.ttftCap}, Decode ${ignored.has('speed')?'不设目标':q.decodeCap})`,q.bcap,'路',`逐候选二分搜索相同 work(TP,B)。搜索上限命中表示“至少”；未设置的 SLO 不限制批量。`);
    add('groups',singleInstance?'模型实例数':'副本数',singleInstance?[]:['caps','batch','mode','servers','slots'],singleInstance?'按用户选择固定一个模型实例':s.mode==='forward'?`ceil(${s.concurrency} ÷ ${q.bcap})`:`按 ${s.servers} 台 × ${s.slots} 卡装入 ${q.tp} 卡副本（不跨副本共享请求）`,q.groups,'组');
    add('groupBatch','最繁忙副本真实批量',['groups','batch'],`ceil(${s.concurrency} ÷ ${q.groups})`,q.B,'路','按实际工作点重新计算，不能拿最大并发吞吐除以目标并发。其他副本可较少或空闲。');
    add('union','批内读取的权重并集',['weight','activeWeight','unionGrowth','groupBatch'],`min(${weight}, ${activeWeight} × [1 + (${q.B} − 1) × ${s.unionGrowth}])`,w.union,'GB','MoE 专家并集增长是显式假设，不把所有并发永远视作同一批专家。');
    add('used','峰值模型 + KV 显存',['weight','groupBatch','kvSession'],`${weight} + ${q.B} × ${kvSession}`,w.used,'GB');
    add('prefillComputeTime','整组 Prefill 计算时间',['groupBatch','prefillMatrix','prefillAttention','matrixRate','attentionRate'],`${q.B} × (${pm} ÷ ${w.matrix} + ${pa} ÷ ${w.attention})`,w.pCompute,'s','矩阵与 Attention 顺序相加；不是各自独占整卡同时计算。');
    add('prefillTraffic','整组 Prefill 访存量',['union','groupBatch','input','kv','kvReplication','kvTraffic'],`${w.union} × 10⁹ + ${q.B} × ${I} × ${kv} × ${s.kvReplication} × ${s.kvTraffic}`,w.pTraffic,'bytes','KV 读写/分块重读倍数需实测；不是精确 FlashAttention HBM 流量模型。');
    add('prefillMemoryTime','整组 Prefill 访存时间',['prefillTraffic','bandwidthRate'],`${w.pTraffic} ÷ ${w.bw}`,w.pMemory,'s');
    add('prefillTime','整组 Prefill 阶段',['prefillComputeTime','prefillMemoryTime','stepMs'],`max(${fmt(w.pCompute)}, ${fmt(w.pMemory)}) + ${s.stepMs} / 1000`,w.prefill,'s','Roofline 近似计算/访存重叠；同步整批处理，不虚构排队百分位。');
    add('ttftResult','最后一路首 Token 延迟',['prefillTime','transportMs'],`${fmt(w.prefill)} + ${s.transportMs} / 1000`,w.ttft,'s','首批整组同步 Prefill，无后续请求排队；不包括客户端渲染。不声称 P95。');
    add('decodeComputeTime','末端每步计算时间',['groupBatch','decodeMatrix','decodeAttention','matrixRate','attentionRate'],`${q.B} × (${dm} ÷ ${w.matrix} + ${a*S} ÷ ${w.attention})`,w.endCompute,'s/步');
    add('decodeMemoryTime','末端每步访存时间',['union','groupBatch','kv','context','kvReplication','bandwidthRate'],`(${w.union} × 10⁹ + ${q.B} × ${kv} × ${S} × ${s.kvReplication}) ÷ ${w.bw}`,w.endMemory,'s/步','每步读取批内权重并集与各路 KV；未单列激活读写及反量化流量。');
    add('decodeStep','末端每步时间',['decodeComputeTime','decodeMemoryTime','stepMs'],`max(${fmt(w.endCompute)}, ${fmt(w.endMemory)}) + ${s.stepMs}/1000`,w.endStep,'s/Token/路');
    add('decodeSpeed','末端单路速度',['decodeStep'],`1 ÷ ${fmt(w.endStep)}`,w.speed,'Token/s/路','这是每路速度，不是整卡聚合吞吐。');
    add('decodeDuration','全部剩余输出耗时',['input','output','groupBatch','decodeMatrix','attentionCoef','union','kv','kvReplication','matrixRate','attentionRate','bandwidthRate','stepMs'],`Σ(j=1…${O-1}) {max(${w.ca} + ${w.cb}×(${I}+j), ${w.ma} + ${w.mb}×(${I}+j)) + ${s.stepMs}/1000}`,w.decode,'s','对两个线性时间函数的交点分段，用等差数列精确求和；不是用固定初始速度乘输出。');
    add('response','完整响应耗时',['ttftResult','decodeDuration'],`${fmt(w.ttft)} + ${fmt(w.decode)}`,w.response,'s');
    add('prefillThroughput','最繁忙副本 Prefill 吞吐',['groupBatch','input','prefillTime'],`${q.B} × ${I} ÷ ${fmt(w.prefill)}`,q.B*I/w.prefill,'Token/s','这是整组读入速度，不是单路 Decode 速度。');
    add('activeCards','参与计算卡数',['groups','topology'],`${q.groups} × ${q.tp}`,q.activeCards,'张');
    add('serverCount','采购/已有服务器数',['groups','topology','slots','mode','servers'],s.mode==='reverse'?`已有 ${s.servers} 台`:q.tp<=s.slots?`ceil(${q.groups} ÷ floor(${s.slots} ÷ ${q.tp}))`:`${q.groups} × (${q.tp} ÷ ${s.slots})`,q.servers,'台');
    add('purchasedCards','整机卡位数',['serverCount','slots'],`${q.servers} × ${s.slots}`,q.purchasedCards,'张','采用整机满配报价；空余卡位也计入采购与功率假设。');
    if(options.performanceOnly) {
      if(options.responseSlo!==undefined)add('responseCheck','完整响应限时检查',['response','responseSlo'],`${fmt(w.response)} ≤ ${fmt(options.responseSlo)}`,w.response<=options.responseSlo?'满足':'不满足','','输入 Prefill、首 Token 与后续 Decode 全部计入限时。');
      return {ok:true,feasible:validPoint,errors,warnings,trace,inputs,candidates,chosen:q,I,O,S,weight,kvSession,bind,cost:null,version:VERSION,diagnostics,performanceEvidence};
    }
    const capex=add('capex','硬件采购额',['purchasedCards','cardWan','serverCount','platformWan'],`(${q.purchasedCards} × ${s.cardWan} + ${q.servers} × ${s.platformWan}) × 10000`,(q.purchasedCards*s.cardWan+q.servers*s.platformWan)*10000,'元','平台报价不含卡；不重复计算整机报价。未含网络建设、税差及人工。');
    const power=add('power','设施侧规划功率',['purchasedCards','tdpW','serverCount','hostW','pue'],`(${q.purchasedCards} × ${s.tdpW} + ${q.servers} × ${s.hostW}) ÷ 1000 × ${s.pue}`,(q.purchasedCards*s.tdpW+q.servers*s.hostW)/1000*s.pue,'kW','TDP 满载参考，不是实际电表读数；即使部分副本闲置也按满配估算。');
    const energy=add('energy','每月电费',['power','powerHours','days','electricity'],`${power} × ${s.powerHours} × ${s.days} × ${s.electricity}`,power*s.powerHours*s.days*s.electricity,'元/月');
    const maintenance=add('maintenanceCost','每月维护准备金',['capex','maintenance'],`${capex} × ${s.maintenance} ÷ 12`,capex*s.maintenance/12,'元/月');
    const depreciation=add('depreciation','每月硬件摊销',['capex','years'],`${capex} ÷ (${s.years} × 12)`,capex/(s.years*12),'元/月');
    const localMonthly=add('localMonthly','本地月度摊销总成本',['energy','maintenanceCost','depreciation'],`${energy} + ${maintenance} + ${depreciation}`,energy+maintenance+depreciation,'元/月');
    const api=data.apiPrices[s.api]||{}, manual=s.costMode==='manual', factor=!manual&&api.peakPricing?1+s.peakShare:1;
    add('apiPriceSource','API 目录与换算依据',['api','apiHit','apiMiss','apiOut','costMode'],manual?'手动每日账单，不使用 Token 刊例':api.native?`美元命中/输入/输出 ${api.native.hit}/${api.native.miss}/${api.native.out} × 预算汇率 ${api.fx}；最终以所填人民币值为准`:'目录为人民币或未核实；最终以所填人民币值为准',manual?'手动账单':api.name||'自填单价','',`${api.source||''}；核验 ${api.updatedAt||api.checkedAt||'未标注'}；${api.note||''}`);
    add('apiFactor','API 峰谷加权',['apiPriceSource','api','peakShare'],!manual&&api.peakPricing?`1 + ${s.peakShare}（峰时价格为基价 2 倍）`:'无生效峰谷倍率，取 1',factor,'倍','手动账单模式不参与费用结果。');
    const inPrice=add('apiInputPrice','API 有效输入单价',['apiHit','apiMiss','apiCache','apiFactor'],manual?'手动账单模式：不使用':`(${s.apiHit} × ${s.apiCache} + ${s.apiMiss} × (1 − ${s.apiCache})) × ${factor}`,manual?'不参与':(s.apiHit*s.apiCache+s.apiMiss*(1-s.apiCache))*factor,'元/百万 Token','云端缓存命中率独立于本地首批冷启动。');
    const outPrice=add('apiOutputPrice','API 有效输出单价',['apiOut','apiFactor'],manual?'手动账单模式：不使用':`${s.apiOut} × ${factor}`,manual?'不参与':s.apiOut*factor,'元/百万 Token');
    const cycle=add('targetCycle','12 小时方案的目标单轮周期',['ttft','output','speed'],`${s.ttft} + (${O} − 1) ÷ ${s.speed}`,s.ttft+(O-1)/s.speed,'s','按目标体验闭环立即发起下一轮；双方用同一工作量，不因换卡而改变 API 用量。不含思考 Token。');
    const rounds=add('dailyRounds','12 小时持续使用请求量',['batch','targetCycle'],`${s.concurrency} × 12 × 3600 ÷ ${cycle}`,s.concurrency*43200/cycle,'次/日','稳态等效请求数可为小数；最大输入/输出用于每次，偏高负载情景，不代表真实账单。');
    const dailyIn=add('dailyInput','12 小时每日输入量',['dailyRounds','input'],`${rounds} × ${I}`,rounds*I,'Token/日');
    const dailyOut=add('dailyOutput','12 小时每日输出量',['dailyRounds','output'],`${rounds} × ${O}`,rounds*O,'Token/日');
    const dailyAPI=add('dailyAPI','生效的每日 API 费用',s.costMode==='manual'?['costMode','manualDaily']:['costMode','dailyInput','dailyOutput','apiInputPrice','apiOutputPrice'],s.costMode==='manual'?`手动账单 ${s.manualDaily}`:`(${dailyIn} × ${inPrice} + ${dailyOut} × ${outPrice}) ÷ 10⁶`,s.costMode==='manual'?s.manualDaily:(dailyIn*inPrice+dailyOut*outPrice)/1e6,'元/日');
    const apiMonthly=add('apiMonthly','每月 API 费用',['dailyAPI','days'],`${dailyAPI} × ${s.days}`,dailyAPI*s.days,'元/月');
    const saving=add('saving','扣除本地运营费后的月差额',['apiMonthly','energy','maintenanceCost'],`${apiMonthly} − ${energy} − ${maintenance}`,apiMonthly-energy-maintenance,'元/月');
    const payback=add('payback','现金回本月份',['capex','saving'],saving>0?`${capex} ÷ ${saving}`:'月差额 ≤ 0，没有有限回本期',saving>0?capex/saving:null,'月','回本不再扣一次折旧；已有设备场景仅作重购基准。不计资金成本。');
    const localTCO=add('localTCO','选定年限本地 TCO',['capex','energy','maintenanceCost','years'],`${capex} + (${energy} + ${maintenance}) × ${s.years} × 12`,capex+(energy+maintenance)*s.years*12,'元');
    const apiTCO=add('apiTCO','同年限 API 支出',['apiMonthly','years'],`${apiMonthly} × ${s.years} × 12`,apiMonthly*s.years*12,'元');
    if(!validPoint)warnings.push('已有硬件不满足当前首批并发/SLO，下面成本仅为账面参考，不能标为等服务可替代。');
    return {ok:true,feasible:validPoint,errors,warnings,trace,inputs,candidates,chosen:q,I,O,S,weight,kvSession,bind,cost:{capex,power,energy,maintenance,depreciation,localMonthly,apiMonthly,payback,localTCO,apiTCO},version:VERSION,diagnostics,performanceEvidence};
  }
  root.PlanningEngine={VERSION,precision,modelDefaults,defaults,supported,calculate,sumRoofline,fmt};
  if(typeof module!=='undefined')module.exports=root.PlanningEngine;
})(typeof window==='undefined'?globalThis:window);
