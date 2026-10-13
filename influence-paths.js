'use strict';
// Read-only projection: actual trace edges, explicit catalog bindings, and a
// separate post-solve phase. It never mutates the executed DAG or its numbers.
(function(root){
 const terminals=['weight','used','usable','ttftResult','decodeSpeed','response','totalOutputThroughput','purchasedCards','capex','localMonthly','apiMonthly','responseCheck','solveAnswer'];
 const configuration=new Set(['topology','chosenTP','caps','groups','serverCount']);
 const solvedNames={concurrency:'并发',speed:'单路速度',ttft:'首Token延迟',inputK:'输入长度',outputK:'输出长度',throughput:'总吞吐'};
 function label(id){
  if(id.startsWith('@catalog:'))return ({model:'切换模型时更新目录参数',card:'切换芯片时更新硬件参数',precision:'按精度选取矩阵峰值',api:'切换API时更新目录价格'})[id.slice(9)]||'读取目录参数';
  if(id.startsWith('@solved:'))return '求得'+(solvedNames[id.slice(8)]||id.slice(8));
  if(id.startsWith('@workpoint:'))return '采用求解后的'+(solvedNames[id.slice(11)]||id.slice(11));
  return null;
 }
 function project(ctx,r,key){
  if(!r?.ok||r.solvedInputs?.includes(key))return [];
  const s=r.effectiveState||ctx.s||ctx.state||{},D=ctx.D||root.AppData,E=ctx.E||root.PlanningEngine;
  const nodes=new Map((r.trace||[]).map(n=>[n.id,n])),edges=new Map();
  const edge=(a,b)=>{if(!edges.has(a))edges.set(a,[]);if(!edges.get(a).includes(b))edges.get(a).push(b);};
  for(const n of nodes.values())for(const dep of n.deps){
   // These branches read different inputs; dormant manual prices or a manual
   // bill must not appear to change automatic token accounting.
   if(n.id==='dailyAPI'&&s.costMode==='manual'&&!['manualDaily','costMode'].includes(dep))continue;
   if(n.id==='dailyAPI'&&s.costMode!=='manual'&&dep==='manualDaily')continue;
   if(n.id==='dailyRounds'&&s.workloadMode==='requests'&&!['requestsPerDay','workloadMode'].includes(dep))continue;
   if(n.id==='dailyRounds'&&s.workloadMode!=='requests'&&dep==='requestsPerDay')continue;
   if(['targetCycle','chosenTP','caps'].includes(n.id)&&dep==='speed'&&r.O===1)continue;
   if(['apiInputPrice','apiOutputPrice'].includes(n.id)&&s.apiUseCatalog!==false&&['apiHit','apiMiss','apiOut'].includes(dep))continue;
   if(n.id==='apiFactor'&&dep==='peakShare'&&!D?.apiPrices?.[s.api]?.peakPricing)continue;
   if(n.id==='apiPriceSource'&&dep==='apiFx'&&D?.apiPrices?.[s.api]?.currency!=='USD')continue;
   edge(dep,n.id);
  }
  const binding=(id,fields)=>{const via='@catalog:'+id;edge(id,via);for(const field of fields)if(field in s)edge(via,field);};
  // Mirrors modelDefaults and the selection-dependent resets in patchState.
  // Precision fallback on model/card changes is conditional, hence the catalog
  // label promises a dependency, never that every switch changes every value.
  const model=D?.models?.[s.model];
  binding('model',[...Object.keys(model&&E?E.modelDefaults(model):{}),'api','apiHit','apiMiss','apiOut','apiUseCatalog','precision','matrixTF']);
  binding('card',['memoryGB','bandwidth','attentionTF','cardWan','platformWan','tdpW','precision','matrixTF']);
  binding('precision',['matrixTF']);
  binding('api',['apiHit','apiMiss','apiOut','apiUseCatalog']);
  function shortest(start,end){
   const queue=[[start]],seen=new Set([start]);
   for(let i=0;i<queue.length;i++){
    const path=queue[i],tail=path[path.length-1];if(tail===end)return path;
    for(const next of edges.get(tail)||[])if(!seen.has(next)){seen.add(next);queue.push([...path,next]);}
   }
   return null;
  }
  const classify=path=>path.some(id=>id.startsWith('@workpoint:'))?'solved-workpoint':path.some(id=>id.startsWith('@catalog:'))?'catalog':path.some(id=>['targetCycle','dailyRounds'].includes(id))?'workload':path.some(id=>configuration.has(id))?'configuration':'formula';
  const toAnswer=r.solve?.answer!==null&&nodes.has('solveAnswer')?shortest(key,'solveAnswer'):null;
  const solved=Array.isArray(r.solvedInputs)?r.solvedInputs:[];
  return terminals.flatMap(id=>{
   const n=nodes.get(id);if(!n)return [];
   if(id==='weight'&&!['model','card','precision','totalB','weightOverhead'].includes(key))return [];
   let path=shortest(key,id);
   // Solver constraints affect the final solved input, which then becomes an
   // input to the final workpoint. Project the two stages without cyclic edges.
   if(toAnswer&&!['responseCheck','solveAnswer'].includes(id))for(const field of solved){
    const after=shortest(field,id);if(!after)continue;
    const candidate=[...toAnswer,'@solved:'+field,'@workpoint:'+field,...after.slice(1)];
    if(!path||candidate.length<path.length)path=candidate;
   }
   return path?[{n,path,kind:classify(path)}]:[];
  });
 }
 const api={project,label};root.InfluencePaths=api;if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
