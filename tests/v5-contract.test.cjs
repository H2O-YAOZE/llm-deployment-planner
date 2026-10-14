'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const D=require('../data'),E=require('../engine-v5'),P=require('../pricing'),S=require('../solver-v5'),C=require('../advisor-core');
const checks=[];let scenarios=0;
const test=(name,fn)=>{fn();checks.push(name);console.log('PASS '+name);};
const near=(a,b,tol=1e-9)=>assert.ok(Math.abs(a-b)<=tol*Math.max(1,Math.abs(b)),`${a} != ${b}`);
const state=(patch={})=>C.patchState(E.defaults(D),patch,D,E);
function dag(r){
 const seen=new Set(r.inputs);for(const n of r.trace){for(const d of n.deps)assert.ok(seen.has(d),n.id+' missing '+d);assert.ok(!seen.has(n.id),'duplicate '+n.id);seen.add(n.id);}
}
function finiteValues(o){if(typeof o==='number')assert.ok(Number.isFinite(o));else if(o&&typeof o==='object')for(const v of Object.values(o))finiteValues(v);}
test('统一目录、70条雷达映射、来源与价格未知值',()=>{
 const canon=JSON.parse(fs.readFileSync(require('node:path').join(__dirname,'../catalog.json'),'utf8'));
 for(const section of ['models','cards','apiPrices'])assert.deepEqual(D[section],canon[section]);
 assert.equal(Object.keys(D.radarAliases).length,70);
 for(const mid of Object.values(D.radarAliases))assert.ok(D.models[mid]);
 const names=new Set();for(const m of Object.values(D.models)){const n=m.name.toLowerCase().replace(/[^a-z0-9]/g,'');assert.ok(!names.has(n),'duplicate '+n);names.add(n);if(!m.catalogOnly){assert.ok(m.cacheProfile);assert.ok(m.verifiedStructure);}}
 for(const a of Object.values(D.apiPrices)){for(const mid of a.modelIds){assert.ok(D.models[mid].apiIds.includes(a.id));}if(a.legacy)assert.equal(a.miss,null);else assert.equal(a.sourceType,'official');}
 assert.equal(D.cards.pro5500.memoryGB,84);assert.equal(D.cards.gb10.bandwidthGBs,273);assert.equal(D.cards.a950pr128.computeTflops.fp16,432);assert.equal(D.cards.a950dt144.specStatus,'official-variants-unmapped');
 assert.equal(D.cards.pro5500.cardPriceWan,null);assert.equal(D.models.qwencoder.kvHeads,8);assert.equal(D.models.glm45.kvHeads,8);assert.equal(D.models.glm52.verifiedStructure.qHeads,64);
});
test('输入输出的KV独立算术与物理/逻辑TP',()=>{
 for(const [mid,expected] of [['qwencoder',8.380416],['glm45',12.435456]]){
  const s=state({model:mid,card:'h200',precision:'bf16',inputK:32,outputK:1,concurrency:1,ttft:100,speed:1});
  const r=E.calculate(s,D,{performanceOnly:true,forceTP:1});assert.ok(r.ok);near(r.kvSession,expected);dag(r);
 }
 let s=state({card:'h200',concurrency:1,ttft:100,speed:1,inputK:1,outputK:.01,mode:'reverse',servers:1,slots:8});
 let a=E.calculate(s,D,{forceTP:1,performanceOnly:true}),b=E.calculate(s,D,{forceTP:16,performanceOnly:true});assert.equal(b.chosen,undefined);
 s={...s,servers:2};b=E.calculate(s,D,{forceTP:16,performanceOnly:true});assert.equal(b.chosen.w.replication,2);near(b.chosen.w.kvSession,2*a.chosen.w.kvSession);
 const c=E.calculate(state({card:'a910c',mode:'reverse',slots:8,concurrency:1,ttft:100,speed:1}),D,{performanceOnly:true});assert.equal(c.candidates.find(q=>q.tp===8).logicalTP,16);
 const hybrid=E.calculate(state({model:'qwen38_27',card:'h200',mode:'reverse',servers:8,slots:8,ttft:1000,speed:1}),D,{performanceOnly:true});assert.ok(hybrid.candidates.every(q=>48%q.logicalTP===0&&16%q.logicalTP===0));
});
test('原生/扩展/API上下文和输出上限分开',()=>{
 const s=state({card:'h200',inputK:40,outputK:1,ttft:100,speed:1});assert.equal(E.calculate(s,D).ok,false);assert.ok(E.calculate({...s,contextMode:'extended'},D).ok);
 const d=structuredClone(D);d.apiPrices.qwen8.maxOutputTokens=10;
 const small=state({card:'h200',inputK:1,outputK:.02,ttft:100,speed:1});const r=E.calculate(small,d);assert.ok(r.ok&&r.feasible);assert.equal(r.cost.apiMonthly,null);assert.ok(r.financeErrors.some(e=>e.includes('最大输出')));
 assert.equal(P.quote({...small,api:'dsFlash'},D,100,400000).ok,false);
 assert.equal(D.models.qwen35b.extendedContextTokens,1010000);assert.ok(D.models.kimik3.catalogOnly);assert.equal(D.models.kimik3.cacheProfile.linearLayers,69);
 const closed=E.calculate(state({model:'gpt6'}),D);assert.equal(closed.ok,false);assert.ok(closed.apiBudget.ok&&closed.apiBudget.monthlyRange.length===2);
 assert.equal(P.budget({...E.defaults(D),usageHours:25},D).ok,false);
});
test('O=1没有Decode；滑窗和线性状态与混合权重独立',()=>{
 const r=E.calculate(state({card:'h200',outputK:.001,speed:100000,ttft:100}),D,{performanceOnly:true});assert.ok(r.feasible);assert.equal(r.chosen.w.decode,0);assert.equal(r.chosen.w.speed,null);assert.ok(r.chosen.proof.decode.inactive);
 assert.equal(S.solve(state({outputK:.001}),D,'speed').solve.answer,null);
 const s=state({model:'gptoss20',card:'h200',precision:'mxfp4',inputK:8,outputK:.01,concurrency:1,ttft:100,speed:1});const a=E.calculate(s,D,{performanceOnly:true});assert.ok(a.ok&&a.feasible);
 const m=D.models.gptoss20,cp=m.cacheProfile;near(a.kvSession,(cp.fullLayers*8010+cp.slidingLayers*cp.slidingWindow)*s.kvWidth*s.kvBytes/1e9);
 const qb=m.precisionProfiles.mxfp4.quantizedParamsB;near(a.weight,(qb*.53125+(m.totalParamsB-qb)*2)*s.weightOverhead);
 const h=state({model:'qwen35b',card:'h200',inputK:8,outputK:.01,concurrency:1,ttft:100,speed:1}),b=E.calculate(h,D,{performanceOnly:true}),c=E.calculate({...h,inputK:16},D,{performanceOnly:true});
 const profile=D.models.qwen35b.cacheProfile;near(c.kvSession-b.kvSession,8000*profile.fullLayers*h.kvWidth*h.kvBytes/1e9);
 assert.equal(E.calculate(state({precision:'fp4'}),D).ok,false);assert.ok(!E.supported(D.models.gptoss20,D.cards.a910c).includes('mxfp4'));
 const n=E.calculate(state({model:'qwen8nvfp4',card:'b300',precision:'nvfp4'}),D,{performanceOnly:true});assert.ok(n.ok&&n.feasible);near(n.weight,6.396932352*1.1);near(n.chosen.w.matrix,n.chosen.tp*13500e12*.4*n.chosen.w.eta);assert.ok(!E.supported(D.models.qwen8nvfp4,D.cards.h200).includes('nvfp4'));
});
test('Roofline分段求和与逐步循环核对500组',()=>{
 let seed=123;const rnd=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32);
 for(let i=0;i<500;i++){const a=rnd()*10,b=rnd(),c=rnd()*10,d=rnd(),lo=1,hi=50;let expected=0;for(let x=lo;x<=hi;x++)expected+=Math.max(a+b*x,c+d*x);near(E.sumRoofline(a,b,c,d,lo,hi),expected);}
 const r=E.calculate(state({model:'gptoss20',card:'h200',inputK:.08,outputK:.12,ttft:100,speed:1,concurrency:3}),D,{performanceOnly:true});const w=r.chosen.w,W=D.models.gptoss20.cacheProfile.slidingWindow;
 let seconds=0;for(let x=r.I+1;x<=r.I+r.O-1;x++)seconds+=Math.max(w.ca+w.cb*x+w.cs*Math.min(x,W),w.ma+w.mb*x+w.ms*Math.min(x,W))+.0002;
 near(w.decode,seconds);dag(r);
});
test('单价档、币种、峰谷、缓存规则与未知价格',()=>{
 const s=E.defaults(D);assert.equal(P.defaultApi(s.model,D),'qwen8');assert.equal(P.quote(s,D,8000,1000).prices.miss,.5);
 let q=P.quote({...s,model:'grok47',api:'grok47',apiFx:8},D,1000,1000);assert.equal(q.prices.miss,16);assert.equal(q.prices.out,48);assert.ok(q.matched);
 assert.equal(P.quote({...s,api:'dsFlash',peakShare:.25},D,1000,1000).inputPrice,1.25);
 q=P.quote({...s,api:'qwen35b'},D,128500,1000);assert.equal(q.ok,false);q=P.quote({...s,api:'qwen35b'},D,140000,1000);assert.equal(q.prices.miss,1.6);
 q=P.quote({...s,api:'opus55',apiFx:1,apiCache:.5,cacheWriteShare:.2},D,1000,1000);near(q.inputPrice,4*.3+.2*.5+5*.2);
 q=P.quote({...s,api:'kimiK3',apiCache:0,cacheWriteShare:.2},D,1000,1000);near(q.inputPrice,20+.2*20);
 assert.equal(P.quote({...s,api:'gemini38'},D,1000,1000,Date.parse('2027-01-02')).ok,false);
 assert.ok(P.quote({...s,api:'gpt6'},D,1000,1000).priceRange);assert.ok(!P.quote({...s,api:'gpt6'},D,1000,1000).completePrice);
 assert.equal(P.quote({...s,api:'qwen8',apiCache:.2},D,1000,1000).ok,false);
 const local=E.calculate({...state({card:'h200'}),cardWan:null,api:''},D);assert.ok(local.ok&&local.feasible);assert.equal(local.cost.capex,null);assert.equal(local.cost.apiMonthly,null);assert.ok(!local.costStatus.comparable);dag(local);
 const noApi=E.calculate({...state({card:'h200'}),api:'grok47'},D);assert.ok(!noApi.costStatus.matched&&!noApi.costStatus.comparable);
 const invalid=E.calculate({...state({card:'h200'}),powerHours:25},D);assert.equal(invalid.cost.capex,null);
 for(const key of ['cardWan','platformWan','hostW','tdpW','electricity','maintenance','powerHours','pue','days','years']){
  const unknown=E.calculate({...state({card:'h200'}),[key]:NaN},D);assert.ok(unknown.ok&&unknown.feasible);assert.equal(unknown.cost.capex,null);assert.equal(unknown.cost.payback,null);finiteValues(unknown.cost);
 }
});
test('最大并发/总吞吐与固定硬件穷举交叉核对',()=>{
 const s=state({card:'h200',mode:'reverse',servers:1,slots:2,inputK:1,outputK:.03,ttft:1,speed:100});
 const first=E.calculate({...s,concurrency:1},D,{performanceOnly:true});const max=Math.max(...first.candidates.map(q=>q.capacity));assert.ok(max<3000);
 let bestN=0,bestTPS=0;for(let N=1;N<=max;N++){const r=E.calculate({...s,concurrency:N},D,{performanceOnly:true,objective:'throughput'});if(r.feasible){bestN=N;bestTPS=Math.max(bestTPS,r.chosen.outputThroughput);}}
 const c=S.solve(s,D,'concurrency'),t=S.solve(s,D,'throughput');assert.equal(c.solve.answer,bestN);near(t.solve.answer,bestTPS);assert.equal(t.effectiveState.inputK,s.inputK);assert.equal(t.effectiveState.outputK,s.outputK);dag(c);dag(t);
 assert.equal(S.solve({...s,inputK:NaN},D,'concurrency').solve.answer,null);
 assert.equal(c.effectiveState.concurrency,c.solve.answer);assert.deepEqual(c.solvedInputs,['concurrency']);
 near(t.effectiveState.throughput,t.solve.answer);assert.deepEqual(t.solvedInputs,['throughput','concurrency']);
 const req={...Object.fromEntries(['model','card','precision','mode','servers','slots','concurrency','inputK','outputK','ttft','speed'].map(k=>[k,s[k]])),reverseTarget:'concurrency',task:'文档问答',modality:'text'};
 const locked=C.evaluateProposals(s,req,new Set(['concurrency']),[],D,E);assert.equal(locked.plans.length,1);assert.equal(locked.plans[0].allowed,false);assert.ok(locked.plans[0].conflicts.some(x=>x.includes('锁定条件：concurrency')));
 const unlocked=C.evaluateProposals(s,req,new Set(['inputK','outputK']),[],D,E);assert.equal(unlocked.plans[0].allowed,true);
 for(const target of ['speed','ttft']){
  const solved=S.solve(s,D,target);assert.ok(solved.feasible);near(solved.effectiveState[target],solved.solve.answer);
  assert.deepEqual(solved.solvedInputs,[target]);assert.equal(solved.effectiveState.concurrency,s.concurrency);
 }
});
test('最大输出加吞吐下限的非前缀可行区间',()=>{
 const d=structuredClone(D);d.models.qwen3b8.nativeContextTokens=250;
 const s=state({card:'h200',mode:'reverse',slots:1,concurrency:1,inputK:.02,outputK:.02,ttft:100,speed:1,responseSlo:100,throughput:50});
 let expected=null;for(let O=1;O<=230;O++){const r=E.calculate({...s,outputK:O/1000},d,{performanceOnly:true,responseSlo:100});if(r.feasible)expected=O;}
 const r=S.solve(s,d,'output');assert.equal(r.solve.answer,expected);if(r.feasible)dag(r);
});
test('正向吞吐要求会增加实例；价格缺失不改变资源',()=>{
 const s=state({card:'h200',concurrency:16,ttft:100,speed:1,inputK:8,outputK:1});const a=E.calculate(s,D),b=E.calculate({...s,throughput:a.chosen.outputThroughput*1.3},D);
 assert.ok(b.feasible);assert.ok(b.chosen.outputThroughput>=a.chosen.outputThroughput*1.3);assert.ok(b.chosen.groups>a.chosen.groups||b.chosen.tp>a.chosen.tp);
 const c=E.calculate({...s,api:'',cardWan:null},D);assert.equal(c.chosen.activeCards,a.chosen.activeCards);
 const changed=C.patchState(s,{model:'gptoss20'},D,E);assert.equal(changed.api,'');assert.equal(changed.apiMiss,null);
});
test('输入、输出、并发、精度算力与SLO的固定拓扑变化300组',()=>{
 let seed=73;const rnd=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32);
 for(let i=0;i<300;i++){
  const model=['qwen3b8','qwencoder','glm45','gptoss20','qwen35b','dsr1'][i%6];
  const s=state({model,card:'h200',mode:'reverse',concurrency:Math.ceil(rnd()*16),inputK:.05+rnd()*8,outputK:.01+rnd(),ttft:30,speed:5});
  const options={performanceOnly:true,forceTP:1},a=E.calculate(s,D,options),b=E.calculate({...s,inputK:s.inputK*2},D,options),c=E.calculate({...s,outputK:s.outputK*2},D,options),d=E.calculate({...s,concurrency:s.concurrency*2},D,options),e=E.calculate({...s,matrixTF:s.matrixTF*2,attentionTF:s.attentionTF*2},D,options);
  for(const r of [a,b,c,d,e]){r.probe=r.chosen||r.diagnosticCandidate;assert.ok(r.ok&&r.probe);if(!r.feasible)assert.equal(r.diagnosticCandidate,r.chosen);}
  assert.ok(b.probe.w.used>=a.probe.w.used&&b.probe.w.ttft>=a.probe.w.ttft&&b.probe.w.speed<=a.probe.w.speed);
  assert.ok(c.probe.w.used>=a.probe.w.used&&c.probe.w.response>=a.probe.w.response);near(c.probe.w.ttft,a.probe.w.ttft);
  assert.ok(d.probe.w.used>=a.probe.w.used&&d.probe.w.ttft>=a.probe.w.ttft);
  assert.ok(e.probe.w.ttft<=a.probe.w.ttft&&e.probe.w.speed>=a.probe.w.speed);
  const tight=E.calculate({...s,ttft:s.ttft/2,speed:s.speed*2},D,options);assert.ok(tight.candidates[0].bcap<=a.candidates[0].bcap);
 }
});
test('模型/芯片/精度/输入/输出/SLO组合的有效性与DAG',()=>{
 for(const m of Object.values(D.models))for(const c of Object.values(D.cards))for(const p of ['bf16','fp8','int8','int4','mxfp4','nvfp4']){
  const s=state({model:m.id,card:c.id,precision:p,inputK:1,outputK:.016,concurrency:3,ttft:30,speed:5});
  const r=E.calculate(s,D);scenarios++;finiteValues(r);if(r.ok)dag(r);
  if(!E.canEstimate(m)||!E.supported(m,c).includes(s.precision))assert.equal(r.ok,false);
  if(s.precision!==p){assert.equal(p,'int8');assert.equal(s.precision,'int8ref');assert.equal(E.precision[p].bytes,E.precision[s.precision].bytes);assert.equal(E.precision[p].compute,E.precision[s.precision].compute);}
 }
});
fs.writeFileSync(require('node:path').join(__dirname,'v5-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,scenarios},null,2));
console.log(`PASS ${checks.length} groups; ${scenarios} combinations`);
