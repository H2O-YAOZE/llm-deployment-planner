'use strict';
(function(root){
 const E=typeof module!=='undefined'&&module.exports?require('./engine-v5.js'):root.PlanningEngine;
 const MAX_CONCURRENCY=100000,targets={
  concurrency:{name:'最大并发',answer:'同时请求上限',unit:'路',conditions:['inputK','outputK','ttft','speed','throughput'],solved:'concurrency'},
  throughput:{name:'最大总吞吐',answer:'完整工作负载总吞吐',unit:'Token/s',conditions:['inputK','outputK','ttft','speed'],solved:'throughput'},
  speed:{name:'单路速度',answer:'末端单路生成速度',unit:'Token/s/路',conditions:['concurrency','inputK','outputK','ttft','throughput'],solved:'speed'},
  ttft:{name:'首 Token 延迟',answer:'首 Token 延迟',unit:'s',conditions:['concurrency','inputK','outputK','speed','throughput'],solved:'ttft'},
  input:{name:'最大输入',answer:'单路最大输入',unit:'Token',conditions:['concurrency','outputK','ttft','speed','throughput'],solved:'inputK'},
  output:{name:'最大输出',answer:'单路最大输出',unit:'Token',conditions:['concurrency','inputK','ttft','speed','throughput','responseSlo'],solved:'outputK'}
 };
 const metric=(q,s)=>s.throughputMetric==='requests'?q.requestsPerSecond:s.throughputMetric==='decode-output'?q.decodeThroughput:q.outputThroughput;
 function solve(source,data,target='concurrency',policy={}){
  const meta={...targets[target]},state={...source,mode:'reverse',reverseTarget:target};
  const options={performanceOnly:true,singleInstance:policy.singleInstance??(state.topologyMode==='single')};
  const invalid=message=>({ok:false,feasible:false,errors:[message],warnings:[],trace:[],inputs:Object.keys(state),candidates:[],solve:{target,meta,answer:null},effectiveState:state});
  if(!meta.solved)return invalid('求解目标无效');
  if(target==='speed'&&Math.round(state.outputK*1000)===1)return invalid('只输出首Token，没有Decode速度目标；请选择首Token或完整吞吐。');
  let result,answer=null,search=null,alternatives=[];
  const record=(q,value,valid=q.valid)=>({id:q.id,tp:q.tp,attentionTP:q.attentionTP,attentionDP:q.attentionDP,groups:q.groups,servers:q.servers,cards:q.purchasedCards,allocatedCards:q.allocatedCards,perInstance:q.bcap,limits:{memory:q.kvCap,ttft:q.ttftCap,decode:q.decodeCap},value,valid});
  if(target==='speed'||target==='ttft'){
   options.ignoreTargets=[meta.solved];options.objective=target;result=E.calculate(state,data,options);
   if(result.feasible)answer=target==='speed'?result.chosen.w.speed:result.chosen.w.ttft;
   alternatives=result.candidates.map(q=>record(q,target==='speed'?q.w.speed:q.w.ttft));
  }else if(target==='concurrency'||target==='throughput'){
   state.concurrency=1;
   if(target==='throughput'){options.ignoreTargets=['throughput'];options.objective='throughput';meta.unit=state.throughputMetric==='requests'?'请求/s':'Token/s';meta.answer=state.throughputMetric==='requests'?'完整请求总吞吐':state.throughputMetric==='decode-output'?'末端Decode总吞吐':'完整周期总输出吞吐';}
   const first=E.calculate(state,data,{...options,ignoreTargets:['throughput']});
   if(!first.ok)return {...first,solve:{target,meta,answer:null},effectiveState:state,options};
   const probes=[];
   for(const q of first.candidates){
    if(q.capacity<1)continue;
    const upper=Math.min(MAX_CONCURRENCY,q.capacity);
    const boundary=Math.floor(upper/(q.groups*q.attentionDP))*q.groups*q.attentionDP;
    const counts=target==='throughput'?[...new Set([upper,boundary].filter(n=>n>0))]:[upper];
    for(const concurrency of counts){
     const r=E.calculate({...state,concurrency},data,{...options,forceTP:q.tp,forceAttentionTP:q.attentionTP});
     if(r.feasible)probes.push({r,concurrency});
    }
   }
   probes.sort(target==='concurrency'?(a,b)=>b.concurrency-a.concurrency||E.deploymentOrder(a.r.chosen,b.r.chosen,state):(a,b)=>metric(b.r.chosen,state)-metric(a.r.chosen,state)||E.deploymentOrder(a.r.chosen,b.r.chosen,state));
   if(probes.length){result=probes[0].r;state.concurrency=probes[0].concurrency;answer=target==='concurrency'?state.concurrency:metric(result.chosen,state);}
   else result={...first,feasible:false};
   alternatives=first.candidates.map(q=>{
    const tested=probes.filter(p=>p.r.chosen.id===q.id);
    const best=tested[0];
    return best?record(best.r.chosen,target==='concurrency'?best.concurrency:metric(best.r.chosen,state),true):record(q,null,false);
   });
   search={upper:MAX_CONCURRENCY,limitHit:state.concurrency===MAX_CONCURRENCY,method:'合法TP枚举，各实例使用SLO/显存批量上限；均衡分配',fixedContext:true};
   if(target==='throughput'&&state.optimizeContext){
    if(!(state.minInputK>0&&state.minOutputK>0&&state.minInputK<=source.inputK&&state.minOutputK<=state.maxOutputK))return invalid('请填写允许优化的输入下限和输出范围');
    const lo=Math.round(state.minOutputK*1000),hi=Math.round(state.maxOutputK*1000);
    const lengths=hi-lo<=500?Array.from({length:hi-lo+1},(_,i)=>lo+i):[...new Set([lo,hi,...Array.from({length:32},(_,i)=>Math.round(lo*Math.pow(hi/lo,i/31)))])];
    const inputs=[...new Set([state.minInputK,source.inputK])];let best=null;
    for(const inputK of inputs)for(const O of lengths){
     const r=solve({...state,optimizeContext:false,inputK,outputK:O/1000},data,target,{...policy,performanceOnly:true});
     if(r.feasible&&(!best||r.solve.answer>best.solve.answer))best=r;
    }
    if(best){result=best;Object.assign(state,best.effectiveState);answer=best.solve.answer;}
    search={...search,fixedContext:false,exact:hi-lo<=500,sampled:hi-lo>500,evaluations:inputs.length*lengths.length};
    result.warnings.push(hi-lo>500?'上下文优化是有限候选搜索，不是全域最优证明。':'在声明输出整数范围与输入下限/原值候选内搜索。');
   }
  }else{
   const key=meta.solved,other=target==='input'?'outputK':'inputK';state[key]=.001;
   if(target==='output')options.responseSlo=source.responseSlo;
   const first=E.calculate(state,data,{...options,ignoreTargets:['throughput']});
   if(!first.ok)return {...first,solve:{target,meta,answer:null},effectiveState:state,options};
   const m=data.models[state.model],context=state.contextMode==='extended'?m.extendedContextTokens:m.nativeContextTokens;
   const upper=Math.min(10000000,Math.floor(context)-Math.round(state[other]*1000));let best=null,evaluations=0;
   for(const q of first.candidates){
    const read=(n,ignore=true)=>{evaluations++;return E.calculate({...state,[key]:n/1000},data,{...options,forceTP:q.tp,forceAttentionTP:q.attentionTP,ignoreTargets:ignore?['throughput']:[]});};
    let lo=0,hi=Math.max(0,upper);
    while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(read(mid).feasible)lo=mid;else hi=mid-1;}
    if(!lo)continue;let end=lo;
    if(state.throughput>0){
     let start=1;
     if(target==='output'&&state.throughputMetric==='sustained-output'){
      // At fixed TP/B, response(O) is convex: step increments are max of
      // affine compute/memory. O/response(O) has a single peak.
      let a=1,b=end;
      const score=n=>{const r=read(n);return r.chosen?metric(r.chosen,state):0;};
      while(b-a>6){const x=Math.floor(a+(b-a)/3),y=Math.ceil(b-(b-a)/3);if(score(x)<score(y))a=x+1;else b=y-1;}
      start=Array.from({length:b-a+1},(_,i)=>a+i).sort((x,y)=>score(y)-score(x))[0];
     }
     if(!read(start,false).feasible)continue;let a=start,b=end;
     while(a<b){const mid=Math.ceil((a+b)/2);if(read(mid,false).feasible)a=mid;else b=mid-1;}
     end=a;
    }
    const r=read(end,false);if(r.chosen)alternatives.push(record(r.chosen,r.feasible?end:null,r.feasible));if(r.feasible&&(!best||end>best.answer||end===best.answer&&E.deploymentOrder(r.chosen,best.r.chosen,state)<0))best={r,answer:end};
   }
   answer=best?.answer??null;state[key]=(answer??1)/1000;result=best?.r||{...first,feasible:false};
   search={upper,limitHit:answer===upper,evaluations,method:'逐TP整数边界搜索；总输出吞吐先求单峰区间再检查右边界'};
  }
  if(!result.ok||!result.feasible||answer===null)return {...result,solve:{target,meta,answer:null,search},effectiveState:state,options};
  const q=result.chosen,bounds={kv:Math.min(MAX_CONCURRENCY,q.kvCap*q.groups),decode:Math.min(MAX_CONCURRENCY,q.decodeCap*q.groups),prefill:Math.min(MAX_CONCURRENCY,q.ttftCap*q.groups)};
  const deps=target==='concurrency'?['caps','groups']:target==='speed'?['decodeSpeed']:target==='ttft'?['ttftResult']:target==='throughput'?['totalOutputThroughput','totalDecodeThroughput','completedRequests']:['context','used','ttftResult','decodeSpeed',...(target==='output'?['responseCheck']:[])];
  // Nested context searches already have an answer node; keep one final answer
  // using the winning concurrency/context/SLO, without a financial path.
  result={...result,trace:result.trace.filter(n=>n.id!=='solveAnswer')};
  const validDeps=new Set([...result.inputs,...result.trace.map(n=>n.id)]);
  result.trace.push({id:'solveAnswer',title:meta.answer,deps:['reverseTarget',...meta.conditions,...deps].filter(k=>validDeps.has(k)),formula:search?.method||'合法TP枚举，保持其他已知条件',value:answer,unit:meta.unit,note:'有效且满足约束时才输出答案。吞吐优化默认固定输入/输出。'});
  if(['concurrency','speed','ttft','throughput'].includes(target))state[meta.solved]=answer;
  const finalOptions={...options,performanceOnly:true};
  if(policy.now!==undefined)finalOptions.now=policy.now;
  return {...result,solvedInputs:target==='throughput'?['throughput','concurrency']:[meta.solved],solve:{target,meta,answer,bounds,search,alternatives},effectiveState:state,options:finalOptions};
 }
 root.ReverseSolver={solve,targets,MAX_CONCURRENCY};if(typeof module!=='undefined')module.exports=root.ReverseSolver;
})(typeof window==='undefined'?globalThis:window);
