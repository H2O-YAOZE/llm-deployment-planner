'use strict';
/* Pure, deterministic planning engine. All storage uses decimal GB; K = 1000.
 * No benchmark is silently reused. See CALCULATION-V3.md for applicability. */
(function (root) {
  const VERSION = '3.0.0';
  const fmt = n => Number.isFinite(n) ? new Intl.NumberFormat('zh-CN', {maximumFractionDigits: 5}).format(n) : '不可达';
  const precision = {
    fp16: {name:'FP16 / BF16 路径', bytes:2, compute:'fp16'},
    fp8: {name:'FP8 权重与矩阵', bytes:1, compute:'fp8'},
    int8: {name:'W8A8 / INT8 矩阵', bytes:1, compute:'int8'},
    int4: {name:'W4A16（需框架验证）', bytes:.5, compute:'fp16'}
  };
  // Catalog lacks query-head metadata: these are editable reference assumptions,
  // NOT newly verified official specifications. Do not confuse Q heads with KV heads.
  const qHeads = {dsr1:128,dsv32:128,kimik2:64,qwen235:64,qwencoder:96,qwennext:16,glm45:96,llama4m:40,gptoss120:64,gptoss20:64,mistral31:32,qwen3b8:32};
  function modelDefaults(m) {
    const compressed = /MLA|DSA/.test(m.attentionType);
    return {totalB:m.totalParamsB,activeB:m.activeParamsB,layers:m.layers,qHeads:qHeads[m.id]||128,
      qkDim:compressed?192:m.headDim||128,vDim:128 === m.headDim || compressed?128:m.headDim||128,
      kvWidth:compressed?576:2*(m.kvHeads||8)*(m.headDim||128), attentionFraction:1};
  }
  function supported(m,c) {
    const s=(m.supportedPrecisions||[]).join(' '), p=(c.precisions||[]).join(' '), f=c.computeTflops||{};
    return Object.keys(precision).filter(k=>k==='fp16'?!!f.fp16&&/BF16|FP16/.test(s):
      k==='fp8'?!!f.fp8&&/FP8/.test(p)&&/FP8/.test(s):
      k==='int8'?!!f.int8&&/INT8/.test(p)&&/INT8/.test(s):!!f.fp16&&/INT4/.test(s));
  }
  function defaults(data) {
    const model='qwen3b8',card='a910c',m=data.models[model],c=data.cards[card];
    return {mode:'forward',model,card,precision:'fp16',inputK:8,outputK:1,concurrency:20,ttft:8,speed:30,
      servers:1,slots:8,multiNode:false,maxTP:64,mfu:.4,attentionMfu:.3,bwEff:.65,parallelLoss:.08,
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
  function calculate(s,data) {
    const trace=[], errors=[],warnings=[], inputs=Object.keys(s);
    const add=(id,title,deps,formula,value,unit='',note='')=>{trace.push({id,title,deps,formula,value,unit,note});return value;};
    const m=data.models[s.model], c=data.cards[s.card], p=precision[s.precision];
    if(!m||!c||!p)return {ok:false,errors:['模型、芯片或精度标识无效'],trace,warnings};
    const bounds={inputK:[.001,10000],outputK:[.001,10000],concurrency:[1,100000],ttft:[.001,36000],speed:[.001,100000],servers:[1,10000],slots:[1,8],maxTP:[1,128],mfu:[.001,1],attentionMfu:[.001,1],bwEff:[.001,1],parallelLoss:[0,.4],reserve:[0,.9],scratchGB:[0,10000],weightOverhead:[1,3],kvBytes:[.5,4],kvReplication:[1,128],kvTraffic:[1,1000],unionGrowth:[0,1],stepMs:[0,10000],transportMs:[0,100000],totalB:[.001,10000],activeB:[.001,10000],layers:[1,1000],qHeads:[1,1000],qkDim:[1,4096],vDim:[1,4096],kvWidth:[1,1000000],attentionFraction:[.0001,1],memoryGB:[.001,10000],bandwidth:[.001,100000],matrixTF:[.001,100000],attentionTF:[.001,100000],cardWan:[.0001,10000],platformWan:[0,100000],hostW:[0,100000],tdpW:[0,100000],pue:[1,5],electricity:[0,100],powerHours:[0,24],days:[1,366],years:[.01,100],maintenance:[0,1],manualDaily:[0,1e10],apiHit:[0,1e7],apiMiss:[0,1e7],apiOut:[0,1e7],apiCache:[0,1],peakShare:[0,1]};
    for(const [k,[min,max]] of Object.entries(bounds))if(typeof s[k]!=='number'||!Number.isFinite(s[k])||s[k]<min||s[k]>max)errors.push(`${k} 需在 ${min}～${max} 内；未知硬件参数或报价需先补齐`);
    for(const k of ['concurrency','servers','slots','maxTP','layers','qHeads','qkDim','vDim','kvWidth','days'])if(!Number.isInteger(s[k]))errors.push(`${k} 必须为整数`);
    if(![1,2,4,8].includes(s.slots))errors.push('每台卡位仅支持 1 / 2 / 4 / 8');
    if(!['forward','reverse'].includes(s.mode)||!['manual','continuous'].includes(s.costMode))errors.push('计算模式无效');
    if(!data.apiPrices[s.api])errors.push('API 方案无效');
    if(!supported(m,c).includes(s.precision))errors.push('当前模型与芯片没有共同的可估算精度路径');
    if(s.activeB>s.totalB)errors.push('激活参数不能大于总参数');
    if(s.days>31)errors.push('每月计费天数不能超过 31 天');
    if(s.costMode==='continuous'&&s.powerHours<12)errors.push('12 小时连续对比中，本地每日计电时长不能低于 12 小时');
    const I=Math.round(s.inputK*1000),O=Math.round(s.outputK*1000),S=I+O;
    if(S>m.contextK*1000)errors.push(`单路输入 + 输出超过目录原生 ${m.contextK}K 上限；扩展上下文需单独验证`);
    if(errors.length)return {ok:false,errors,warnings,trace,inputs};
    warnings.push('理论规划值，不是实测承诺。算子、框架、通信、调度及硬件目录均需目标配置压测。');
    warnings.push('Q 头数、QK/V 维度为可编辑参考假设，未在本次联网核验；不是 KV 头数。');
    if(/DSA|Hybrid/.test(m.attentionType)||/gptoss|llama4/.test(m.id))warnings.push('当前使用全注意力参考情景；稀疏、混合、滑窗结构未建专用内核模型，不应据此直接采购。');
    if(s.attentionFraction!==1)warnings.push('Attention 比例由用户指定，仅缩放注意力运算量，不自动缩减 KV 或证明真实加速。');
    if(s.precision!=='fp16')warnings.push('量化权重、激活与框架内核支持尚需验证；Attention 仍按 FP16/BF16 路径，不套用 INT8/FP8 峰值。');
    if(s.multiNode)warnings.push('已启用跨节点 TP：通信仅用效率衰减近似，必须验证互连与软件栈。');
    warnings.push('API 价格沿用原目录，未实时更新；跨模型对比不代表质量、延迟与服务能力等价。');
    add('input','单路最大输入',['inputK'],`${fmt(s.inputK)} × 1000，四舍五入到 Token`,I,'Token');
    add('output','单路最大输出',['outputK'],`${fmt(s.outputK)} × 1000，四舍五入到 Token`,O,'Token','首 Token 由 Prefill 产生，其余 O−1 个由 Decode 产生。');
    add('context','单路预留上下文',['input','output','model'],`${I} + ${O}`,S,'Token','不叠加其他用户、全天请求或历史轮数；输入需已经包含本次携带的历史。');
    add('batch','首批同时请求',['concurrency'],`${s.concurrency}，全部同时到达，无 25% 突发折扣`,s.concurrency,'路');
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
        fits:used<=usable,ttftOK:ttft<=s.ttft,speedOK:1/endStep>=s.speed};
    }
    function capacity(tp,kind,limit) {
      const pass=B=>{const w=work(tp,B);return kind==='kv'?w.fits:kind==='ttft'?w.ttftOK:w.speedOK;};
      let lo=0,hi=limit;
      while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(pass(mid))lo=mid;else hi=mid-1;}return lo;
    }
    const tps=[1,2,4,8,16,32,64,128].filter(tp=>s.multiNode?tp<=s.maxTP:tp<=s.slots);
    const limit=s.mode==='forward'?s.concurrency:100000;
    const candidates=tps.map(tp=>{
      const kvCap=capacity(tp,'kv',limit),ttftCap=capacity(tp,'ttft',limit),decodeCap=capacity(tp,'decode',limit),bcap=Math.min(kvCap,ttftCap,decodeCap);
      const perServer=tp<=s.slots?Math.floor(s.slots/tp):0;
      const groups=s.mode==='forward'?(bcap?Math.ceil(s.concurrency/bcap):0):tp<=s.slots?s.servers*perServer:Math.floor(s.servers/(tp/s.slots));
      const servers=s.mode==='forward'?(groups?(tp<=s.slots?Math.ceil(groups/perServer):groups*(tp/s.slots)):0):s.servers;
      const B=groups?Math.ceil(s.concurrency/groups):1,w=work(tp,B);
      const proof={};
      for(const [kind,cap] of Object.entries({kv:kvCap,ttft:ttftCap,decode:decodeCap})) {
        const read=B=>{const x=work(tp,B);return kind==='kv'?x.used:kind==='ttft'?x.ttft:x.speed;};
        proof[kind]={cap,at:cap>0?read(cap):null,next:cap<limit?read(cap+1):null,limit:kind==='kv'?w.usable:kind==='ttft'?s.ttft:s.speed,capped:cap===limit};
      }
      return {tp,kvCap,ttftCap,decodeCap,bcap,groups,servers,B,capacity:bcap*groups,activeCards:tp*groups,purchasedCards:servers*s.slots,w,proof,valid:groups>0&&bcap>0&&w.fits&&w.ttftOK&&w.speedOK};
    });
    const valid=candidates.filter(x=>x.valid);
    valid.sort(s.mode==='forward'?(x,y)=>x.purchasedCards-y.purchasedCards||x.activeCards-y.activeCards:(x,y)=>y.capacity-x.capacity||x.w.response-y.w.response);
    // A failing reverse work point remains inspectable, but never receives a success badge.
    const chosen=valid[0]||(s.mode==='reverse'?candidates.filter(x=>x.groups>0).sort((x,y)=>y.capacity-x.capacity)[0]:null);
    add('topology','枚举可用 TP',['slots','multiNode','maxTP','mode'],`TP ∈ {${tps.join(', ')}}；搜索整数批量 0…${limit}`,tps.join(' / '),'卡/副本','每个候选分别检查显存、TTFT、末端速度；不允许把一条请求拆给多个副本。');
    if(!chosen) {warnings.push('当前假设下没有满足全部目标的拓扑。降低目标、换硬件或检查模型参数；不生成可交付采购结论。');return {ok:true,feasible:false,errors,warnings,trace,inputs,candidates,I,O,S,weight,kvSession};}
    const q=chosen,w=q.w,validPoint=q.valid;
    const bind=['显存','首 Token','末端 Decode'][[q.kvCap,q.ttftCap,q.decodeCap].indexOf(q.bcap)];
    add('efficiency','组内并行效率',['topology','parallelLoss'],`(1 − ${s.parallelLoss}) ^ log₂(${q.tp})`,w.eta,'比例','统一规划折损，不套用 910C 的跨模型“实测效率=1”。');
    add('matrixRate','组内有效矩阵算力',['matrixTF','mfu','efficiency'],`${q.tp} × ${s.matrixTF} × 10¹² × ${s.mfu} × ${fmt(w.eta)}`,w.matrix,'FLOP/s');
    add('attentionRate','组内有效 Attention 算力',['attentionTF','attentionMfu','efficiency'],`${q.tp} × ${s.attentionTF} × 10¹² × ${s.attentionMfu} × ${fmt(w.eta)}`,w.attention,'FLOP/s','独立半精度运算路径。');
    add('bandwidthRate','组内有效显存带宽',['bandwidth','bwEff','efficiency'],`${q.tp} × ${s.bandwidth} × 10⁹ × ${s.bwEff} × ${fmt(w.eta)}`,w.bw,'bytes/s');
    add('usable','组内可用于权重与 KV 的显存',['memoryGB','reserve','scratchGB','topology'],`${q.tp} × (${s.memoryGB} × (1 − ${s.reserve}) − ${s.scratchGB})`,w.usable,'GB','固定 workspace 每卡扣除；临时激活峰值需压测校准。');
    add('caps','每副本整数容量',['usable','kvSession','weight','matrixRate','attentionRate','bandwidthRate','ttft','speed','unionGrowth','stepMs','transportMs','kvTraffic'],`min(显存 ${q.kvCap}, TTFT ${q.ttftCap}, Decode ${q.decodeCap})`,q.bcap,'路',`逐候选二分搜索相同 work(TP,B)；当前约束：${bind}。上限命中表示“至少”，不是无限容量。`);
    add('groups','副本数',['caps','batch','mode','servers','slots'],s.mode==='forward'?`ceil(${s.concurrency} ÷ ${q.bcap})`:`按 ${s.servers} 台 × ${s.slots} 卡装入 ${q.tp} 卡副本（不跨副本共享请求）`,q.groups,'组');
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
    add('activeCards','参与计算卡数',['groups','topology'],`${q.groups} × ${q.tp}`,q.activeCards,'张');
    add('serverCount','采购/已有服务器数',['groups','topology','slots','mode','servers'],s.mode==='reverse'?`已有 ${s.servers} 台`:q.tp<=s.slots?`ceil(${q.groups} ÷ floor(${s.slots} ÷ ${q.tp}))`:`${q.groups} × (${q.tp} ÷ ${s.slots})`,q.servers,'台');
    add('purchasedCards','整机卡位数',['serverCount','slots'],`${q.servers} × ${s.slots}`,q.purchasedCards,'张','采用整机满配报价；空余卡位也计入采购与功率假设。');
    const capex=add('capex','硬件采购额',['purchasedCards','cardWan','serverCount','platformWan'],`(${q.purchasedCards} × ${s.cardWan} + ${q.servers} × ${s.platformWan}) × 10000`,(q.purchasedCards*s.cardWan+q.servers*s.platformWan)*10000,'元','平台报价不含卡；不重复计算整机报价。未含网络建设、税差及人工。');
    const power=add('power','设施侧规划功率',['purchasedCards','tdpW','serverCount','hostW','pue'],`(${q.purchasedCards} × ${s.tdpW} + ${q.servers} × ${s.hostW}) ÷ 1000 × ${s.pue}`,(q.purchasedCards*s.tdpW+q.servers*s.hostW)/1000*s.pue,'kW','TDP 满载参考，不是实际电表读数；即使部分副本闲置也按满配估算。');
    const energy=add('energy','每月电费',['power','powerHours','days','electricity'],`${power} × ${s.powerHours} × ${s.days} × ${s.electricity}`,power*s.powerHours*s.days*s.electricity,'元/月');
    const maintenance=add('maintenanceCost','每月维护准备金',['capex','maintenance'],`${capex} × ${s.maintenance} ÷ 12`,capex*s.maintenance/12,'元/月');
    const depreciation=add('depreciation','每月硬件摊销',['capex','years'],`${capex} ÷ (${s.years} × 12)`,capex/(s.years*12),'元/月');
    const localMonthly=add('localMonthly','本地月度摊销总成本',['energy','maintenanceCost','depreciation'],`${energy} + ${maintenance} + ${depreciation}`,energy+maintenance+depreciation,'元/月');
    const factor=data.apiPrices[s.api].peakPricing?1+s.peakShare:1;
    add('apiFactor','API 峰谷加权',['api','peakShare'],data.apiPrices[s.api].peakPricing?`1 + ${s.peakShare}（峰时价格为基价 2 倍）`:'该目录无峰谷倍率，取 1',factor,'倍','该折扣结构沿用目录，需向提供商确认；手动账单模式不参与费用结果。');
    const inPrice=add('apiInputPrice','API 有效输入单价',['apiHit','apiMiss','apiCache','apiFactor'],`(${s.apiHit} × ${s.apiCache} + ${s.apiMiss} × (1 − ${s.apiCache})) × ${factor}`,(s.apiHit*s.apiCache+s.apiMiss*(1-s.apiCache))*factor,'元/百万 Token','云端缓存命中率独立于本地首批冷启动。');
    const outPrice=add('apiOutputPrice','API 有效输出单价',['apiOut','apiFactor'],`${s.apiOut} × ${factor}`,s.apiOut*factor,'元/百万 Token');
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
    return {ok:true,feasible:validPoint,errors,warnings,trace,inputs,candidates,chosen:q,I,O,S,weight,kvSession,bind,cost:{capex,power,energy,maintenance,depreciation,localMonthly,apiMonthly,payback,localTCO,apiTCO},version:VERSION};
  }
  root.PlanningEngine={VERSION,precision,modelDefaults,defaults,supported,calculate,sumRoofline,fmt};
  if(typeof module!=='undefined')module.exports=root.PlanningEngine;
})(typeof window==='undefined'?globalThis:window);
