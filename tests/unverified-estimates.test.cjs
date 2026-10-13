'use strict';
const assert=require('node:assert/strict');
const D=require('../data.js'),E=require('../engine-v5.js'),C=require('../advisor-core.js'),R=require('../solver-v5.js');
for(const mid of ['kimik3','dsv41f'])for(const cid of ['a910c','h200']){
 const model=D.models[mid],card=D.cards[cid];
 assert.equal(E.canEstimate(model),true);
 assert.ok(E.supported(model,card).includes('bf16'));
 const state=C.patchState(E.defaults(D),{model:mid,card:cid,precision:'bf16',inputK:1,outputK:1,concurrency:20,ttft:30,speed:30},D,E);
 const result=E.calculate(state,D);
 assert.equal(result.ok,true,JSON.stringify(result.errors));
 assert.equal(result.feasible,true,mid+'/'+cid);
 assert.ok(result.chosen.purchasedCards>0);
 assert.ok(result.cost.capex>0);
 assert.equal(result.performanceEvidence.referenceOnly,true);
 assert.ok(result.performanceEvidence.reason.includes('误差可能较大'));
 assert.equal(result.deploymentEvidence.status,'planning-unverified');
 const reverse=R.solve({...state,mode:'reverse',servers:result.chosen.servers,slots:8},D,'concurrency');
 assert.equal(reverse.ok,true);assert.equal(reverse.feasible,true);assert.ok(reverse.solve.answer>=20);
 for(const target of ['speed','ttft','input','output']){
  const solved=R.solve({...state,mode:'reverse',servers:result.chosen.servers,slots:8,responseSlo:120},D,target);
  assert.equal(solved.ok,true,mid+'/'+cid+'/'+target+': '+JSON.stringify(solved.errors));
  assert.equal(solved.feasible,true);assert.ok(solved.solve.answer>0);
  assert.equal(solved.performanceEvidence.referenceOnly,true);
 }
 const plan=C.evaluateProposals(E.defaults(D),{model:mid,card:cid,precision:'bf16',inputK:1,outputK:1,concurrency:20,ttft:30,speed:30},new Set(),[],D,E).plans[0];
 assert.equal(plan.allowed,true,JSON.stringify(plan.conflicts));assert.ok(plan.planningNotice.includes('误差可能较大'));
 console.log(mid,cid,result.chosen.purchasedCards+' cards',result.chosen.servers+' servers',result.cost.capex+' CNY; reverse '+reverse.solve.answer);
}
const catalog=C.catalog(D,E);
assert.ok(catalog.paths.some(p=>p.model==='kimik3'&&p.card==='a910c'));
assert.equal(E.canEstimate(D.models.gpt6),false);
const before=E.calculate(E.defaults(D),D);
assert.equal(before.ok,true);assert.equal(before.feasible,true);
for(const m of Object.values(D.models))for(const c of Object.values(D.cards)){
 const evidence=E.estimation(m,c);
 assert.ok(evidence.note);assert.ok(evidence.label.includes('估算'));
}
console.log('PASS shared evidence labels, forward/reverse and advisor estimates; missing parameters remain unknown');
