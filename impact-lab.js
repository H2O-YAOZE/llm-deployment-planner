'use strict';
(function(root){
 const node=typeof module!=='undefined'&&module.exports,E=node?require('./engine-v5'):root.PlanningEngine,C=node?require('./advisor-core'):root.AdvisorCore;
 const keys=['inputK','outputK','concurrency','ttft','speed','model','precision','card'];
 const variables=['concurrency','inputK','outputK','speed','ttft'];
 const latencyStops=Object.freeze([200,60,30,20,15,10,5,1]);
 const example=D=>C.patchState(E.defaults(D),{model:'dsv4f',card:'h200',precision:'fp8',contextMode:'native',throughput:0,concurrency:20,inputK:80,outputK:1,speed:30,ttft:30},D,E);
 function bounds(s,key,D){
  if(key==='inputK'||key==='outputK'){const m=D.models[s.model],other=key==='inputK'?'outputK':'inputK';return {min:1,max:Math.min(1000,Math.floor(((m.nativeContextTokens??m.contextTokens)-s[other]*1000)/1000*1000)/1000),step:.001};}
  return {concurrency:{min:1,max:1000,step:1},speed:{min:1,max:200,step:1},ttft:{min:1,max:200,step:1}}[key];
 }
 function estimate(reference,key,value,D){
  const state=C.patchState({...reference,mode:'forward',throughput:0},{[key]:value},D,E);
  const result=E.calculate(state,D,{performanceOnly:true}),q=result.feasible?result.chosen:null;
  return {key,state,feasible:!!q,cost:q?E.procurement(q,state):null,cards:q?.purchasedCards??null,servers:q?.servers??null,
   message:!result.ok?result.errors.join('；'):!q?'当前支持的配置未能满足这组要求。':E.procurement(q,state)===null?'缺少报价，暂无法估算费用。':''};
 }
 function experiment(D){
  const reference=example(D),baseline=estimate(reference,'concurrency',reference.concurrency,D);
  // All rows replace one field in this immutable requirements snapshot.
  Object.freeze(reference);
  return {reference,baseline,estimate:(key,value)=>estimate(reference,key,value,D)};
 }
 function compare(reference,key,value,mode,D,cachedBase){
  const state={...reference,mode:'forward',throughput:0},base=cachedBase||{state,result:E.calculate(state,D,{performanceOnly:true})};
  const changed=C.patchState(state,{[key]:value},D,E),q=base.result.chosen;
  let options={performanceOnly:true};
  if(mode==='fixed'&&q){Object.assign(changed,{mode:'reverse',servers:q.servers});options={...options,forceTP:q.tp,forceAttentionTP:q.attentionTP,forceGroups:q.groups};}
  const current={state:changed,result:mode==='fixed'&&!q?base.result:E.calculate(changed,D,options)};
  const a=q,b=current.result.chosen;
  const measurable=r=>r.ok&&r.chosen?.w.fits;
  const metrics=snapshot=>{const r=snapshot.result,x=r.chosen,run=measurable(r);return {budget:r.feasible&&x?E.procurement(x,snapshot.state):null,cards:x?.purchasedCards??null,servers:x?.servers??null,ttft:run?x.w.ttft:null,speed:run?x.w.speed:null,throughput:run?x.outputThroughput:null};};
  const automaticChanges=['model','card','precision'].filter(k=>k!==key&&changed[k]!==state[k]);
  const layoutChanged=!!(a&&b&&(a.id!==b.id||a.groups!==b.groups));
  const failures=[];
  if(b){if(!b.w.fits)failures.push('显存装不下');if(!b.w.ttftOK)failures.push('首 Token 超过要求');if(!b.w.speedOK)failures.push('每路生成速度低于要求');}
  let reason='拖动上方数值，观察变化。';
  if(!base.result.feasible)reason='参考条件未找到满足要求的配置，请先调整参考条件。';
  else if(!current.result.ok)reason=current.result.errors.join('；');
  else if(!b)reason=mode==='fixed'?'原有分组不支持这组模型、精度或硬件条件。':'当前搜索范围没有满足新要求的配置，无法给出费用。';
  else if(mode==='fixed')reason=failures.length?'设备与分组保持不变：'+failures.join('、')+'。':'设备与分组保持不变，修改后仍满足要求。';
  else if(a&&b.purchasedCards===a.purchasedCards)reason=layoutChanged?'卡数不变，系统重新分配了实例。':'卡数和分组不变，当前配置仍能满足要求。';
  else if(a){
   const replay=E.calculate({...changed,mode:'reverse',servers:a.servers},D,{performanceOnly:true,forceTP:a.tp,forceAttentionTP:a.attentionTP,forceGroups:a.groups}),old=replay.chosen;
   const limits=old?[!old.w.fits?'显存':'',!old.w.ttftOK?'首 Token':'',!old.w.speedOK?'每路生成速度':''].filter(Boolean):[];
   reason=b.purchasedCards>a.purchasedCards?(limits.length?'原配置未通过'+limits.join('、')+'要求，需增加设备。':'新条件需要重新选择设备配置。'):'要求改变后，可以用更少设备满足。';
  }
  if(value===state[key]&&base.result.feasible)reason=mode==='fixed'?'原配置已锁定；拖动或输入新值，看哪些要求还能满足。':'拖动或输入新值，看设备与速度怎样变化。';
  return {key,mode,base,current,before:metrics(base),after:metrics(current),layoutChanged,automaticChanges,failures,reason};
 }
 root.ImpactLab={compare,keys,variables,latencyStops,example,bounds,estimate,experiment};if(node)module.exports=root.ImpactLab;
})(typeof window==='undefined'?globalThis:window);
