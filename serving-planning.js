'use strict';
// Published measurements inform a planning allowance; they are not SLO guarantees.
// Keep the measured workload intact. Only its missing per-step time is carried
// to the analytic workload, whose length-dependent costs are still recomputed.
(function(root){
 const cache=new WeakMap();
 function prepare(s,D,E,options={}){
  if(options.runtimePlanning===false)return null;
  const policy=D.performanceBenchmarks?.planningPolicies?.find(p=>p.enabled&&p.modelId===s.model&&p.cardId===s.card&&p.weightPrecision===s.precision);
  if(!policy)return null;
  const m=D.models[s.model],card=D.cards[s.card],native=E.modelDefaults(m);
  // Structure overrides are independent experiments, outside this evidence.
  if(Object.entries(native).some(([k,v])=>s[k]!==v))return null;
  const signature=JSON.stringify([policy.id,E.VERSION]);
  let entries=cache.get(D);if(!entries){entries=new Map();cache.set(D,entries);}
  if(entries.has(signature))return entries.get(signature);
  const samples=[];
  for(const id of policy.anchorIds){
   const b=D.performanceBenchmarks.records.find(r=>r.id===id);
   if(!b||b.modelId!==s.model||b.cardId!==s.card||b.weightPrecision!==s.precision)continue;
   const flags=b.topology.flags.join(' '),dp=Number(flags.match(/--attn-dp-size (\d+)/)?.[1]||1),running=Number(flags.match(/--max-running-requests (\d+)/)?.[1]||Infinity);
   if(b.workload.maxConcurrency>running||!b.workload.inputTokens||!b.workload.outputTokens||b.workload.outputTokens<=1)continue;
   const state={...E.defaults(D),...native,model:s.model,card:s.card,precision:s.precision,mode:'reverse',servers:1,slots:b.topology.physicalGPUCount,
    matrixTF:card.computeTflops[E.precision[s.precision].compute],attentionTF:card.computeTflops.fp16,memoryGB:card.memoryGB,bandwidth:card.bandwidthGBs,
    inputK:b.workload.inputTokens/1000,outputK:b.workload.outputTokens/1000,concurrency:b.workload.maxConcurrency,throughput:0};
   const r=E.calculate(state,D,{runtimePlanning:false,performanceOnly:true,singleInstance:true,forceTP:b.topology.physicalGPUCount,forceAttentionTP:b.topology.physicalGPUCount/dp,ignoreTargets:['ttft','speed']});
   const w=r.chosen?.w;if(!w)continue;
   samples.push({id,batch:state.concurrency,residual:Math.max(0,b.metrics.tpotSeconds-w.decode/(b.workload.outputTokens-1)),source:b.source,
    physicalCards:b.topology.physicalGPUCount,attentionTP:b.topology.physicalGPUCount/dp,inputTokens:b.workload.inputTokens,outputTokens:b.workload.outputTokens,
    observedTPOT:b.metrics.tpotSeconds,analyticMeanStep:w.decode/(b.workload.outputTokens-1)});
  }
  if(samples.length<2)return null;
  const first=samples.find(a=>a.batch===1),fixedSeconds=first?.residual||0;
  // Nonqueued multi-request anchors provide a per-request missing-time slope.
  // Use the larger observed slope across published layouts, rather than granting
  // an unmeasured layout unlimited throughput when the expert union saturates.
  const perRequestSeconds=Math.max(...samples.filter(a=>a.batch>1).map(a=>Math.max(0,a.residual-fixedSeconds)/a.batch));
  const result={id:policy.id,samples,fixedSeconds,perRequestSeconds,referenceCards:samples[0].physicalCards,
   referenceMatrixTF:card.computeTflops[E.precision[s.precision].compute],referenceBandwidth:card.bandwidthGBs,
   referenceMfu:.4,referenceBwEff:.65,referenceParallelLoss:.08,referenceMaxBatch:Math.max(...samples.map(a=>a.batch)),
   method:'nonqueued-p50-residual-planning',guaranteed:false,note:policy.note};
  entries.set(signature,result);return result;
 }
 function allowance(profile,layout,B,s){
  if(!profile)return 0;
  const refEta=Math.pow(1-profile.referenceParallelLoss,Math.log2(profile.referenceCards)),eta=Math.pow(1-s.parallelLoss,Math.log2(layout.tp));
  const computeRatio=profile.referenceCards*profile.referenceMatrixTF*profile.referenceMfu*refEta/(layout.tp*s.matrixTF*s.mfu*eta);
  const bandwidthRatio=profile.referenceCards*profile.referenceBandwidth*profile.referenceBwEff*refEta/(layout.tp*s.bandwidth*s.bwEff*eta);
  return profile.fixedSeconds+profile.perRequestSeconds*B*Math.max(computeRatio,bandwidthRatio);
 }
 const api={prepare,allowance};root.ServingPlanning=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
