'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const D=require('../data'),E=require('../engine-v5'),C=require('../advisor-core');
const checks=[];let combinations=0,referencePaths=0,readyReferencePaths=0;
const test=(name,run)=>{run();checks.push(name);console.log('PASS '+name);};
const request=(model,card,precision='int8')=>({model,card,precision,concurrency:2,inputK:1,outputK:.016,ttft:1000,speed:1});
const matrix=C.catalog(D,E),paths=new Map(matrix.paths.map(p=>[p.model+'/'+p.card,p]));
const positive=n=>typeof n==='number'&&Number.isFinite(n)&&n>0;

test('全模型芯片精度：目录、选择、估算与未知值保持一致',()=>{
 for(const m of Object.values(D.models))for(const c of Object.values(D.cards)){
  const supported=E.supported(m,c),catalogPath=paths.get(m.id+'/'+c.id);
  for(const precision of Object.keys(E.precision)){
   combinations++;
   const r=request(m.id,c.id,precision),snapshot=structuredClone(r),s=C.patchState(E.defaults(D),r,D,E);
   const isInt8=['int8','int8ref'].includes(precision);
   const effective=isInt8&&supported.includes('int8')?'int8':isInt8&&supported.includes('int8ref')?'int8ref':precision;
   assert.equal(s.precision,effective);assert.deepEqual(r,snapshot);
   for(const k of ['model','card','concurrency','inputK','outputK','ttft','speed'])assert.equal(s[k],r[k]);
   const available=supported.includes(effective);
   const ready=available&&[c.memoryGB,c.bandwidthGBs,c.computeTflops?.[E.precision[effective].compute],c.computeTflops?.fp16].every(positive);
   const issue=C.selectionIssue(r,D,E);
   if(!m.catalogOnly)assert.equal(!issue,ready,m.id+'/'+c.id+'/'+precision);
   const canonical=precision==='int8ref'?'int8':precision;
   if(precision!=='int8ref')assert.equal(catalogPath?.precisions.includes(canonical)||false,ready,m.id+'/'+c.id+'/'+precision+' catalog');
   else if(ready)assert.ok(catalogPath?.precisions.includes('int8'));
   if(!m.catalogOnly&&available){
    const out=E.calculate(s,D,{performanceOnly:true,forceTP:1});
    assert.equal(out.ok,ready,JSON.stringify({model:m.id,card:c.id,precision,errors:out.errors}));
    if(out.ok)assert.ok(Number.isFinite(out.weight));
   }
  }
  if(supported.includes('int8ref')){
   referencePaths++;assert.ok(!supported.includes('int8'));assert.ok(!c.blockedPrecisions?.includes('int8'));
   if(catalogPath?.planningPrecisions.includes('int8'))readyReferencePaths++;
  }
 }
});
test('INT8规划不依赖芯片ID，显式需求与反向锁定保持一致',()=>{
 for(const [model,card]of [['dsv4p','a910c'],['dsv4p','a910b3'],['qwen35b','h200'],['qwen35b','a950pr128'],['gptoss20','b300']]){
  const r=request(model,card),snapshot=structuredClone(r),locks=new Set(Object.keys(r));
  const plan=C.evaluateProposals(E.defaults(D),r,locks,[],D,E).plans[0];
  assert.ok(plan.allowed,JSON.stringify(plan.conflicts));assert.ok(plan.planningPrecision);assert.ok(plan.planningNotice.includes('适配尚待核实'));
  assert.equal(plan.precision,'int8');assert.equal(plan.state.precision,'int8ref');assert.equal(plan.selectionChanges.length,0);
  assert.equal(plan.state.matrixTF,D.cards[card].computeTflops.int8);assert.equal(plan.state.attentionTF,D.cards[card].computeTflops.fp16);
  assert.equal(plan.result.weight,D.models[model].totalParamsB*1.1);assert.deepEqual(r,snapshot);
  const denied=C.evaluateProposals(E.defaults(D),{...r,precision:'bf16'},new Set(),[{model,card,precision:'int8',kind:'standard',adjustments:{}}],D,E).plans.find(p=>p.precision==='int8');
  assert.equal(denied.allowed,false);assert.ok(denied.conflicts.some(s=>s.includes('不作为自动推荐')));
 }
 const r={...request('qwen35b','h200'),mode:'reverse',reverseTarget:'concurrency',servers:1,slots:2};
 const p=C.evaluateProposals(E.defaults(D),r,new Set(['model','card','precision','inputK','outputK','speed','ttft']),[],D,E).plans[0];
 assert.ok(p.allowed,JSON.stringify(p.conflicts));assert.equal(p.result.effectiveState.precision,'int8ref');
});
test('原生与已记录路径不降级为参考量化',()=>{
 for(const [model,card]of [['qwen3b8','h200'],['dsv4f','a910c'],['glm52','a910c']]){
  const r=request(model,card),p=C.precisionPath(r,D,E);
  assert.equal(p.effective,'int8');assert.equal(p.planning,false);
  assert.equal(C.patchState(E.defaults(D),r,D,E).precision,'int8');
 }
 // An adopted reference path must keep INT8 when switching to a recorded
 // path. Switching back must not silently replace it with FP16 either.
 const base=C.patchState(E.defaults(D),request('dsv4p','a910c'),D,E);
 const recorded=C.patchState(base,{model:'dsv4f'},D,E);
 assert.equal(recorded.precision,'int8');assert.equal(recorded.matrixTF,D.cards.a910c.computeTflops.int8);
 const reference=C.patchState(recorded,{model:'dsv4p'},D,E);
 assert.equal(reference.precision,'int8ref');assert.equal(reference.matrixTF,D.cards.a910c.computeTflops.int8);
 const explicitAlias=C.patchState(E.defaults(D),request('qwen3b8','h200','int8ref'),D,E);
 assert.equal(explicitAlias.precision,'int8');
});
test('禁用精度、缺失峰值与FP4格式边界不能被参考别名绕过',()=>{
 const m=D.models.qwen35b,c=D.cards.h200;
 assert.ok(!E.supported(m,{...c,id:'another-known-chip',blockedPrecisions:['int8']}).includes('int8ref'));
 assert.ok(E.supported(m,{...c,id:'another-known-chip'}).includes('int8ref'));
 assert.ok(!E.supported(m,{...c,precisions:['BF16']}).includes('int8ref'));
 assert.ok(!E.supported(D.models.qwen8nvfp4,c).includes('int8ref'));
 for(const card of ['h20','a910b2']){
  assert.equal(D.cards[card].computeTflops.int8,undefined);
  assert.ok(E.supported(m,D.cards[card]).includes('int8ref'));
  assert.ok(C.selectionIssue(request(m.id,card),D,E).includes('矩阵算力'));
  const s=C.patchState(E.defaults(D),request(m.id,card),D,E);
  assert.equal(s.matrixTF,0);assert.equal(E.calculate(s,D,{performanceOnly:true}).ok,false);
  assert.ok(E.calculate({...s,matrixTF:100},D,{performanceOnly:true,forceTP:1}).ok);
 }
 assert.ok(!E.supported(D.models.dsv4p,D.cards.a910c).includes('fp8'));
 for(const c of Object.values(D.cards))assert.ok(!E.supported(D.models.dsv4p,c).includes('fp4'));
 assert.ok(!E.supported(D.models.qwen8nvfp4,D.cards.h200).includes('nvfp4'));
 assert.ok(!E.supported(D.models.gptoss20,D.cards.a910c).includes('mxfp4'));
});
test('未知算力/带宽不进入问答默认推荐，工作台仍可补充规格试算',()=>{
 for(const card of ['pro6000','r5090','pro6000server','pro5500','gb10','k100']){
  assert.ok(!matrix.paths.some(p=>p.card===card));
  const r=request('qwen35b',card,card==='gb10'?'bf16':'int8');
  assert.ok(C.selectionIssue(r,D,E).includes('缺少'));
  const out=C.evaluateProposals(E.defaults(D),r,new Set(),[],D,E).plans[0];assert.equal(out.allowed,false);assert.ok(out.conflicts.some(x=>x.includes('缺少')));
 }
 const s=C.patchState(E.defaults(D),request('qwen35b','r5090'),D,E);
 assert.equal(s.matrixTF,0);assert.equal(s.attentionTF,0);
 const explicit={...s,matrixTF:100,attentionTF:50};
 assert.ok(E.calculate(explicit,D,{performanceOnly:true,forceTP:1}).ok);
});
fs.writeFileSync(path.join(__dirname,'precision-capability-results.json'),JSON.stringify({checkedAt:new Date().toISOString(),checks,combinations,referencePaths,readyReferencePaths},null,2));
console.log(`PASS ${checks.length} groups; ${combinations} combinations; ${readyReferencePaths}/${referencePaths} ready/reference INT8 paths`);
