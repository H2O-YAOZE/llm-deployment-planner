'use strict';
/* Planning equations with explicit cache layouts, topology and financial states.
 * Resource feasibility is independent of quotation/API availability.
 * These are reproducible planning equations, not a hardware benchmark. */
(function(root){
  const P=typeof module!=='undefined'&&module.exports?require('./pricing.js'):root.ApiPricing;
  const A=typeof module!=='undefined'&&module.exports?require('./compressed-attention.js'):root.CompressedAttention;
  const L=typeof module!=='undefined'&&module.exports?require('./parallel-layout.js'):root.ParallelLayout;
  const SP=typeof module!=='undefined'&&module.exports?require('./serving-planning.js'):root.ServingPlanning;
  const VERSION='5.10.0',finite=n=>typeof n==='number'&&Number.isFinite(n);
  const fmt=n=>finite(n)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:5}).format(n):'未知';
  const precision={
    fp4:{name:'FP4（格式待确认：MXFP4 / NVFP4）',bytes:null,compute:null},
    fp16:{name:'FP16（半精度规划）',bytes:2,compute:'fp16'},
    bf16:{name:'BF16',bytes:2,compute:'fp16'},
    fp8:{name:'FP8 权重 / FP8 矩阵',bytes:1,compute:'fp8'},
    int8:{name:'W8A8 / INT8 矩阵',bytes:1,compute:'int8'},
    int8ref:{name:'W8A8 / INT8（适配待核实）',bytes:1,compute:'int8'},
    int4:{name:'INT4 / W4A16',bytes:.5,compute:'fp16'},
    mxfp4:{name:'MXFP4 专家权重 / BF16 矩阵参考',bytes:.53125,compute:'fp16',storageFormat:'MXFP4'},
    nvfp4:{name:'NVFP4 权重 / FP4 矩阵',bytes:.5625,compute:'nvfp4',storageFormat:'NVFP4'}
  };
  // Deterministic deployment preference, used only after the primary objective ties.
  function deploymentOrder(a,b,s){
    const span=q=>Math.ceil(q.tp/s.slots);
    return span(a)-span(b)||a.groups-b.groups||a.activeCards-b.activeCards||
      a.w.storedWeight*a.groups-b.w.storedWeight*b.groups||a.tp-b.tp||a.attentionTP-b.attentionTP;
  }
  function procurement(q,s){
    return Number.isFinite(s.cardWan)&&s.cardWan>0&&Number.isFinite(s.platformWan)&&s.platformWan>=0?
      (q.purchasedCards*s.cardWan+q.servers*s.platformWan)*10000:null;
  }
  function comparePlans(a,b,s){
    const ac=procurement(a,s),bc=procurement(b,s);
    return (ac!==null&&bc!==null?ac-bc:a.purchasedCards-b.purchasedCards||a.servers-b.servers)||deploymentOrder(a,b,s);
  }
  function canEstimate(m){
    if(!m)return false;
    if(!m.catalogOnly)return true;
    const v=m.verifiedStructure||{};
    return !!m.resourceEstimate&&[m.totalParamsB,m.activeParamsB,m.layers,v.qHeads,v.qkDim,v.vDim,v.kvWidth].every(n=>finite(n)&&n>0);
  }
  function estimation(m,c,p){
    const route=m?.deploymentPaths?.[c?.id];
    const documented=!!route?.source&&(p?route.estimable?.includes(p):route.estimable?.length>0);
    return {documented,source:documented?route.source:null,
      label:documented?'估算，已有适配文档':'估算，适配未核实',
      note:documented?'已有适配文档，当前需求下的卡数和性能仍为估算，需实际部署验证。':'当前目录未收录此模型在该硬件上的已核验适配依据，以下仅作资源估算，误差可能较大；不代表已经能够部署。',
      architectureReference:!!m?.resourceEstimate};
  }
  function supported(m,c){
    if(!m||!c||!canEstimate(m))return [];
    const formats=(m.resourceEstimate?.storagePrecisions||m.supportedPrecisions||[]).join(' '),hw=(c.precisions||[]).join(' '),compute=c.computeTflops||{},routes=m.deploymentPaths?.[c.id]?.estimable||[];
    // Declared hardware formats allow choosing a precision and entering its
    // verified peak manually. calculate() still rejects a missing peak.
    const has=k=>finite(compute[k])&&compute[k]>0||!!({fp16:/BF16|FP16/,fp8:/FP8/,int8:/INT8/,nvfp4:/FP4/}[k]?.test(hw));
    // A reference quantization uses the same hardware capability as INT8.
    // Model storage formats and chip IDs are not kernel-adaptation evidence.
    const blocked=new Set(c.blockedPrecisions||[]);
    const nativeInt8=/INT8|W8A8/.test(formats)||routes.includes('int8');
    return Object.keys(precision).filter(k=>!blocked.has(k)&&!(k==='int8ref'&&blocked.has('int8'))).filter(k=>{
      if(k==='fp4')return false;
      if(k==='fp16'||k==='bf16')return has('fp16')&&/BF16|FP16/.test(formats);
      if(k==='fp8')return has('fp8')&&/FP8/.test(formats)&&/FP8/.test(hw);
      if(k==='int8')return has('int8')&&/INT8/.test(hw)&&nativeInt8;
      if(k==='int8ref')return has('int8')&&/INT8/.test(hw)&&/BF16|FP16/.test(formats)&&!nativeInt8;
      if(k==='int4')return has('fp16')&&/INT4|W4A16/.test(formats);
      // MXFP4 packed expert storage and a BF16 compute path are different from
      // using a marketing FP4 sparse peak. Do not advertise it on CANN by regex.
      if(k==='mxfp4')return c.vendor==='NVIDIA'&&has('fp16')&&!!m.precisionProfiles?.mxfp4;
      return has('nvfp4')&&/NVFP4/.test(formats)&&routes.includes('nvfp4');
    });
  }
  function modelDefaults(m){
    const v={...m.verifiedStructure,...m.runtimeStructure};
    return {totalB:m.totalParamsB,activeB:m.activeParamsB,layers:m.layers,qHeads:v.qHeads??null,
      qkDim:v.qkDim??m.headDim??null,vDim:v.vDim??m.headDim??null,
      kvWidth:v.kvWidth??(m.kvHeads&&m.headDim?2*m.kvHeads*m.headDim:null),attentionFraction:1};
  }
  function defaults(data){
    const model='qwen3b8',card='a910c',m=data.models[model],c=data.cards[card],api=P.defaultApi(model,data),a=data.apiPrices[api]||{};
    return {mode:'forward',model,card,precision:'bf16',inputK:8,outputK:1,concurrency:20,ttft:8,speed:30,
      throughput:0,throughputMetric:'sustained-output',topologyMode:'replicas',contextMode:'native',
      servers:1,slots:8,multiNode:true,maxTP:128,mfu:.4,attentionMfu:.3,bwEff:.65,parallelLoss:.08,
      reserve:.15,scratchGB:2,weightOverhead:1.1,kvBytes:2,kvReplication:1,kvTraffic:2,
      unionGrowth:.5,stepMs:.2,transportMs:100,...modelDefaults(m),
      memoryGB:c.memoryGB,bandwidth:c.bandwidthGBs,matrixTF:c.computeTflops.fp16??null,attentionTF:c.computeTflops.fp16??null,
      cardWan:c.cardPriceWan,platformWan:c.platformPriceWan,hostW:500,tdpW:c.tdpW,
      pue:1.3,electricity:.8,powerHours:24,days:30,years:3,maintenance:.03,
      costMode:'continuous',manualDaily:1000,api,apiHit:a.hit??null,apiMiss:a.miss??null,apiOut:a.out??null,
      apiCache:0,peakShare:.5,apiFx:7.2,apiUseCatalog:true,apiContextBand:'auto',cacheWriteShare:0,cacheTTL:'fiveMinutes',cacheStorageMTokHours:0,
      workloadMode:'closed-loop',requestsPerDay:1000,usageHours:12,dutyCycle:1,
      optimizeContext:false,minInputK:8,minOutputK:1,maxOutputK:1,responseSlo:60,reverseTarget:'concurrency'};
  }
  function sumRoofline(a,b,c,d,lo,hi){
    if(hi<lo)return 0;
    const crossing=(c-a)/(b-d),cuts=[lo,hi+1];
    if(finite(crossing)){const cut=Math.floor(crossing)+1;if(cut>lo&&cut<=hi)cuts.push(cut);}
    cuts.sort((x,y)=>x-y);let total=0;
    for(let i=0;i<cuts.length-1;i++){const l=cuts[i],h=cuts[i+1]-1,n=h-l+1,s=(l+h)/2;total+=n*Math.max(a+b*s,c+d*s);}
    return total;
  }
  function windowPairs(tokens,window){
    if(!window||tokens<=window)return tokens*(tokens+1)/2;
    return window*(window+1)/2+(tokens-window)*window;
  }
  function calculate(s,data,options={}){
    const trace=[],errors=[],warnings=[],inputs=Object.keys(s),ignored=new Set(options.ignoreTargets||[]);
    const add=(id,title,deps,formula,value,unit='',note='')=>{trace.push({id,title,deps,formula,value,unit,note});return value;};
    const m=data.models[s.model],c=data.cards[s.card],p=precision[s.precision];
    const fail=()=>({ok:false,feasible:false,errors,warnings,trace,inputs,candidates:[],version:VERSION,
      apiBudget:options.performanceOnly||s.mode==='reverse'?null:P.budget(s,data,options.now??Date.now())});
    if(!m||!c||!p){errors.push('模型、芯片或精度ID无效');return fail();}
    if(!canEstimate(m)){errors.push('该模型缺少必要的公开权重或结构参数，不能凭空估算本地卡数。');return fail();}
    if(m.resourceEstimate)warnings.push(m.resourceEstimate.note);
    const bounds={inputK:[.001,10000],outputK:[.001,10000],concurrency:[1,100000],ttft:[.001,36000],speed:[.001,100000],
      servers:[1,10000],slots:[1,8],maxTP:[1,128],mfu:[.001,1],attentionMfu:[.001,1],bwEff:[.001,1],parallelLoss:[0,.4],
      reserve:[0,.9],scratchGB:[0,10000],weightOverhead:[1,3],kvBytes:[.5,4],kvReplication:[1,128],kvTraffic:[1,1000],
      unionGrowth:[0,1],stepMs:[0,10000],transportMs:[0,100000],totalB:[.001,10000],activeB:[.001,10000],layers:[1,1000],
      qHeads:[1,1000],qkDim:[1,4096],vDim:[1,4096],kvWidth:[1,1000000],attentionFraction:[.0001,1],
      memoryGB:[.001,10000],bandwidth:[.001,100000],matrixTF:[.001,100000],attentionTF:[.001,100000]};
    for(const [k,[lo,hi]] of Object.entries(bounds))if(!ignored.has(k)&&!(k==='speed'&&Math.round(s.outputK*1000)===1)&&(!finite(s[k])||s[k]<lo||s[k]>hi))errors.push(k+'缺失或超出有效范围；不以未知值推算。');
    for(const k of ['concurrency','servers','slots','maxTP','layers','qHeads','qkDim','vDim','kvWidth'])if(!ignored.has(k)&&!Number.isInteger(s[k]))errors.push(k+'必须为整数');
    if(![1,2,4,8].includes(s.slots))errors.push('每台装卡数支持1/2/4/8');
    if(!['forward','reverse'].includes(s.mode))errors.push('测算方向无效');
    if(!supported(m,c).includes(s.precision))errors.push('没有此模型和芯片的可估算精度路径；原生格式不等于内核适配。');
    if(s.activeB>s.totalB)errors.push('激活参数不能超过完整参数');
    if(s.throughput!==undefined&&(!finite(s.throughput)||s.throughput<0))errors.push('总吞吐目标必须为非负数');
    if(s.throughputMetric&&!['sustained-output','decode-output','requests'].includes(s.throughputMetric))errors.push('吞吐单位/口径无效');
    if(!['single','replicas'].includes(s.topologyMode))errors.push('实例模式无效');
    if(!['native','extended'].includes(s.contextMode))errors.push('上下文模式无效');
    if(options.responseSlo!==undefined&&(!finite(options.responseSlo)||options.responseSlo<=0))errors.push('完整响应上限必须大于0');
    const I=Math.round(s.inputK*1000),O=Math.round(s.outputK*1000),S=I+O;
    const contextLimit=s.contextMode==='extended'?m.extendedContextTokens:m.nativeContextTokens??m.contextTokens??m.contextK*1000;
    if(!finite(contextLimit))errors.push('所选原生/扩展上下文上限尚未核实');
    else if(S>contextLimit)errors.push('输入+全部生成Token超过所选'+(s.contextMode==='extended'?'扩展':'原生')+'上下文上限 '+contextLimit);
    if(m.localMaxOutputTokens&&O>m.localMaxOutputTokens)errors.push('超过已验证的本地运行时最大输出');
    if(errors.length)return fail();
    const singleInstance=options.singleInstance??(s.topologyMode==='single');
    const profile=m.resourceEstimate?{kind:'reference'}:m.cacheProfile||{kind:'gqa',fullLayers:s.layers,slidingLayers:0,linearLayers:0};
    const compressed=m.resourceEstimate?null:A.profile(s,m);
    const structured=profile.kind!=='reference';
    const layerRatio=s.layers/m.layers;
    const lf=structured?(profile.fullLayers??s.layers)*layerRatio:s.layers;
    const ls=structured?(profile.slidingLayers||0)*layerRatio:0,ll=structured?(profile.linearLayers||0)*layerRatio:0,W=profile.slidingWindow||0;
    const linearElements=profile.linearStateElements||0,convElements=profile.linearConvElements||0;
    const linearFixed=ll*(linearElements*(profile.stateBytes||4)+convElements*s.kvBytes);
    const baseKV=s.kvWidth*s.kvBytes,fullKV=lf*baseKV,slideKV=ls*baseKV;
    const cacheBytes=length=>compressed?compressed.cache(length):fullKV*length+slideKV*Math.min(length,W||length)+linearFixed;
    const precisionProfile=m.precisionProfiles?.[s.precision];
    const quantB=precisionProfile?Math.min(s.totalB,precisionProfile.quantizedParamsB):s.totalB;
    const nonquantBytes=precisionProfile?.nonQuantizedBytes??p.bytes;
    const weight=add('weight','完整模型权重',['totalB','precision','weightOverhead'],precisionProfile?
      `(${quantB}B×${p.bytes} + ${s.totalB-quantB}B×${nonquantBytes} + ${precisionProfile.fixedMetadataGB||0}GB额外元数据)×${s.weightOverhead}`:`${s.totalB}×${p.bytes}×${s.weightOverhead}`,((s.totalB-quantB)*nonquantBytes+quantB*p.bytes+(precisionProfile?.fixedMetadataGB||0))*s.weightOverhead,'GB','总参数用于存储；量化元数据与非量化层保留。MXFP4每32元素1个scale，非全部层都按0.5byte。');
    // Active parameter dtype composition is rarely published; do not equate
    // expert-only FP4 storage with uniform FP4 compute or perfect bandwidth gains.
    const activeBytes=precisionProfile?nonquantBytes:p.bytes;
    const activeWeight=add('activeWeight','每Token激活权重访存参考',precisionProfile?.dense?['weight']:['activeB','precision','weightOverhead'],precisionProfile?.dense?'已知Dense混合权重存储量':`${s.activeB}×${activeBytes}×${s.weightOverhead}`,precisionProfile?.dense?weight:s.activeB*activeBytes*s.weightOverhead,'GB',precisionProfile?.dense?'Dense混合权重存储量作为每步读取参考；实际embedding访问与临时流量待校准。':precisionProfile?'混合精度激活组成未知，访存采用BF16保守参考。':'批内专家并集还需按路由/负载校准。');
    const parallel=L.profile(s,m,p,weight,activeWeight,quantB,nonquantBytes);
    if(parallel?.truncated)warnings.push('手填参数与配置专家几何不一致，专家部分按总量截断；请核对参数后校准。');
    const kv=add('kv',compressed?'压缩缓存线性增长率':'全注意力层KV增长率',['layers','kvWidth','kvBytes','model'],compressed?(compressed.kind==='deepseek-v4'?'(压缩4层/4+压缩128层/128)×共享KV宽度×字节+压缩4索引缓存':'全部主干层×MLA缓存宽度×字节+独立索引层×索引维度×字节'):`${lf}×${s.kvWidth}×${s.kvBytes}`,compressed?compressed.storeSlope:fullKV,'bytes/Token','完整存储与TopK实际读取分开；滑窗、索引与压缩状态按架构单独计算。');
    const baseSession=cacheBytes(S)/1e9;
    add('input','每路完整输入',['inputK'],`${s.inputK}×1000`,I,'Token');
    add('output','每路全部生成预算',['outputK'],`${s.outputK}×1000`,O,'Token','包含计费思考Token；首可见正文可能晚于首个生成Token。');
    add('context','输入+生成预算',['input','output','model'],`${I}+${O}≤${contextLimit}`,S,'Token');
    add('kvSessionBase','复制前的单路缓存',['context','kv','model','layers','kvBytes'],`完整缓存增长+滑窗+索引与状态`,baseSession,'GB','仅作为复制前基准；候选需按Attention TP复制并按DP最忙组预留。');
    add('batch','同时请求数',['concurrency'],String(s.concurrency),s.concurrency,'路');
    add('linearState','每会话线性递归/卷积状态',['model','layers','kvBytes'],`${ll}×(${linearElements}×${profile.stateBytes||4}+${convElements}×${s.kvBytes})`,linearFixed/1e9,'GB','递归状态按模型cache dtype；卷积状态按所填缓存dtype。分块临时激活由workspace另计。');
    const pairs=add('pairs','单层Prefill因果注意力对数',['input'],`${I}×(${I}+1)/2`,I*(I+1)/2,'Token对');
    const coef=add('attentionCoef','单层Attention FLOP系数',['qHeads','qkDim','vDim','attentionFraction'],`2×${s.qHeads}×(${s.qkDim}+${s.vDim})×${s.attentionFraction}`,2*s.qHeads*(s.qkDim+s.vDim)*s.attentionFraction,'FLOP/对/层');
    const linearOps=ll*linearElements*8; // explicit recurrence approximation, not a kernel peak.
    const pm=add('prefillMatrix','每路Prefill投影/MLP',['activeB','input'],`2×${s.activeB}×10⁹×${I}`,2*s.activeB*1e9*I,'FLOP');
    const pa=add('prefillAttention','每路Prefill Attention与递归参考',['attentionCoef','pairs','model','linearState'],compressed?(compressed.kind==='deepseek-v4'?'压缩128全局 + 压缩4 TopK + 128滑窗 + 索引扫描 + 压缩状态更新':'TopK主Attention + 独立索引层完整扫描'):`${coef}×(${lf}×${pairs}+${ls}×滑窗对数)+${linearOps}×${I}`,compressed?compressed.attention(I,true):coef*(lf*pairs+ls*windowPairs(I,W))+linearOps*I,'FLOP','索引扫描不因TopK减少而省略；状态更新8FLOP/元素/Token为显式工程近似。');
    const dm=add('decodeMatrix','每步参数运算',['activeB'],`2×${s.activeB}×10⁹`,2*s.activeB*1e9,'FLOP');
    const endContext=add('endContext','生成最后一个Token前的上下文',['context'],`${S}−1`,S-1,'Token');
    add('decodeAttention','末端Attention/递归',['attentionCoef','endContext','model','linearState'],compressed?'压缩全局 + TopK + 滑窗 + 索引扫描 + 状态更新':`${coef}×(${lf}×${endContext}+${ls}×min(${endContext},${W}))+${linearOps}`,compressed?compressed.attention(endContext,false):coef*(lf*endContext+ls*Math.min(endContext,W))+linearOps,'FLOP/步');
    const logicalFactor=c.logicalDevicesPerModule||1;
    const headSharded=!!compressed||profile.kind==='mla'||profile.kind==='gqa'||profile.kind==='sliding'||profile.kind==='linear-hybrid';
    const topologyValid=tp=>{
      const logical=tp*logicalFactor;
      if(tp>s.maxTP)return false;
      if(parallel)return L.layouts(tp,s,m,c,parallel).length>0;
      if(headSharded&&(logical>s.qHeads||s.qHeads%logical!==0))return false;
      if(headSharded&&m.kvHeads&&logical<m.kvHeads&&m.kvHeads%logical!==0)return false;
      if(headSharded&&m.kvHeads&&logical>m.kvHeads&&logical%m.kvHeads!==0)return false;
      if(profile.kind==='linear-hybrid'&&[profile.linearKeyHeads,profile.linearValueHeads].some(h=>!h||h%logical!==0))return false;
      return true;
    };
    const replication=logical=>s.kvReplication*(compressed||profile.latentMQA?logical:headSharded&&m.kvHeads?Math.max(1,logical/m.kvHeads):1);
    const servingProfile=SP?.prepare(s,data,root.PlanningEngine,options);
    function work(layout,B){
      const {tp}=layout,settings=L.settings(layout,B,s,parallel);
      const {eta,matrix,attention,bw,attentionMatrix,attentionBW,attentionEta}=settings;
      const AB=parallel?settings.attentionBatch:B,cacheBatch=parallel?settings.cacheBatch:B,storedWeight=parallel?settings.storedWeight:weight;
      const rep=replication(layout.attentionTP);
      const expertUnion=parallel?Math.min(parallel.expertWeight,parallel.activeExpert*(1+(B-1)*s.unionGrowth)):0;
      const union=parallel?expertUnion+parallel.activeDense:Math.min(weight,activeWeight*(1+(B-1)*s.unionGrowth));
      const prefillExpert=parallel?(I>1?parallel.expertWeight:expertUnion):0;
      const prefillDense=parallel?(I>1?parallel.denseWeight:parallel.activeDense):0;
      const prefillWeight=parallel?prefillExpert+prefillDense*layout.attentionDP:I>1&&s.activeB<s.totalB?weight:union;
      const session=compressed?cacheBytes(S)*rep/1e9:(fullKV*S+slideKV*Math.min(S,W||S))*rep/1e9+linearFixed/1e9;
      const usable=tp*(s.memoryGB*(1-s.reserve)-s.scratchGB),used=storedWeight+cacheBatch*session;
      const cacheTraffic=((cacheBytes(I)-linearFixed)*rep*s.kvTraffic+linearFixed);
      const pCompute=parallel?B*2*parallel.activeExpertB*1e9*I/matrix+AB*(2*parallel.activeDenseB*1e9*I/attentionMatrix+pa/attention):B*(pm/matrix+pa/attention);
      const pTraffic=prefillWeight*1e9+cacheBatch*cacheTraffic;
      const pMemory=parallel?prefillExpert*1e9/bw+(prefillDense*1e9+AB*cacheTraffic)/attentionBW:pTraffic/bw;
      const prefill=Math.max(pCompute,pMemory)+s.stepMs/1000,ttft=s.transportMs/1000+prefill;
      const ca=(parallel?B*2*parallel.activeExpertB*1e9/matrix+AB*2*parallel.activeDenseB*1e9/attentionMatrix:B*dm/matrix)+AB*(compressed?compressed.ops:linearOps)/attention;
      const cb=AB*(compressed?compressed.fullCoef:coef*lf)/attention,cs=AB*(compressed?compressed.windowCoef:coef*ls)/attention;
      const cacheBW=parallel?attentionBW:bw;
      const ma=(parallel?expertUnion*1e9/bw+parallel.activeDense*1e9/attentionBW:union*1e9/bw)+AB*(compressed?compressed.fixed*rep:linearFixed)/cacheBW;
      const mb=AB*(compressed?compressed.readSlope:fullKV)*rep/cacheBW,ms=AB*(compressed?compressed.windowSlope:slideKV)*rep/cacheBW,overhead=s.stepMs/1000;
      const ct=compressed?AB*compressed.selectedCoef/attention:0,mt=compressed?AB*compressed.selectedSlope*rep/cacheBW:0;
      const win=compressed?compressed.W:W,top=compressed?compressed.selectionWindow:0;
      const computeAt=x=>ca+cb*x+cs*Math.min(x,win)+ct*Math.min(x,top),memoryAt=x=>ma+mb*x+ms*Math.min(x,win)+mt*Math.min(x,top);
      const runtimeStep=SP?.allowance(servingProfile,layout,B,s)||0;
      const endCompute=computeAt(S-1),endMemory=memoryAt(S-1),endStep=Math.max(endCompute,endMemory)+overhead+runtimeStep;
      let decode=0;
      if(O>1){
        const lo=I+1,hi=I+O-1;
        if(compressed){
          const cuts=[lo,hi+1,...[win+1,top+1].filter(x=>x>lo&&x<=hi)].sort((a,b)=>a-b);
          for(let i=0;i<cuts.length-1;i++){
            const l=cuts[i],h=cuts[i+1]-1;
            decode+=sumRoofline(ca+(l>win?cs*win:0)+(l>top?ct*top:0),cb+(l<=win?cs:0)+(l<=top?ct:0),ma+(l>win?ms*win:0)+(l>top?mt*top:0),mb+(l<=win?ms:0)+(l<=top?mt:0),l,h);
          }
        }
        else if(!ls||W<=lo)decode=sumRoofline(ca+cs*W,cb,ma+ms*W,mb,lo,hi);
        else if(W>=hi)decode=sumRoofline(ca,cb+cs,ma,mb+ms,lo,hi);
        else decode=sumRoofline(ca,cb+cs,ma,mb+ms,lo,W)+sumRoofline(ca+cs*W,cb,ma+ms*W,mb,W+1,hi);
        decode+=(O-1)*(overhead+runtimeStep);
      }
      const speed=O>1?1/endStep:null,response=ttft+decode;
      return {tp,B,layout,attentionBatch:AB,cacheBatch,storedWeight,attentionMatrix,attentionBW,attentionEta,expertUnion,prefillExpert,prefillDense,
        eta,matrix,attention,bw,replication:rep,kvSession:session,union,prefillWeight,usable,used,pCompute,pTraffic,pMemory,prefill,ttft,
        ca,cb,cs,ct,ma,mb,ms,mt,runtimeStep,runtimeProfile:servingProfile,startStep:Math.max(computeAt(I+1),memoryAt(I+1))+overhead+runtimeStep,endCompute,endMemory,endStep,
        speed,decode,response,requestsPerSecond:B/response,outputThroughput:B*O/response,decodeThroughput:O>1?B/endStep:0,
        fits:used<=usable,ttftOK:ignored.has('ttft')||ttft<=s.ttft,speedOK:O<=1||ignored.has('speed')||speed>=s.speed};
    }
    const limit=s.mode==='forward'?s.concurrency:100000;
    function capacity(layout,kind){
      if(kind==='ttft'&&ignored.has('ttft')||kind==='decode'&&(ignored.has('speed')||O===1))return limit;
      const pass=B=>{const w=work(layout,B);return kind==='kv'?w.fits:kind==='ttft'?w.ttftOK:w.speedOK;};
      let lo=0,hi=limit;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(pass(mid))lo=mid;else hi=mid-1;}return lo;
    }
    const available=s.servers*s.slots;
    const tpOptions=[...new Set([1,2,4,8,16,32,64,128,...(parallel?Array.from({length:s.maxTP},(_,i)=>i+1).filter(tp=>parallel.experts%(tp*logicalFactor)===0):headSharded?Array.from({length:s.maxTP},(_,i)=>i+1).filter(tp=>s.qHeads%(tp*logicalFactor)===0):[])])].sort((a,b)=>a-b);
    let tps=singleInstance&&s.mode==='reverse'?(s.multiNode||s.servers===1?[available]:[]):tpOptions.filter(tp=>s.multiNode||tp<=s.slots);
    if(options.forceTP!==undefined)tps=tps.filter(tp=>tp===options.forceTP);
    const rejectedTP=tps.filter(tp=>!topologyValid(tp)||(s.mode==='reverse'&&tp>available));
    tps=tps.filter(tp=>topologyValid(tp)&&(s.mode!=='reverse'||tp<=available));
    const layouts=tps.flatMap(tp=>L.layouts(tp,s,m,c,parallel)).filter(l=>options.forceAttentionTP===undefined||l.attentionTP===options.forceAttentionTP);
    const candidates=layouts.map(layout=>{
      const {tp}=layout;
      const kvCap=capacity(layout,'kv'),ttftCap=capacity(layout,'ttft'),decodeCap=capacity(layout,'decode'),bcap=Math.min(kvCap,ttftCap,decodeCap),perServer=tp<=s.slots?Math.floor(s.slots/tp):0;
      let groups=singleInstance?1:s.mode==='forward'?(bcap?Math.ceil(s.concurrency/bcap):0):tp<=s.slots?s.servers*perServer:Math.floor(s.servers/Math.ceil(tp/s.slots));
      // Independent impact comparison can lock the baseline instance count.
      if(s.mode==='reverse'&&options.forceGroups!==undefined)groups=Number.isInteger(options.forceGroups)&&options.forceGroups>0&&options.forceGroups<=groups?options.forceGroups:0;
      const aggregate=g=>{
        if(!g)return 0;
        const small=Math.floor(s.concurrency/g),big=s.concurrency%g;
        const metric=z=>s.throughputMetric==='decode-output'?z.decodeThroughput:s.throughputMetric==='requests'?z.requestsPerSecond:z.outputThroughput;
        return (small?(g-big)*metric(work(layout,small)):0)+(big?big*metric(work(layout,small+1)):0);
      };
      if(!singleInstance&&s.mode==='forward'&&groups>0&&s.throughput>0&&!ignored.has('throughput')){
        // Split the same N requests across more replicas; never invent additional demand.
        // DP batch rounding can make different replica counts nonmonotonic.
        // At fixed floor(N/g), the aggregate is affine in g. Inspect intervals.
        let found=0;
        for(let lo=groups;lo<=s.concurrency;){
          const batch=Math.floor(s.concurrency/lo),hi=Math.floor(s.concurrency/batch);
          if(aggregate(lo)>=s.throughput){found=lo;break;}
          if(aggregate(hi)>=s.throughput){
            let a=lo,b=hi;while(a<b){const mid=Math.floor((a+b)/2);if(aggregate(mid)>=s.throughput)b=mid;else a=mid+1;}
            found=a;break;
          }
          lo=hi+1;
        }
        groups=found;
      }
      const servers=s.mode==='reverse'?s.servers:tp<=s.slots?Math.ceil(groups/perServer):groups*Math.ceil(tp/s.slots);
      const B=groups?Math.ceil(s.concurrency/groups):1,w=work(layout,B);
      const small=groups?Math.floor(s.concurrency/groups):0,bigGroups=groups?s.concurrency%groups:0;
      const smallGroups=groups-bigGroups;
      const outputThroughput=(small?smallGroups*work(layout,small).outputThroughput:0)+(bigGroups?bigGroups*w.outputThroughput:0);
      const requestsPerSecond=outputThroughput/O;
      const decodeThroughput=(small?smallGroups*work(layout,small).decodeThroughput:0)+(bigGroups?bigGroups*w.decodeThroughput:0);
      const metric=s.throughputMetric==='decode-output'?decodeThroughput:s.throughputMetric==='requests'?requestsPerSecond:outputThroughput;
      const throughputOK=ignored.has('throughput')||!(s.throughput>0)||metric>=s.throughput;
      const responseOK=options.responseSlo===undefined||w.response<=options.responseSlo;
      const activeGroups=Math.min(groups,s.concurrency),proof={};
      for(const [kind,cap] of Object.entries({kv:kvCap,ttft:ttftCap,decode:decodeCap})){
        const read=B=>{const z=work(layout,B);return kind==='kv'?z.used:kind==='ttft'?z.ttft:z.speed;};
        const inactive=kind==='ttft'&&ignored.has('ttft')||kind==='decode'&&(ignored.has('speed')||O===1);
        proof[kind]={cap,at:cap?read(cap):null,next:cap<limit?read(cap+1):null,limit:inactive?null:kind==='kv'?w.usable:kind==='ttft'?s.ttft:s.speed,capped:cap===limit,inactive};
      }
      const workloads=[...(small&&smallGroups?[{count:smallGroups,B:small,w:work(layout,small)}]:[]),...(bigGroups?[{count:bigGroups,B:small+1,w}]:[])];
      return {tp,layout,attentionTP:layout.attentionTP,attentionDP:layout.attentionDP,expertParallel:layout.expertParallel,id:`${tp}:${layout.attentionTP}`,logicalTP:tp*logicalFactor,kvCap,ttftCap,decodeCap,bcap,groups,activeGroups,servers,B,capacity:bcap*groups,workloads,
        activeCards:tp*activeGroups,allocatedCards:tp*groups,purchasedCards:servers*s.slots,w,single:work(layout,1),proof,
        outputThroughput,requestsPerSecond,decodeThroughput,throughputOK,responseOK,
        valid:groups>0&&bcap>0&&w.fits&&w.ttftOK&&w.speedOK&&responseOK&&throughputOK};
    });
    const perCard=s.memoryGB*(1-s.reserve)-s.scratchGB,loading=candidates.filter(q=>q.single.usable>=q.single.storedWeight),runnable=candidates.filter(q=>q.single.fits);
    const minimumWeightCards=perCard>0?Math.ceil(weight/perCard):null,minimumRequestCards=perCard>0?Math.ceil((weight+baseSession)/perCard):null;
    const referenceOnly=!!parallel||!!compressed||!structured||ll>0||s.precision==='int8ref'||s.precision==='mxfp4';
    const evidence=estimation(m,c,s.precision),documented=evidence.documented;
    const deploymentEvidence={status:documented?'documented-not-benchmarked':'planning-unverified',source:m.deploymentPaths?.[c.id]?.source||null,
      note:'精确checkpoint、框架版本、量化质量和目标负载压测须另验证。'};
    const performanceEvidence={referenceOnly,estimateAvailable:true,reason:compressed?(compressed.kind==='deepseek-v4'?'已按压缩4/128、TopK、滑窗及索引状态估算；MQA缓存仅在Attention TP组内复制，请求在Attention DP组均衡分配。同步冷启动并发较保守，在线调度与实际适配性能待压测。':'已按完整MLA缓存、TopK读取、独立索引层完整扫描估算；缓存按Attention TP复制，请求按Attention DP分组；shared索引复用不减少KV存储。在线调度及吸收投影/TopK排序性能待校准。'):!structured?'全Attention架构替代参考，专用算子未建模，估算误差可能较大。':ll>0?'混合KV与线性状态已计入；递归FLOPs/访存仍是显式规划近似，性能待校准。':'显式假设下的Roofline规划，未建完整调度/通信和临时激活模型。'};
    performanceEvidence.referenceOnly ||= !documented;
    performanceEvidence.deploymentNote=evidence.note;
    performanceEvidence.reason=evidence.note+' '+(m.resourceEstimate?.note||performanceEvidence.reason);
    warnings.push('理论规划，不是实机压测或采购保证。首Token为同步冷批次，不是在线排队P95。');
    warnings.push(performanceEvidence.reason);
    if(servingProfile){
      performanceEvidence.servingPlanning=servingProfile;
      performanceEvidence.reason+=' 生成时间额外计入同模型/精度/硬件公开P50测试与公式之间的非排队耗时差；长度和卡数迁移仍是规划估算，不是实测保证。';
      warnings.push(servingProfile.note);
    }
    if(parallel)warnings.push('MoE按配置专家几何规划EP与Attention TP/DP：专家均匀分片，非专家权重按DP复制，请求按最忙组预留。路由不均衡与通信使用规划效率，不代表框架已适配或压测确认。');
    if(c.specStatus!=='official-spec')warnings.push('芯片规格状态：'+c.specStatus+'；实际SKU/可用内存需核对。');
    if(c.quoteStatus==='planning')warnings.push('目录卡价为旧规划报价，未取得本次成交报价。');
    if(!documented)warnings.push('当前组合尚无本目录核验的完整部署文档，结果仅为资源规划。');
    if(s.precision!=='fp16'&&s.precision!=='bf16')warnings.push('Attention/KV精度独立于权重量化；量化转换与内核质量需验证。');
    if(rejectedTP.length)warnings.push('已排除物理卡上限/头分片不兼容的候选：'+rejectedTP.join('/'));
    if(m.note)warnings.push(m.note);
    const diagnostics={minimumWeightCards,minimumRequestCards,perCard,weightFits:loading.length>0,requestFits:runnable.length>0,
      loadingTP:loading[0]?.tp??null,requestTP:runnable[0]?.tp??null,requestLayout:runnable[0]?.id??null,maxTP:tps.at(-1)||0,crossNodeAllowed:s.multiNode,availableCards:s.mode==='reverse'?available:null,singleInstance,
      fastestSingleTTFT:runnable.length?Math.min(...runnable.map(q=>q.single.ttft)):null,
      fastestSingleSpeed:runnable.length&&O>1?Math.max(...runnable.map(q=>q.single.speed)):null,
      blockers:candidates.map(q=>({tp:q.tp,attentionTP:q.attentionTP,attentionDP:q.attentionDP,weightFits:q.single.usable>=q.single.storedWeight,oneRequestFits:q.single.fits,ttftOK:q.single.ttftOK,speedOK:q.single.speedOK,
        actualBatchFits:q.w.fits,actualTTFTOK:q.w.ttftOK,actualSpeedOK:q.w.speedOK,responseOK:q.responseOK,throughputOK:q.throughputOK}))};
    add('weightCardFloor','权重容量下限',['weight','memoryGB','reserve','scratchGB'],`ceil(${weight}/${perCard})`,minimumWeightCards,'张','容量下限不等于合法TP或采购卡数。');
    add('requestCardFloor','一路请求容量下限',['weight','model','context','memoryGB','reserve','scratchGB'],`ceil((${weight}+${baseSession})/${perCard})`,minimumRequestCards,'张','未含候选TP引起的额外KV复制；下方逐候选检查。');
    add('loadingCheck','装载与请求状态检查',['weightCardFloor','requestCardFloor','maxTP','servers','slots','multiNode','model'],`候选 ${tps.join('/')}`,loading.length?'模型可装载':'当前范围无合法装载候选');
    add('topology','物理卡候选与逻辑头分片',['slots','servers','multiNode','maxTP','topologyMode','model','card','qHeads'],`物理卡{${tps.join(',')}}，每模组${logicalFactor}个逻辑设备`,tps.join('/'),'卡/实例','MoE按配置枚举均匀EP与Attention TP/DP；Dense按头分片。均匀路由和通信效率属于规划假设，实际内核适配另验证。');
    const valid=candidates.filter(q=>q.valid);
    const score=q=>s.throughputMetric==='decode-output'?q.decodeThroughput:s.throughputMetric==='requests'?q.requestsPerSecond:q.outputThroughput;
    valid.sort(options.objective==='throughput'?(a,b)=>score(b)-score(a)||deploymentOrder(a,b,s):options.objective==='speed'?(a,b)=>(b.w.speed||0)-(a.w.speed||0)||deploymentOrder(a,b,s):
      options.objective==='ttft'?(a,b)=>a.w.ttft-b.w.ttft||deploymentOrder(a,b,s):s.mode==='forward'?(a,b)=>comparePlans(a,b,s):
      (a,b)=>b.capacity-a.capacity||deploymentOrder(a,b,s));
    const q=valid[0]||(s.mode==='reverse'?candidates.filter(q=>q.groups>0).sort((a,b)=>b.capacity-a.capacity)[0]:null);
    const baseResult={selection:{objective:s.mode==='forward'?'server-procurement':options.objective||'capacity',priced:procurement(q||{purchasedCards:0,servers:0},s)!==null,candidateCount:candidates.length,feasibleCount:valid.length,scope:'fixed-model-precision-chip-homogeneous-instances',networkIncluded:false,tieBreak:'fewer-servers-per-instance-then-fewer-instances'},ok:true,feasible:!!valid.length,errors,warnings,trace,inputs,candidates,I,O,S,weight,kvSessionBase:baseSession,kvSession:baseSession,
      cost:null,version:VERSION,diagnostics,performanceEvidence,deploymentEvidence,
      formulaContext:{parallel,compressed:compressed?Object.fromEntries(Object.entries(compressed).filter(([k,v])=>typeof v!=='function')):null,fullLayers:lf,slidingLayers:ls,linearLayers:ll,window:W,fullKV,slideKV,linearFixed,linearOps,quantB,nonquantBytes,activeBytes,metadataGB:precisionProfile?.fixedMetadataGB||0,weightBytes:p.bytes,precisionProfile:!!precisionProfile,denseMixed:!!precisionProfile?.dense}};
    if(!q)return withFinancials(baseResult,s,data,options);
    const w=q.w;const kvSession=w.kvSession;
    const bind=['显存','首Token','末端Decode'][[q.kvCap,q.ttftCap,q.decodeCap].indexOf(q.bcap)];
    add('chosenTP','选中每实例物理卡数',['topology','mode','topologyMode','concurrency','weight','activeWeight','context','model','kvWidth','kvBytes','kvReplication','kvTraffic','reserve','scratchGB','memoryGB','matrixTF','attentionTF','mfu','attentionMfu','bwEff','bandwidth','parallelLoss','prefillMatrix','prefillAttention','decodeMatrix','decodeAttention','unionGrowth','stepMs','transportMs',...['ttft','speed','throughput'].filter(k=>!ignored.has(k)&&k in s)],`在${candidates.length}个合法候选中选择`,q.tp,'张/实例');
    add('attentionTP','Attention组逻辑设备',['chosenTP','model','card','qHeads'],`按配置约束枚举Attention头/输出分组`,q.attentionTP,'个');
    add('attentionDP','Attention请求分组',['chosenTP','attentionTP','card'],`${q.logicalTP}/${q.attentionTP}`,q.attentionDP,'组');
    add('attentionCards','每Attention组物理卡份额',['attentionTP','card'],`${q.attentionTP}/${logicalFactor}`,w.layout.attentionCards,'张');
    if(parallel){
      add('expertWeight','实例内专家权重',['model','totalB','layers','precision','weightOverhead'],`配置专家参数×存储精度×元数据系数`,parallel.expertWeight,'GB');
      add('denseWeight','一份非专家权重',['weight','expertWeight'],`${weight}-${parallel.expertWeight}`,parallel.denseWeight,'GB');
      add('expertActiveB','每Token激活专家参数',['model','activeB','totalB','layers'],`专家参数×topK/专家数（不超过激活总量）`,parallel.activeExpertB,'B');
      add('denseActiveB','每Token非专家激活参数',['activeB','expertActiveB'],`${s.activeB}-${parallel.activeExpertB}`,parallel.activeDenseB,'B');
      add('expertActiveWeight','每Token专家访存参考',['activeWeight','expertActiveB','activeB'],`激活权重×专家激活参数比例`,parallel.activeExpert,'GB');
      add('denseActiveWeight','每Token非专家访存参考',['activeWeight','expertActiveWeight'],`激活权重-专家访存`,parallel.activeDense,'GB');
    }
    add('storedWeight','实例实际权重存储',['weight',...(parallel?['expertWeight','denseWeight','attentionDP']:[])],parallel?`专家权重+非专家权重×Attention DP`:'一份模型权重',w.storedWeight,'GB');
    add('kvReplicationEffective','候选KV复制系数',['attentionTP','card','model','kvReplication'],`手动${s.kvReplication}×Attention头分片复制`,w.replication,'倍');
    add('kvSession','候选单路峰值状态',['model','context','kv','linearState','kvReplicationEffective'],compressed?'(压缩完整缓存+滑窗+索引+压缩状态)×Attention TP复制':'全KV+窗口KV×复制+线性状态',kvSession,'GB');
    add('efficiency','组内规划并行效率',['chosenTP','parallelLoss'],`(1-${s.parallelLoss})^log2(${q.tp})`,w.eta,'比例');
    for(const [id,title,field,unit] of [['matrixRate','矩阵有效速率','matrix','FLOP/s'],['attentionRate','Attention有效速率','attention','FLOP/s'],['bandwidthRate','显存有效带宽','bw','bytes/s']]){
      const deps=id==='matrixRate'?['matrixTF','mfu']:id==='attentionRate'?['attentionTF','attentionMfu']:['bandwidth','bwEff'];
      add(id,title,[...(id==='attentionRate'?['attentionCards','parallelLoss']:['chosenTP','efficiency']),...deps],id==='attentionRate'?`Attention组卡份额×峰值×利用率×组效率`:`${q.tp}卡×峰值×利用率×η`,w[field],unit);
    }
    add('attentionEfficiency','Attention组规划效率',['attentionCards','parallelLoss'],`(1-loss)^log2(max(1,Attention组卡份额))`,w.attentionEta,'比例');
    add('attentionMatrixRate','Attention组矩阵有效速率',['attentionCards','attentionEfficiency','matrixTF','mfu'],`组卡份额×矩阵峰值×利用率×组效率`,w.attentionMatrix,'FLOP/s');
    add('attentionBandwidthRate','Attention组显存有效带宽',['attentionCards','attentionEfficiency','bandwidth','bwEff'],`组卡份额×显存带宽×效率`,w.attentionBW,'bytes/s');
    add('usable','组内可用显存',['chosenTP','memoryGB','reserve','scratchGB'],`${q.tp}×(${s.memoryGB}×(1-${s.reserve})-${s.scratchGB})`,w.usable,'GB','workspace为显式预算；临时激活峰值仍需运行时画像。');
    add('caps','每实例并发边界',['chosenTP','usable','kvSession','prefillAttention','decodeAttention','matrixRate','attentionRate','bandwidthRate','kvTraffic',...['ttft','speed'].filter(k=>!ignored.has(k))],`min(${q.kvCap},${q.ttftCap},${q.decodeCap})`,q.bcap,'路');
    add('groups','已布置模型实例',['caps','topology','concurrency','mode','topologyMode'],singleInstance?'固定一个实例':`整机布置${q.groups}个实例`,q.groups,'组');
    add('groupBatch','最忙实例批量',['groups','batch'],`ceil(${s.concurrency}/${q.groups})`,q.B,'路');
    add('attentionBatch','最忙Attention组并发',['groupBatch','attentionDP'],`ceil(实例并发/${q.attentionDP})`,w.attentionBatch,'路','实例间并发先均分，再分配给Attention DP组。');
    add('cacheBatch','按最忙组预留请求状态',['attentionBatch','attentionDP'],`${w.attentionBatch}×${q.attentionDP}`,w.cacheBatch,'份','按每组峰值检查显存。取整后的预留份数可能高于实际并发，不把它计入API用量或实际吞吐。');
    add('union','Decode读取权重参考',['weight','activeWeight','groupBatch','unionGrowth',...(parallel?['expertWeight','expertActiveWeight','denseActiveWeight']:[])],parallel?`min(专家全权重,专家激活×并集增长)+非专家激活权重`:`min(全权重,激活权重×[1+(B-1)×${s.unionGrowth}])`,w.union,'GB');
    add('used','峰值权重+请求状态',['storedWeight','kvSession','cacheBatch'],`${w.storedWeight}+${w.cacheBatch}×${kvSession}`,w.used,'GB');
    add('prefillComputeTime','整批Prefill计算',['groupBatch','attentionBatch','prefillMatrix','prefillAttention','matrixRate','attentionMatrixRate','attentionRate',...(parallel?['expertActiveB','denseActiveB']:[])],parallel?`实例并发×专家矩阵/实例算力+最忙Attention并发×(非专家矩阵/组算力+Attention/组算力)`:`B×(矩阵/矩阵速率+Attention/Attention速率)`,w.pCompute,'s');
    add('prefillWeight','Prefill权重读取情景',['weight','activeWeight','groupBatch','input','storedWeight'],`长输入按实例实际权重读取；否则按专家并集与各组非专家读取`,w.prefillWeight,'GB','输入内部路由不能只按并发B的专家并集。分块重读与激活流量还需实机校准。');
    add('prefillTraffic','Prefill流量规划',['prefillWeight','input','kv','linearState','kvReplicationEffective','kvTraffic','cacheBatch'],`实例权重读取+最忙组预留×输入缓存写入/重读+线性状态`,w.pTraffic,'bytes','全权重一次读取是明确场景，实际路由、分块和跨设备流量待测。');
    add('prefillMemoryTime','Prefill访存',['prefillTraffic','bandwidthRate','attentionBandwidthRate','attentionBatch'],parallel?`专家读取/实例带宽+(非专家读取+最忙组缓存流量)/Attention组带宽`:`流量/有效带宽`,w.pMemory,'s');
    add('prefillTime','Prefill阶段',['prefillComputeTime','prefillMemoryTime','stepMs'],`max(计算,访存)+阶段开销`,w.prefill,'s');
    add('ttftResult','首生成Token延迟',['prefillTime','transportMs'],`Prefill+请求传输`,w.ttft,'s');
    add('decodeComputeTime','末端每步计算',['decodeMatrix','decodeAttention','groupBatch','attentionBatch','matrixRate','attentionMatrixRate','attentionRate',...(parallel?['expertActiveB','denseActiveB']:[])],`专家按实例计算；非专家与Attention按最忙Attention组计算`,O>1?w.endCompute:0,'s/步');
    add('decodeMemoryTime','末端每步访存',['union','context','kv','linearState','kvReplicationEffective','groupBatch','attentionBatch','bandwidthRate','attentionBandwidthRate'],`专家并集/实例带宽+非专家及最忙组KV/Attention组带宽`,O>1?w.endMemory:0,'s/步');
    if(servingProfile)add('runtimeStep','公开测试补充的生成耗时',['model','card','precision','groupBatch','chosenTP','matrixTF','mfu','bandwidth','bwEff','parallelLoss'],`${servingProfile.fixedSeconds}+${servingProfile.perRequestSeconds}×实例并发×设备资源换算`,w.runtimeStep,'s/步',servingProfile.note);
    add('decodeStep','末端Decode步',['decodeComputeTime','decodeMemoryTime','stepMs','output',...(servingProfile?['runtimeStep']:[])],`O>1时 max(计算,访存)+步开销${servingProfile?'+公开测试耗时差':''}`,O>1?w.endStep:0,'s/步');
    add('decodeSpeed','末端单路生成速度',['decodeStep','output'],O>1?'1/末端步时长':'仅输出首Token，没有Decode阶段',w.speed,'Token/s/路');
    add('decodeDuration','剩余输出总Decode时间',['input','output','groupBatch','decodeMatrix','attentionCoef','model','union','kv','linearState','kvReplicationEffective','matrixRate','attentionMatrixRate','attentionRate','bandwidthRate','attentionBandwidthRate','attentionBatch','stepMs',...(servingProfile?['runtimeStep']:[])],`对O-1步按窗口分段求和max(计算,访存)+每步附加耗时`,w.decode,'s');
    add('response','完整响应时间',['ttftResult','decodeDuration'],`首Token+剩余Decode`,w.response,'s');
    add('prefillThroughput','最忙实例输入吞吐',['groupBatch','input','prefillTime'],`B×I/Prefill`,q.B*I/w.prefill,'Token/s');
    add('totalOutputThroughput','完整工作负载总输出吞吐',['groups','groupBatch','response','output'],`Σ实例(B×O/完整响应周期)`,q.outputThroughput,'Token/s','包含Prefill与Decode，不等于Decode阶段N×单路速度。');
    add('totalDecodeThroughput','Decode阶段末端总吞吐',['groups','groupBatch','decodeSpeed','output'],`Σ活跃实例(B×单路速度)`,q.decodeThroughput,'Token/s');
    add('completedRequests','完整请求吞吐',['totalOutputThroughput','output'],`总输出吞吐/O`,q.requestsPerSecond,'请求/s');
    add('activeCards','当前请求实际参与卡数',['groups','batch','chosenTP'],`${q.activeGroups}活跃实例×${q.tp}`,q.activeCards,'张','已布置实例可能闲置；报价与设施功率仍按现有/采购整机。');
    add('serverCount','采购/已有服务器',['chosenTP','groups','slots','mode','servers'],String(q.servers),q.servers,'台');
    add('purchasedCards','整机满配卡位',['serverCount','slots'],`${q.servers}×${s.slots}`,q.purchasedCards,'张');
    if(options.responseSlo!==undefined)add('responseCheck','完整响应限时',['response','responseSlo'],`${w.response}≤${options.responseSlo}`,q.responseOK?'满足':'不满足');
    const result={...baseResult,feasible:q.valid,chosen:q,kvSession,bind};
    if(options.performanceOnly||s.mode==='reverse')return result;
    return financials(result,s,data,add,options);
  }

  // Forward financials attach to the chosen workpoint. Reverse capacity
  // evaluation never enters the pricing or financial path.
  function withFinancials(r,s,D,options={}){
    if(options.performanceOnly||s.mode==='reverse')return r;
    if(!r.ok||!r.chosen)return {...r,apiBudget:P.budget(s,D,options.now??Date.now())};
    const trace=[...r.trace],warnings=[...r.warnings];
    const add=(id,title,deps,formula,value,unit='',note='')=>{trace.push({id,title,deps,formula,value,unit,note});return value;};
    return financials({...r,trace,warnings},s,D,add,options);
  }

  function financials(r,s,D,add,options){
    const errors=[],warnings=r.warnings,q=r.chosen,finiteNonnegative=n=>finite(n)&&n>=0;
    const manualMode=s.costMode==='manual';
    const invalidCost=keys=>keys.filter(k=>!finiteNonnegative(s[k]));
    if(!finite(s.cardWan)||s.cardWan<=0)errors.push('单卡报价未知：本地容量已算，采购/TCO暂不计算。');
    const bad=invalidCost(['platformWan','hostW','tdpW','electricity','maintenance','powerHours']);
    if(bad.length)errors.push('本地财务参数未知/无效：'+bad.join(','));
    if(!finite(s.pue)||s.pue<1||!Number.isInteger(s.days)||s.days<1||s.days>31||!finite(s.years)||s.years<=0)errors.push('PUE、月天数或年限无效');
    const usage=s.usageHours??12,duty=s.dutyCycle??1;
    if(!manualMode&&(!finite(usage)||usage<=0||usage>24||!finite(duty)||duty<=0||duty>1))errors.push('使用时长/占空比无效');
    if(!finite(s.powerHours)||s.powerHours>24||s.powerHours<0||(!manualMode&&s.powerHours<usage))errors.push(manualMode?'本地计电小时需在0到24小时之间':'计电小时需在业务使用小时与24小时之间');
    const localOK=!errors.length;
    const capex=localOK?(q.purchasedCards*s.cardWan+q.servers*s.platformWan)*10000:null;
    const power=localOK?(q.purchasedCards*s.tdpW+q.servers*s.hostW)/1000*s.pue:null;
    const energy=localOK?power*s.powerHours*s.days*s.electricity:null,maintenance=localOK?capex*s.maintenance/12:null;
    const depreciation=localOK?capex/(s.years*12):null,localMonthly=localOK?energy+maintenance+depreciation:null;
    add('capex','硬件采购额',['purchasedCards','serverCount','cardWan','platformWan'],`满配卡位×单卡报价+无卡平台报价`,capex,'元','0卡价表示未询价，不表示免费。');
    add('power','设施侧规划功率',['purchasedCards','serverCount','tdpW','hostW','pue'],`(卡功率+主机功率)×PUE`,power,'kW');
    add('energy','月电费',['power','powerHours','days','electricity'],`设施功率×每日计电小时×月天数×电价`,energy,'元/月');
    add('maintenanceCost','月维护准备金',['capex','maintenance'],`采购额×年维护比例/12`,maintenance,'元/月');
    add('depreciation','月摊销',['capex','years'],`采购额/(年限×12)`,depreciation,'元/月');
    add('localMonthly','本地月度摊销成本',['energy','maintenanceCost','depreciation'],`电费+维护+摊销`,localMonthly,'元/月');
    const cycle=s.ttft+(r.O>1?(r.O-1)/s.speed:0);
    let rounds=manualMode?null:s.workloadMode==='requests'?s.requestsPerDay:s.concurrency*usage*3600*duty/cycle;
    if(!manualMode&&(!finite(rounds)||rounds<0)){errors.push('每日请求数未知或无效');rounds=null;}
    const workloadValid=manualMode||finite(rounds)&&rounds>=0&&finite(usage)&&usage>0&&rounds/(usage*3600)<=q.requestsPerSecond;
    if(!manualMode&&!workloadValid)warnings.push('所填工作量超过本地完整请求吞吐或有效使用时长，不能直接比较回本。');
    const dailyIn=finite(rounds)?rounds*r.I:null,dailyOut=finite(rounds)?rounds*r.O:null;
    add('targetCycle','闭环目标单轮周期',['ttft','speed','output'],`目标TTFT+(O-1)/目标速度`,cycle,'s');
    add('dailyRounds','每日等效请求量',['workloadMode','requestsPerDay','batch','targetCycle','usageHours','dutyCycle'],s.workloadMode==='requests'?'用户填写实际/预算请求数':'N×使用秒数×占空比/目标周期',rounds,'次/日','连续闭环是假设；在线人数不自动等于全天活跃并发。');
    add('dailyInput','每日输入量',['dailyRounds','input'],`请求×完整输入`,dailyIn,'Token/日');
    add('dailyOutput','每日生成量',['dailyRounds','output'],`请求×全部生成预算`,dailyOut,'Token/日');
    let apiQuote=null,apiBudget=null,dailyAPI=null,apiMonthly=null,matched=false;
    if(s.costMode==='manual'){
      if(!finiteNonnegative(s.manualDaily))errors.push('手动账单无效');else {dailyAPI=s.manualDaily;matched=false;warnings.push('手动账单尚未证明与本地同模型同工作量，不自动输出回本结论。');}
    }else{
      apiBudget=P.budget(s,D,options.now??Date.now());
      apiQuote=apiBudget.quote;warnings.push(...apiQuote.warnings);matched=apiQuote.matched;
      if(apiBudget.ok&&apiBudget.monthly!==null)dailyAPI=apiBudget.monthly/s.days;
      errors.push(...apiBudget.errors.filter(e=>!errors.includes(e)));
    }
    if(finite(dailyAPI)&&finite(s.days)&&s.days>0&&s.days<=31)apiMonthly=dailyAPI*s.days;
    add('apiPriceSource','API服务版本与价格来源',['api','apiUseCatalog','apiFx','input','output'],apiQuote?.api?.endpoint||'手动账单',apiQuote?.source||'manual','',apiQuote?.api?.source||'');
    add('apiFactor','峰谷Token用量倍率',['api','peakShare'],`1+峰时Token占比（有2倍峰价时）`,apiQuote?.factor??1,'倍');
    add('apiInputPrice','有效输入单价',['apiPriceSource','apiFactor','apiCache','cacheWriteShare','cacheTTL','apiHit','apiMiss'],`命中/未命中/写入按服务规则加权`,apiQuote?.inputPrice??null,'元/百万Token');
    add('apiOutputPrice','有效输出单价',['apiPriceSource','apiFactor','apiOut'],`所选档位输出价×峰谷倍率`,apiQuote?.outputPrice??null,'元/百万Token');
    add('dailyAPI','每日API Token与缓存费用',['dailyInput','dailyOutput','apiInputPrice','apiOutputPrice','cacheStorageMTokHours','manualDaily','costMode'],`(输入×输入价+输出×输出价)/10⁶+缓存存储`,dailyAPI,'元/日','额外工具、检索和媒体费用需按调用数补充，不把未建模项当0成本保证。');
    add('apiMonthly','月API费用',['dailyAPI','days'],`每日×月天数`,apiMonthly,'元/月');
    const comparable=localOK&&finite(apiMonthly)&&matched&&r.feasible&&workloadValid&&apiQuote?.limitsVerified&&apiQuote?.completePrice&& !r.performanceEvidence.referenceOnly;
    const saving=comparable?apiMonthly-energy-maintenance:null,payback=comparable&&saving>0?capex/saving:null;
    const localTCO=localOK?capex+(energy+maintenance)*s.years*12:null,apiTCO=finite(apiMonthly)&&finite(s.years)?apiMonthly*s.years*12:null;
    add('saving','同模型规划月差额',['apiMonthly','energy','maintenanceCost','model','api'],comparable?'API-电费-维护':'未成立同模型/可行性/报价条件',saving,'元/月');
    add('payback','同模型规划现金回本',['saving','capex'],saving>0?'采购额/月差额':'不可比较或无有限回本期',payback,'月','不重复扣折旧；已有设备仅重购基准；真实API SLO与质量仍须验证。');
    add('localTCO','本地年限内TCO',['capex','energy','maintenanceCost','years'],`采购+(电费+维护)×年限×12`,localTCO,'元');
    add('apiTCO','API年限内支出',['apiMonthly','years'],`月费×年限×12`,apiTCO,'元');
    const apiMonthlyRange=apiBudget?.monthlyRange??null;
    return {...r,apiMonthlyRange,financeErrors:errors,costStatus:{local:localOK?'planning':'unknown',api:finite(apiMonthly)?'planning':apiMonthlyRange?'range':'unknown',comparable,matched},
      apiQuote,apiBudget,cost:{capex,power,energy,maintenance,depreciation,localMonthly,apiMonthly,payback,localTCO,apiTCO,comparable},
      warnings:[...warnings,...errors]};
  }
  root.PlanningEngine={deploymentOrder,comparePlans,procurement,VERSION,precision,modelDefaults,defaults,canEstimate,estimation,supported,calculate,withFinancials,sumRoofline,windowPairs,fmt};
  if(typeof module!=='undefined')module.exports=root.PlanningEngine;
})(typeof window==='undefined'?globalThis:window);
