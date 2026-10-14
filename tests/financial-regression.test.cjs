'use strict';
const assert=require('node:assert/strict');
const D=require('../data'),E=require('../engine-v5'),P=require('../pricing'),S=require('../solver-v5'),C=require('../advisor-core');
const state=patch=>C.patchState(E.defaults(D),patch,D,E);
const near=(a,b)=>assert.ok(Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const checks=[];
function test(name,fn){fn();checks.push(name);console.log('PASS '+name);}
function dag(r){const seen=new Set(r.inputs);for(const n of r.trace){assert.ok(!seen.has(n.id),'duplicate '+n.id);for(const k of n.deps)assert.ok(seen.has(k),`${n.id} missing ${k}`);seen.add(n.id);}}
function countBudgets(fn){const original=P.budget;let calls=0;P.budget=(...args)=>{calls++;return original(...args);};try{return {result:fn(),calls};}finally{P.budget=original;}}

test('infeasible forward hardware retains independent API budget',()=>{
 const s={...E.defaults(D),ttft:.001},r=E.calculate(s,D);
 assert.equal(r.ok,true);assert.equal(r.feasible,false);assert.equal(r.chosen,undefined);assert.equal(r.cost,null);
 assert.equal(r.apiBudget.ok,true);near(r.apiBudget.monthly,P.budget(s,D).monthly);
 assert.equal(E.calculate(s,D,{performanceOnly:true}).apiBudget,undefined);dag(r);
});

const reverse=state({mode:'reverse',card:'h200',servers:1,slots:2,inputK:.5,outputK:.02,concurrency:4,ttft:1,speed:30,responseSlo:3});
test('all reverse goals solve hardware capacity without API or finance',()=>{
 for(const target of ['concurrency','speed','ttft','input','output','throughput']){
  const {result:r,calls}=countBudgets(()=>S.solve(reverse,D,target));
  assert.ok(r.ok&&r.feasible,target);assert.equal(calls,0,target+' must not price API');assert.equal(r.cost,null);assert.ok(!r.apiBudget);
  assert.equal(r.options.performanceOnly,true);const s=r.effectiveState;
  if(target==='input')assert.equal(r.I,r.solve.answer);else if(target==='output')assert.equal(r.O,r.solve.answer);else assert.equal(s[r.solve.meta.solved],r.solve.answer);
  assert.ok(!r.trace.some(n=>/api|daily|capex|localMonthly|depreciation|saving|payback/i.test(n.id)));
  assert.equal(r.trace.filter(n=>n.id==='solveAnswer').length,1);dag(r);
  const perf=S.solve(reverse,D,target,{performanceOnly:true});assert.equal(perf.cost,null);assert.equal(perf.solve.answer,r.solve.answer);near(perf.chosen.w.response,r.chosen.w.response);
 }
});

test('nested reverse context search keeps one answer and never prices API',()=>{
 const s={...reverse,optimizeContext:true,minInputK:.25,minOutputK:.002,maxOutputK:.005};
 const {result:r,calls}=countBudgets(()=>S.solve(s,D,'throughput'));
 assert.ok(r.feasible);assert.equal(calls,0);assert.equal(r.trace.filter(n=>n.id==='solveAnswer').length,1);assert.equal(r.trace.filter(n=>n.id==='capex').length,0);assert.equal(r.cost,null);dag(r);
});

test('all reverse targets ignore stale API bills, prices and local quotes',()=>{
 for(const target of ['concurrency','speed','ttft','input','output','throughput']){
  const a=S.solve(reverse,D,target),{result:b,calls}=countBudgets(()=>S.solve({...reverse,costMode:'manual',manualDaily:NaN,api:'invalid',apiFx:NaN,apiOut:NaN,cardWan:null,powerHours:NaN},D,target));
  assert.ok(b.feasible);assert.equal(calls,0);assert.equal(b.cost,null);assert.equal(b.solve.answer,a.solve.answer);assert.deepEqual(b.chosen,a.chosen);dag(b);
 }
 const invalid={...reverse,model:'gpt6'},out=countBudgets(()=>E.calculate(invalid,D));assert.equal(out.calls,0);assert.equal(out.result.ok,false);assert.ok(!out.result.apiBudget);
 const impossible=C.patchState(reverse,{model:'dsv4p',card:'h20',precision:'fp8',servers:1,slots:1},D,E);
 const noCapacity=countBudgets(()=>S.solve(impossible,D,'concurrency'));
 assert.equal(noCapacity.result.feasible,false);assert.equal(noCapacity.calls,0);assert.ok(!noCapacity.result.apiBudget);
});

function rangeFixture(){
 const data=structuredClone(D),a=data.apiPrices.gpt6;
 Object.assign(a,{native:{miss:2,hit:.5,out:5},longContextPrices:{miss:4,hit:1,out:10,write:6},longContextThreshold:null,cacheWrite:{fiveMinutes:3},cacheWriteBilling:'replacement',peakPricing:true,cacheStoragePerMTokenHour:2});
 const s=state({model:'gpt6',api:'gpt6',apiFx:2,inputK:1,outputK:.1,workloadMode:'requests',requestsPerDay:1000,apiCache:.25,cacheWriteShare:.2,peakShare:.5,cacheStorageMTokHours:3});
 return {data,s};
}
test('auto price range equals explicit bands including cache writes, peak, FX and storage',()=>{
 const {data,s}=rangeFixture(),automatic=P.budget({...s,apiContextBand:'auto'},data),short=P.budget({...s,apiContextBand:'short'},data),long=P.budget({...s,apiContextBand:'long'},data);
 assert.ok(automatic.ok&&short.ok&&long.ok);assert.equal(automatic.monthly,null);
 near(short.quote.inputPrice,5.475);near(long.quote.inputPrice,10.95);
 near(short.monthly,(5.475+1.5+12)*30);near(long.monthly,(10.95+3+12)*30);
 near(automatic.monthlyRange[0],short.monthly);near(automatic.monthlyRange[1],long.monthly);
 data.apiPrices.gpt6.cacheWriteBilling='separate';
 const separate=P.budget({...s,apiContextBand:'auto'},data);
 near(separate.monthlyRange[0],P.budget({...s,apiContextBand:'short'},data).monthly);
 near(separate.monthlyRange[1],P.budget({...s,apiContextBand:'long'},data).monthly);
});

test('unknown range-band cache tariffs do not become free or borrow the short tariff',()=>{
 let {data,s}=rangeFixture();delete data.apiPrices.gpt6.longContextPrices.hit;
 let r=P.budget({...s,apiContextBand:'auto'},data);assert.equal(r.ok,false);assert.equal(r.monthlyRange,null);assert.ok(r.errors.some(e=>e.includes('long档')&&e.includes('缓存命中')));
 ({data,s}=rangeFixture());delete data.apiPrices.gpt6.longContextPrices.write;
 r=P.budget({...s,apiContextBand:'auto'},data);assert.equal(r.ok,false);assert.equal(r.monthlyRange,null);assert.ok(r.errors.some(e=>e.includes('long档')&&e.includes('缓存写入')));
});

console.log(`PASS ${checks.length} financial regression groups`);
