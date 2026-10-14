'use strict';
const assert=require('node:assert/strict');
const D=require('../data'),E=require('../engine-v5'),C=require('../advisor-core'),S=require('../solver-v5');
const state=p=>C.patchState(E.defaults(D),p,D,E);
const request={model:'dsv4f',card:'a910c',precision:'int8',inputK:1000,outputK:1,concurrency:100,ttft:30,speed:50};
const r=E.calculate(state(request),D);
assert.equal(r.ok,true);assert.equal(r.assessment.inputValid,true);
assert.equal(r.assessment.status,'not-found-in-covered-plans');
assert.equal(r.assessment.physicalImpossibilityProven,false);
assert.equal(r.chosen,undefined);assert.equal(r.cost,null);
assert.ok(r.failureReasons.some(x=>x.includes('尚未计算')));
for(const part of r.partialPlans){
 assert.equal(part.complete,false);assert.ok(part.relaxed.includes('ttft'));
 const replay=E.calculate(state(request),D,{performanceOnly:true,ignoreTargets:part.relaxed});
 assert.equal(part.feasible,replay.feasible);
 if(part.feasible){assert.equal(part.cards,replay.chosen.purchasedCards);assert.equal(part.capex,E.procurement(replay.chosen,state(request)));}
}
const invalid=E.calculate(state({...request,inputK:1100}),D);
assert.equal(invalid.ok,false);assert.equal(invalid.assessment.inputValid,false);
assert.ok(invalid.errors.some(x=>x.includes('1101000')&&x.includes('1048576')));
assert.equal(invalid.partialPlans,undefined);
// A failed reverse request must never expose a diagnostic candidate as a plan.
for(const target of ['concurrency','speed','ttft','input','output']){
 const impossible=state({...request,mode:'reverse',servers:1,slots:1});
 const result=S.solve(impossible,D,target);
 assert.equal(result.feasible,false,target);assert.equal(result.chosen,undefined,target);
 assert.equal(result.cost,null,target);assert.equal(result.solve.answer,null,target);
 assert.ok(result.failureReasons.length,target);assert.equal(result.assessment.status,'not-found-in-covered-plans');
}
// The reverse solver must accept the same legacy context fields as the forward engine.
const legacy=structuredClone(D);delete legacy.models.qwen3b8.nativeContextTokens;
legacy.models.qwen3b8.contextTokens=8192;
const lr=S.solve(state({model:'qwen3b8',card:'h200',precision:'bf16',servers:1,slots:8,inputK:1,outputK:1,concurrency:1,ttft:1000,speed:1,responseSlo:1000}),legacy,'input');
assert.equal(lr.feasible,true);assert.equal(lr.solve.answer,7192);
let checked=0;
for(const m of Object.values(D.models).filter(E.canEstimate))for(const card of ['a910c','h200','h20']){
 const c=D.cards[card],precision=E.supported(m,c).find(p=>p==='bf16')||E.supported(m,c)[0];if(!precision)continue;
 for(const inputK of [1,80]){
  const s=state({model:m.id,card,precision,inputK,outputK:1,concurrency:20,ttft:30,speed:30});
  const out=E.calculate(s,D,{performanceOnly:true});
  if(!out.ok){assert.ok(out.errors.length);continue;}
  assert.equal(out.assessment.inputValid,true);
  if(out.feasible){
   const q=out.chosen;assert.ok(q&&q.valid&&q.w.fits&&q.w.ttftOK&&q.w.speedOK);
   assert.equal(q.purchasedCards,q.servers*s.slots);
   assert.equal(q.workloads.reduce((n,v)=>n+v.B*v.count,0),s.concurrency);
   assert.deepEqual(out.failureReasons,[]);
  }else{assert.equal(out.chosen,undefined);assert.ok(out.failureReasons.length);}
  checked++;
 }
}
console.log(`PASS coverage classification, independent partial estimates, invalid context, five failed reverse goals, legacy limits and ${checked} model/hardware workloads`);
