'use strict';
(function(root){
  const E=typeof module!=='undefined'&&module.exports?require('./engine-v4.js'):root.PlanningEngine;
  const MAX_CONCURRENCY=100000;
  const targets={
    concurrency:{name:'最大并发',answer:'同时请求上限',unit:'路',conditions:['inputK','outputK','ttft','speed'],solved:'concurrency'},
    speed:{name:'单路速度',answer:'末端单路生成速度',unit:'Token/s/路',conditions:['concurrency','inputK','outputK'],solved:'speed'},
    ttft:{name:'首 Token 延迟',answer:'首 Token 延迟',unit:'s',conditions:['concurrency','inputK','outputK'],solved:'ttft'},
    input:{name:'最大输入',answer:'单路最大输入',unit:'Token',conditions:['concurrency','outputK','ttft','speed'],solved:'inputK'},
    output:{name:'最大输出',answer:'单路最大输出',unit:'Token',conditions:['concurrency','inputK','ttft','speed','responseSlo'],solved:'outputK'}
  };
  function solve(source,data,target='concurrency',policy={}) {
    const meta=targets[target];
    if(!meta)return {ok:false,errors:['求解目标无效'],warnings:[],trace:[]};
    const state={...source,mode:'reverse'},options={performanceOnly:true,singleInstance:policy.singleInstance===true};
    let result,answer=null,search=null;
    if(target==='speed'||target==='ttft') {
      options.ignoreTargets=['ttft','speed'];options.objective=target;
      result=E.calculate(state,data,options);
      if(result.feasible)answer=target==='speed'?result.chosen.w.speed:result.chosen.w.ttft;
    } else if(target==='concurrency') {
      state.concurrency=1;
      const first=E.calculate(state,data,options);
      if(!first.ok)return {...first,solve:{target,meta,answer:null},effectiveState:state};
      const max=Math.max(0,...first.candidates.map(q=>q.groups?q.capacity:0));
      answer=Math.min(MAX_CONCURRENCY,max);
      state.concurrency=Math.max(1,answer);
      result=E.calculate(state,data,options);
      search={lower:answer,upper:MAX_CONCURRENCY,limitHit:answer===MAX_CONCURRENCY};
      if(!answer)result.feasible=false;
    } else {
      const key=meta.solved,other=target==='input'?'outputK':'inputK';
      state[key]=.001;
      if(target==='output')options.responseSlo=source.responseSlo;
      const first=E.calculate(state,data,options);
      if(!first.ok)return {...first,solve:{target,meta,answer:null},effectiveState:state};
      const upper=Math.min(10000000,Math.floor(data.models[state.model].contextK*1000)-Math.round(state[other]*1000));
      let lo=0,hi=Math.max(0,upper),evaluations=0;
      // All constraints are monotone in I or O at a fixed topology; the union
      // over valid TP choices is also monotone. Search integer Token counts.
      while(lo<hi){const mid=Math.ceil((lo+hi)/2);state[key]=mid/1000;const r=E.calculate(state,data,options);evaluations++;if(r.ok&&r.feasible)lo=mid;else hi=mid-1;}
      answer=lo;state[key]=Math.max(1,lo)/1000;result=E.calculate(state,data,options);
      search={lower:lo,upper,limitHit:lo===upper,evaluations};
      if(!lo)result.feasible=false;
      if(lo>0&&lo<upper){const next=E.calculate({...state,[key]:(lo+1)/1000},data,options);search.nextFeasible=!!next.feasible;}
    }
    const q=result.chosen;
    const bounds=q?{kv:Math.min(MAX_CONCURRENCY,q.kvCap*q.groups),decode:Math.min(MAX_CONCURRENCY,q.decodeCap*q.groups),prefill:Math.min(MAX_CONCURRENCY,q.ttftCap*q.groups)}:null;
    const deps=target==='concurrency'?['caps','groups']:target==='speed'?['decodeSpeed']:target==='ttft'?['ttftResult']:['context','used','ttftResult','decodeSpeed',...(target==='output'?['responseCheck']:[])];
    const formula=target==='concurrency'&&bounds?`min(KV ${bounds.kv}, Decode ${bounds.decode}, Prefill ${bounds.prefill})`:
      target==='speed'?'枚举可部署 TP，选择实际批量下末端速度最高者':
      target==='ttft'?'枚举可部署 TP，选择实际批量下首 Token 延迟最小者':
      `在 1…${search?.upper||0} Token 内二分搜索最大可行值；${search?.limitHit?'到达原生上下文/搜索上限':`下一 Token 检查：${search?.nextFeasible?'仍可行':'不满足约束'}`}`;
    result.trace.push({id:'solveAnswer',title:meta.answer,deps:['reverseTarget',...meta.conditions,...deps],formula,value:result.feasible?answer:0,unit:meta.unit,note:result.feasible?'使用本页同一组 Attention、KV 与时间方程。所求值不作为输入条件。':'该配置不满足当前条件，请调整设备或目标。'});
    return {...result,solve:{target,meta,answer:result.feasible?answer:0,bounds,search},effectiveState:state,options};
  }
  root.ReverseSolver={solve,targets,MAX_CONCURRENCY};
  if(typeof module!=='undefined')module.exports=root.ReverseSolver;
})(typeof window==='undefined'?globalThis:window);
