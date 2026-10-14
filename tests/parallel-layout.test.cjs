'use strict';
const assert=require('node:assert/strict'),D=require('../data'),E=require('../engine-v5'),C=require('../advisor-core'),L=require('../parallel-layout'),S=require('../solver-v5'),P=require('../pricing');
const base=E.defaults(D),state=p=>C.patchState(base,p,D,E),near=(a,b)=>assert.ok(Math.abs(a-b)<1e-9*Math.max(1,Math.abs(b)),`${a} != ${b}`);
let models=0,layouts=0;
for(const m of Object.values(D.models).filter(m=>!m.catalogOnly)){
 const card=E.supported(m,D.cards.h200).length?D.cards.h200:D.cards.b300;
 const s=state({model:m.id,card:card.id,precision:E.supported(m,card)[0],mode:'reverse',servers:16,slots:8,concurrency:23,inputK:1,outputK:.05,ttft:36000,speed:.01});
 const r=E.calculate(s,D,{performanceOnly:true});assert.ok(r.ok,m.id);models++;
 for(const q of r.candidates){
  const w=q.w,ep=r.formulaContext.parallel;
  if(ep){
   assert.equal(ep.experts%q.logicalTP,0);assert.equal(q.logicalTP,q.attentionTP*q.attentionDP);
   assert.ok(L.attentionValid(q.attentionTP,s,m));
   if(ep.outputGroups)assert.equal(ep.outputGroups%q.attentionTP,0);
   near(w.storedWeight,ep.expertWeight+ep.denseWeight*q.attentionDP);
   near(ep.expertWeight+ep.denseWeight,r.weight);near(ep.activeExpertB+ep.activeDenseB,s.activeB);
   assert.equal(w.attentionBatch,Math.ceil(q.B/q.attentionDP));assert.equal(w.cacheBatch,w.attentionBatch*q.attentionDP);
   // Equivalent uniform worst-device memory check, not a pooled capacity test.
   const perRank=ep.expertWeight/q.logicalTP+ep.denseWeight/q.attentionTP+w.attentionBatch*w.kvSession/q.attentionTP;
   near(w.used/q.logicalTP,perRank);
   const expected=s.kvReplication*(m.cacheProfile.latentMQA||r.formulaContext.compressed?q.attentionTP:Math.max(1,q.attentionTP/m.kvHeads));
   near(w.replication,expected);
  }else{assert.equal(q.attentionDP,1);near(w.storedWeight,r.weight);assert.equal(w.cacheBatch,q.B);}
  near(w.used,w.storedWeight+w.cacheBatch*w.kvSession);layouts++;
 }
}
assert.equal(models,Object.values(D.models).filter(m=>!m.catalogOnly).length);assert.ok(layouts>300);
// V4 output groups constrain attention independently of the larger expert pool.
const pro=state({model:'dsv4p',card:'a910c',precision:'fp16',concurrency:20,inputK:128,outputK:10,ttft:30,speed:30});
const a=E.calculate(pro,D),q=a.chosen;assert.ok(a.feasible&&q.logicalTP>q.attentionTP);assert.ok(q.attentionTP<=16);
near(q.w.replication,q.attentionTP);assert.ok(q.w.replication<q.logicalTP);
assert.deepEqual(a.apiBudget,P.budget(pro,D));assert.equal(pro.concurrency,20);
// Fixed-layout input/output searches preserve the two parallel axes.
for(const target of ['input','output','concurrency','throughput']){
 const s=state({model:'qwen35b',card:'h200',mode:'reverse',slots:2,servers:1,concurrency:4,inputK:.2,outputK:.02,ttft:.3,speed:100,responseSlo:1});
 const r=S.solve(s,D,target,{performanceOnly:true});assert.ok(r.feasible,target);
 const replay=E.calculate(r.effectiveState,D,{performanceOnly:true,forceTP:r.chosen.tp,forceAttentionTP:r.chosen.attentionTP,...(target==='output'?{responseSlo:s.responseSlo}:{})});
 assert.ok(replay.feasible);assert.equal(replay.chosen.id,r.chosen.id);
}
// Exhaustively cross-check max throughput around DP integer boundaries.
for(const speed of [30,100,200]){
 const s=state({model:'qwen35b',card:'h200',mode:'reverse',slots:2,concurrency:1,inputK:.1,outputK:.02,ttft:.2,speed});
 const first=E.calculate(s,D,{performanceOnly:true}),upper=Math.max(...first.candidates.map(q=>q.capacity));assert.ok(upper<3000);
 let best=0,N=0;for(let n=1;n<=upper;n++){const r=E.calculate({...s,concurrency:n},D,{performanceOnly:true,objective:'throughput'});if(r.feasible){best=Math.max(best,r.chosen.outputThroughput);N=n;}}
 const max=S.solve(s,D,'throughput',{performanceOnly:true}),cap=S.solve(s,D,'concurrency',{performanceOnly:true});
 assert.ok(N>0&&max.feasible);near(max.solve.answer,best);assert.equal(cap.solve.answer,N);
}
// Replica sizing uses exact quotient intervals, rather than assuming that
// throughput rises monotonically after integer DP/request repartitioning.
const fixed=state({model:'qwen35b',card:'h200',slots:2,concurrency:29,inputK:.1,outputK:.02,ttft:.2,speed:100});
const curve=[];
for(let g=1;g<=fixed.concurrency;g++){
 const r=E.calculate({...fixed,mode:'reverse',servers:g},D,{performanceOnly:true,forceTP:2,forceAttentionTP:1});
 if(r.feasible)curve.push({groups:g,tps:r.chosen.outputThroughput});
}
const ceiling=Math.max(...curve.map(p=>p.tps));
for(const threshold of [ceiling*.5,ceiling*.8,ceiling*.99,ceiling*1.01]){
 const expected=curve.find(p=>p.tps>=threshold)?.groups;
 const r=E.calculate({...fixed,throughput:threshold},D,{performanceOnly:true,forceTP:2,forceAttentionTP:1});
 assert.equal(r.chosen?.groups,expected);
}
console.log(`PASS ${models} models / ${layouts} layouts: expert geometry, per-device storage, Attention limits, KV replication, independent API, reverse replay, exhaustive DP throughput and replica sizing`);
