'use strict';
// Balanced EP + attention TP/DP planning, independent of model names and chip IDs.
(function(root){
 function profile(s,m,precision,weight,activeWeight,quantB,nonquantBytes){
  const p=m.parallelProfile;
  if(p?.kind!=='expert-attention'||!p.experts||!p.selectedExperts||!p.expertParamsB)return null;
  const raw=p.expertParamsB*s.layers/m.layers,expertB=Math.min(s.totalB,raw),activeExpertB=Math.min(s.activeB,expertB*p.selectedExperts/p.experts);
  const quantExpert=Math.min(expertB,quantB),expertWeight=(quantExpert*precision.bytes+(expertB-quantExpert)*nonquantBytes)*s.weightOverhead;
  const denseWeight=Math.max(0,weight-expertWeight),activeExpert=activeWeight*(activeExpertB/s.activeB),activeDense=activeWeight-activeExpert;
  return {...p,expertB,activeExpertB,activeDenseB:s.activeB-activeExpertB,expertWeight,denseWeight,activeExpert,activeDense,
    truncated:raw>s.totalB||expertB*p.selectedExperts/p.experts>s.activeB};
 }
 function attentionValid(logical,s,m){
  const p=m.cacheProfile||{},groups=m.parallelProfile?.outputGroups;
  if(logical>s.qHeads||s.qHeads%logical)return false;
  if(groups&&(logical>groups||groups%logical))return false;
  if(m.kvHeads&&(logical<m.kvHeads?m.kvHeads%logical:logical%m.kvHeads))return false;
  if(p.kind==='linear-hybrid'&&[p.linearKeyHeads,p.linearValueHeads].some(h=>!h||h%logical))return false;
  return true;
 }
 function layouts(tp,s,m,card,p){
  const factor=card.logicalDevicesPerModule||1,ranks=tp*factor;
  if(!p)return [{kind:'tensor',tp,logicalTP:ranks,attentionTP:ranks,attentionDP:1,expertParallel:1,attentionCards:tp}];
  if(p.experts%ranks)return [];
  return Array.from({length:Math.min(ranks,s.qHeads,p.outputGroups||s.qHeads)},(_,i)=>i+1)
    .filter(a=>ranks%a===0&&attentionValid(a,s,m))
    .map(a=>({kind:'expert',tp,logicalTP:ranks,attentionTP:a,attentionDP:ranks/a,expertParallel:ranks,attentionCards:a/factor}));
 }
 function settings(layout,B,s,p){
  const eta=Math.pow(1-s.parallelLoss,Math.log2(layout.tp));
  const attentionEta=Math.pow(1-s.parallelLoss,Math.log2(Math.max(1,layout.attentionCards)));
  const attentionBatch=Math.ceil(B/layout.attentionDP),cacheBatch=attentionBatch*layout.attentionDP;
  return {layout,eta,attentionEta,attentionBatch,cacheBatch,
    storedWeight:p?p.expertWeight+p.denseWeight*layout.attentionDP:null,
    matrix:layout.tp*s.matrixTF*1e12*s.mfu*eta,
    attentionMatrix:layout.attentionCards*s.matrixTF*1e12*s.mfu*attentionEta,
    attention:layout.attentionCards*s.attentionTF*1e12*s.attentionMfu*attentionEta,
    bw:layout.tp*s.bandwidth*1e9*s.bwEff*eta,
    attentionBW:layout.attentionCards*s.bandwidth*1e9*s.bwEff*attentionEta};
 }
 const api={profile,attentionValid,layouts,settings};root.ParallelLayout=api;if(typeof module!=='undefined')module.exports=api;
})(typeof window==='undefined'?globalThis:window);
