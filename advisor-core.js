'use strict';
// Deterministic boundary between model suggestions and the calculator.
(function(root){
  const Pricing=typeof module!=='undefined'&&module.exports?require('./pricing.js'):root.ApiPricing;
  const numeric={concurrency:[1,100000],inputK:[.001,10000],outputK:[.001,10000],ttft:[.001,36000],speed:[.001,100000],responseSlo:[.001,360000],budgetWan:[.0001,1e8],contextK:[.001,10000],throughput:[0,1e9],servers:[1,10000],slots:[1,8],usageHours:[.001,24],requestsPerDay:[0,1e9]};
  const choices={contextMeaning:['capability','request','unknown'],modality:['text','image','audio','video','unknown'],mode:['forward','reverse'],reverseTarget:['concurrency','throughput','speed','ttft','input','output'],throughputMetric:['sustained-output','decode-output','requests'],contextMode:['native','extended'],topologyMode:['replicas','single'],workloadMode:['closed-loop','requests']};
  const requirementKeys=[...Object.keys(numeric),...Object.keys(choices),'model','card','precision','task','domesticOnly','multiNode'];
  const coreKeys=['concurrency','inputK','outputK','ttft','speed'];
  function precisionPath(r,D,E){
    const m=D.models[r.model],c=D.cards[r.card];
    if(!m||!c||!r.precision||!E.canEstimate(m))return null;
    const available=E.supported(m,c);
    const int8=['int8','int8ref'].includes(r.precision);
    const effective=int8&&available.includes('int8')?'int8':int8&&available.includes('int8ref')?'int8ref':r.precision;
    return {requested:r.precision,effective,available:available.includes(effective),planning:effective==='int8ref',
      note:E.estimation(m,c,effective).note+(m.resourceEstimate?' '+m.resourceEstimate.note:'')+(effective==='int8ref'?' 按 INT8 做资源规划；量化适配尚待核实，转换和内核未核实。':'')};
  }
  function selectionIssue(r,D,E){
    const path=precisionPath(r,D,E);
    if(path&&!path.available)return '当前组合缺少 '+(E.precision[r.precision]?.name||r.precision)+' 的估算路径，请确认其他精度或芯片。';
    const missing=path?.available?sizingGaps(D.cards[r.card],path.effective,E):[];
    return missing.length?'当前芯片缺少 '+missing.join('、')+'，尚不能配卡；可在工作台补充已核对的规格，或确认其他芯片。':'';
  }
  function sizingGaps(c,p,E){
    const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
    return [['显存',c.memoryGB],['显存带宽',c.bandwidthGBs],['所选精度矩阵算力',c.computeTflops?.[E.precision[p]?.compute]],['FP16/BF16 Attention 算力',c.computeTflops?.fp16]].filter(([,v])=>!positive(v)).map(([label])=>label);
  }
  function requirements(raw,D,E){
    const out={};
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return out;
    for(const k of requirementKeys){const v=raw[k];if(v===null||v===undefined||v==='')continue;
      if(k in numeric){const [lo,hi]=numeric[k];if(typeof v==='number'&&Number.isFinite(v)&&v>=lo&&v<=hi&&(!['concurrency','servers','slots'].includes(k)||Number.isInteger(v)))out[k]=v;}
      else if(k in choices){if(choices[k].includes(v))out[k]=v;}
      else if(k==='model'&&Object.hasOwn(D.models,D.modelAliases?.[v]||v))out[k]=D.modelAliases?.[v]||v;
      else if(k==='card'&&Object.hasOwn(D.cards,v))out[k]=v;
      else if(k==='precision'&&Object.hasOwn(E.precision,v))out[k]=v;
      else if(k==='task'&&typeof v==='string')out[k]=v.slice(0,500);
      else if(['domesticOnly','multiNode'].includes(k)&&typeof v==='boolean')out[k]=v;
    }return out;
  }
  function unsupportedRequirements(r){
    const out=[];
    if(r.mode==='reverse'&&Number.isFinite(r.budgetWan))out.push({keys:['budgetWan'],message:'已有设备反向推演只计算硬件能力，不核算采购预算；采购预算请在按需求选配卡时评估。'});
    if(r.reverseTarget==='throughput')out.push({keys:['reverseTarget'],message:'最大总吞吐求解暂未开放。请明确选择并发、单路速度、首Token、输入或输出目标。'});
    if(r.throughput>0||r.throughputMetric&&r.throughputMetric!=='sustained-output')out.push({keys:['throughput','throughputMetric'],message:'总吞吐条件 '+(r.throughput??'未指定目标')+' '+({requests:'请求/s','decode-output':'Decode Token/s','sustained-output':'完整周期输出 Token/s'}[r.throughputMetric]||'（口径待明确）')+' 暂不纳入本页约束，不能将当前试算说成已满足此条件。'});
    if(r.contextMode==='extended')out.push({keys:['contextMode'],message:'要求扩展上下文，但当前只按模型原生上下文计算；尚不能确认此条件已满足。'});
    if(Number.isFinite(r.usageHours)&&r.usageHours!==12)out.push({keys:['usageHours'],message:'要求每日使用 '+r.usageHours+' 小时，但当前页面的API预算固定按12小时计算；不能确认已按此时长比较费用。'});
    if(r.workloadMode&&r.workloadMode!=='closed-loop')out.push({keys:['workloadMode','requestsPerDay'],message:'要求按每日请求数核算，但当前页面固定使用连续闭环工作量预算；尚不能按此工作量方式核验费用。'});
    else if(Number.isFinite(r.requestsPerDay))out.push({keys:['requestsPerDay'],message:'明确要求每天 '+r.requestsPerDay+' 次请求，但当前连续闭环预算不以每日请求数作为条件；不能静默忽略该工作量。'});
    return out;
  }
  function blockers(r){
    const names={concurrency:'同时处理多少路请求？',inputK:'每路最大输入多少 K Token？',outputK:'每路最大输出多少 K Token？',ttft:'首 Token 最多等多少秒？',speed:'每路生成速度至少多少 Token/s？'};
    const solved=r.mode==='reverse'?({concurrency:'concurrency',throughput:'throughput',speed:'speed',ttft:'ttft',input:'inputK',output:'outputK'})[r.reverseTarget||'concurrency']:null;
    const out=coreKeys.filter(k=>k!==solved&&!(solved==='throughput'&&k==='concurrency')&&!(k==='speed'&&Math.round(r.outputK*1000)===1)&&!Number.isFinite(r[k])).map(k=>names[k]);
    if(r.mode==='reverse'&&(!r.servers||!r.slots))out.push('已有几台设备，每台几张物理卡？');
    if(r.mode==='reverse'&&!r.reverseTarget)out.push('已有硬件要优先求最大并发、单路速度、首Token、输入还是输出？请明确反向目标。');
    if(r.mode==='reverse'&&r.reverseTarget==='output'&&!Number.isFinite(r.responseSlo))out.push('求最大输出时，完整响应最多允许多少秒？请明确填写，不能默认按60秒。');
    if(r.contextK&&!['capability','request'].includes(r.contextMeaning))out.push('上下文指模型支持上限，还是本次输入加输出的实际总量？');
    if(r.contextK&&r.contextMeaning==='request'&&Number.isFinite(r.inputK)&&Number.isFinite(r.outputK)&&Math.abs(r.contextK-r.inputK-r.outputK)>.001)out.push('本次上下文与输入加输出不一致，请先统一口径。');
    if(r.modality&& !['text','unknown'].includes(r.modality))out.push('当前引擎未计入图片/音频/视频编码成本，不能给出完整多模态配卡结论；请先明确是否另行评估编码服务。');
    return [...unsupportedRequirements(r).map(item=>item.message),...out];
  }
  function patchState(base,patch,D,E){
    const next=structuredClone(base);
    next.model=D.modelAliases?.[next.model]||next.model;
    if(Object.hasOwn(patch,'model'))patch={...patch,model:D.modelAliases?.[patch.model]||patch.model};
    // Catalog-derived numbers change only when the corresponding selection changes.
    for(const k of ['model','card','precision','api'])if(Object.hasOwn(patch,k)){
      const v=patch[k];const catalog=k==='model'?D.models:k==='card'?D.cards:k==='precision'?E.precision:D.apiPrices;
      if(k==='api'&&v===''){next.api='';next.apiHit=next.apiMiss=next.apiOut=null;next.apiUseCatalog=true;continue;}
      if(!Object.hasOwn(catalog,v))throw Error('目录项不存在：'+k);
      if(v===next[k])continue;next[k]=v;
      if(k==='model'){
        Object.assign(next,E.modelDefaults(D.models[v]));
        if(!Object.hasOwn(patch,'api')){next.api=Pricing.defaultApi(v,D);const a=D.apiPrices[next.api]||{};Object.assign(next,{apiHit:a.hit??null,apiMiss:a.miss??null,apiOut:a.out??null,apiUseCatalog:true});}
      }
      if(k==='card'){const c=D.cards[v];Object.assign(next,{memoryGB:c.memoryGB,bandwidth:c.bandwidthGBs||0,attentionTF:c.computeTflops.fp16||0,cardWan:c.cardPriceWan,platformWan:c.platformPriceWan??0,tdpW:c.tdpW});}
      if(k==='api'){const a=D.apiPrices[v];Object.assign(next,{apiHit:a.hit,apiMiss:a.miss,apiOut:a.out,apiUseCatalog:true});}
    }
    if(['model','card','precision'].some(k=>Object.hasOwn(patch,k)&&patch[k]!==base[k])){
      const supported=E.supported(D.models[next.model],D.cards[next.card]);
      const currentPath=precisionPath(next,D,E);
      if(currentPath?.available)next.precision=currentPath.effective;
      if(!Object.hasOwn(patch,'precision')&&!supported.includes(next.precision))next.precision=supported.find(k=>k!=='int8ref')||supported[0]||'fp16';
      const path=precisionPath(next,D,E);
      if(path?.available)next.precision=path.effective;
      next.matrixTF=D.cards[next.card].computeTflops[E.precision[next.precision].compute]||0;
    }
    for(const [k,v] of Object.entries(patch))if(Object.hasOwn(base,k)&&!['model','card','precision','api'].includes(k))next[k]=v;
    if(['apiHit','apiMiss','apiOut'].some(k=>Object.hasOwn(patch,k)))next.apiUseCatalog=false;
    return next;
  }
  function catalog(D,E){return {
    models:Object.values(D.models).map(m=>({id:m.id,name:m.name,contextK:m.contextK,local:E.canEstimate(m),architecture:m.attentionType,note:m.note,estimationNote:m.resourceEstimate?.note||'',source:m.source,checkedAt:m.checkedAt||null})),
    cards:Object.values(D.cards).map(c=>({id:c.id,name:c.name,source:c.source,domestic:c.vendor==='Huawei',precisions:c.precisions})),
    paths:Object.values(D.models).filter(m=>E.canEstimate(m)).flatMap(m=>Object.values(D.cards).map(c=>{const ps=E.supported(m,c).filter(p=>!sizingGaps(c,p,E).length);return {model:m.id,card:c.id,precisions:ps.map(p=>p==='int8ref'?'int8':p),planningPrecisions:ps.includes('int8ref')?['int8']:[],estimationNote:E.estimation(m,c).note};})).filter(p=>p.precisions.length)
  };}
  function normalize(body,D,E){
    if(!body||typeof body!=='object'||Array.isArray(body))throw Error('问答返回格式不完整，请重试。');
    const strings=(v,n=3)=>Array.isArray(v)?v.filter(x=>typeof x==='string').slice(0,n).map(x=>x.slice(0,700)):[];
    const req=requirements(body.requirements,D,E);
    const recommendations=(Array.isArray(body.recommendations)?body.recommendations:[]).slice(0,3).flatMap(p=>{
      if(!p||typeof p!=='object'||!Object.hasOwn(D.models,p.model)||!Object.hasOwn(D.cards,p.card)||!Object.hasOwn(E.precision,p.precision))return [];
      const adjustments={};for(const k of coreKeys)if(typeof p.adjustments?.[k]==='number'&&Number.isFinite(p.adjustments[k]))adjustments[k]=p.adjustments[k];
      return [{model:p.model,card:p.card,precision:p.precision,kind:['standard','headroom','relaxed'].includes(p.kind)?p.kind:'standard',reason:String(p.reason||'').slice(0,700),adjustments}];
    });
    return {assistant_message:typeof body.assistant_message==='string'?body.assistant_message.slice(0,1600):'请核对已整理的需求。',requirements:req,questions:strings(body.questions),warnings:strings(body.warnings,8),unresolved:strings(body.unresolved,5),recommendations};
  }
  function evaluateProposals(base,r,locks,recommendations,D,E){
    const issues=blockers(r);if(issues.length)return {issues,plans:[]};
    let specs=recommendations.slice(0,3);
    // Always retain the exact requested selection, even if the model proposes alternatives.
    if(r.model&&r.card&&r.precision){
      const exact=specs.some(spec=>spec.model===r.model&&spec.card===r.card&&spec.precision===r.precision&&!Object.keys(spec.adjustments||{}).length);
      if(!exact)specs=[{model:r.model,card:r.card,precision:r.precision,kind:'standard',reason:'按已确认型号与精度试算',adjustments:{}},...specs].slice(0,3);
    }
    if(!specs.length)return {issues:['请补充模型、芯片、精度，或让顾问从现有目录推荐组合。'],plans:[]};
    const seen=new Set();const plans=specs.map(spec=>{
      const selectionChanges=['model','card','precision'].filter(k=>r[k]&&spec[k]!==r[k]).map(key=>({key,before:r[key],after:spec[key]}));
      const patch={...Object.fromEntries(requirementKeys.filter(k=>Object.hasOwn(base,k)&&Object.hasOwn(r,k)).map(k=>[k,r[k]])),mode:r.mode||'forward',model:spec.model,card:spec.card,precision:spec.precision,...spec.adjustments};
      const conflicts=[];
      for(const k of Object.keys(spec.adjustments))if(spec.kind==='standard'&&patch[k]!==r[k])conflicts.push('普通方案不得更改客户需求：'+k);
      if(spec.kind==='headroom')for(const k of coreKeys.filter(k=>Number.isFinite(r[k]))){const harder=k==='ttft'?patch[k]<=r[k]:patch[k]>=r[k];if(!harder)conflicts.push('余量情景不能通过放宽需求实现：'+k);}
      for(const k of locks)if(Object.hasOwn(r,k)&&Object.hasOwn(patch,k)&&patch[k]!==r[k])conflicts.push('违反已锁定需求：'+k);
      if(locks.has('contextK')&&r.contextMeaning==='request'&&Math.abs(patch.inputK+patch.outputK-r.contextK)>.001)conflicts.push('违反锁定的单次上下文总量');
      if(r.domesticOnly&&D.cards[spec.card].vendor!=='Huawei')conflicts.push('芯片厂商不满足当前国产约束');
      const m=D.models[spec.model];
      // Missing benchmarks qualify the estimate; they do not veto calculation.
      const estimateOnly=!!m.catalogOnly;
      if(r.contextMeaning==='capability'&&(m.nativeContextTokens??m.contextTokens??m.contextK*1000)<r.contextK*1000)conflicts.push('模型原生上下文上限低于客户要求');
      const path=precisionPath(spec,D,E);
      const issue=selectionIssue(spec,D,E);if(issue)conflicts.push(issue);
      const explicitlyRequested=spec.model===r.model&&spec.card===r.card&&['int8','int8ref'].includes(r.precision);
      if(path?.planning&&!explicitlyRequested)conflicts.push('该量化路径仅是假设适配，不作为自动推荐');
      let state,result;try{state=patchState(base,patch,D,E);const solver=typeof module!=='undefined'&&module.exports?require('./solver-v5.js'):root.ReverseSolver;result=state.mode==='reverse'?solver.solve(state,D,state.reverseTarget):E.calculate(state,D);}catch(e){conflicts.push(e.message);}
      for(const k of locks)if(Object.hasOwn(r,k)&&Object.hasOwn(result?.effectiveState||{},k)&&result.effectiveState[k]!==r[k]&&!(k==='precision'&&path?.effective===result.effectiveState[k]))conflicts.push('反向求解工作点改变了锁定条件：'+k+'；需明确修改目标或解除该锁定。');
      if(locks.has('contextK')&&r.contextMeaning==='request'&&result?.effectiveState&&Math.abs(result.effectiveState.inputK+result.effectiveState.outputK-r.contextK)>.001)conflicts.push('反向求解结果改变了锁定的单次上下文总量');
      if(Number.isFinite(r.budgetWan)){
        if(result?.cost&&result.cost.capex>r.budgetWan*10000)conflicts.push('采购额超过预算上限');
        else if(!Number.isFinite(result?.cost?.capex))conflicts.push('费用未知，暂不能核验预算');
      }
      const signature=JSON.stringify(patch);if(seen.has(signature))return null;seen.add(signature);
      return {...spec,selectionChanges,state,result,conflicts,estimateOnly,planningPrecision:!!path?.planning,planningNotice:path?.note||'',allowed:!conflicts.length&&!!result?.ok&&!!result?.feasible};
    }).filter(Boolean);
    plans.sort((a,b)=>(b.allowed-a.allowed)||((a.result?.cost?.capex??Infinity)-(b.result?.cost?.capex??Infinity)));
    return {issues:[],plans};
  }
  root.AdvisorCore={requirementKeys,coreKeys,numeric,choices,requirements,unsupportedRequirements,blockers,patchState,catalog,normalize,evaluateProposals,precisionPath,selectionIssue};
  if(typeof module!=='undefined')module.exports=root.AdvisorCore;
})(typeof window==='undefined'?globalThis:window);
