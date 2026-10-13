'use strict';
(function(root){
 const node=typeof module!=='undefined'&&module.exports;
 const E=node?require('./engine-v5'):root.PlanningEngine,D=node?require('./data'):root.AppData,C=node?require('./advisor-core'):root.AdvisorCore,S=node?require('./solver-v5'):root.ReverseSolver;
 if(node){require('./calculation-explain');require('./calculation-v5-ui');}
 const X=root.CalculationExplain;
 const preset={model:'dsv4p',card:'h20',precision:'fp8',slots:1,concurrency:20,inputK:128,outputK:2,ttft:30,speed:30,mode:'forward'};
 const constraints=[['memory','只检查装载与并发',['ttft','speed','throughput']],['prefill','显存与首 Token',['speed','throughput']],['decode','显存与生成速度',['ttft','throughput']]];
 function initial(patch=preset){return C.patchState(E.defaults(D),patch,D,E);}
 function build(state){
  const s=structuredClone(state),final=s.mode==='reverse'?S.solve(s,D,s.reverseTarget):E.calculate(s,D,{performanceOnly:true});
  const make=(id,title,result)=>{const ctx={s:result.effectiveState||s,result,D,E,labels:{},fields:{}};return {id,title,ctx,rows:teachingRows(ctx)};};
  const cases=s.mode==='reverse'?[make('final','已有硬件求解',final)]:constraints.map(([id,title,ignoreTargets])=>make(id,title,E.calculate(s,D,{performanceOnly:true,ignoreTargets})));
  if(s.mode!=='reverse')cases.push(make('final','同时满足全部需求',final));
  return {state:s,cases,final,reference:D.models[s.model]?.cacheProfile?.source||D.models[s.model]?.source};
 }
 function leaves(ast){return ast.op?ast.args.flatMap(leaves):[ast];}
 function units(ctx,rows){
  if(E.precision[ctx.s.precision].compute!=='int8')return rows;
  const integerKeys=new Set(['matrixTF','matrixRate','attentionMatrixRate','prefillMatrix','decodeMatrix']);
  for(const row of rows)for(const t of [...leaves(row.ast),row.result])if(integerKeys.has(t.key))t.unit=t.unit.replace('TFLOP','TOP').replace('GFLOP','GOP');
  return rows;
 }
 function teachingRows(ctx){
  const rows=X.equations(ctx),r=ctx.result,s=ctx.s,w=r.chosen?.w,z=r.formulaContext?.compressed,ep=r.formulaContext?.parallel;if(!w)return rows;
  const t=(key,value,unit='',label=key)=>({key,value,unit,label}),op=(op,...args)=>({op,args}),c=(v,label)=>t('constant',v,'',label),add=(...a)=>op('+',...a),mul=(...a)=>op('×',...a),div=(...a)=>op('÷',...a);
  const row=(id,title,ast,value,unit,section)=>{if(!rows.some(row=>row.id===id))rows.push({id,title,ast,result:t(id,value,unit,title),section,detail:true});};
  const I=t('input',r.I,'Token','输入'),tera=c(1e12,'FLOP → TFLOP');
  const cappedPairs=limit=>{const L=c(limit,'该分支的历史长度上限');return r.I<=limit?div(mul(I,add(I,c(1,'因果自位置'))),c(2,'三角配对除2')):add(div(mul(L,add(L,c(1))),c(2)),mul(op('−',I,L),L));};
  if(z){
   row('compressedGlobalOps','全局与索引扫描工作量',div(mul(t('compressedFullCoef',z.fullCoef,'FLOP/对','全局系数'),div(mul(I,add(I,c(1))),c(2))),tera),z.fullCoef*r.I*(r.I+1)/2/1e12,'TFLOP','prefill');
   row('compressedWindowOps','近期滑窗工作量',div(mul(t('compressedWindowCoef',z.windowCoef,'FLOP/对','滑窗系数'),cappedPairs(z.W)),tera),z.windowCoef*(r.I<=z.W?r.I*(r.I+1)/2:z.W*(z.W+1)/2+(r.I-z.W)*z.W)/1e12,'TFLOP','prefill');
   row('compressedTopkOps','选中历史的主Attention工作量',div(mul(t('compressedSelectedCoef',z.selectedCoef,'FLOP/对','选中历史系数'),cappedPairs(z.selectionWindow)),tera),z.selectedCoef*(r.I<=z.selectionWindow?r.I*(r.I+1)/2:z.selectionWindow*(z.selectionWindow+1)/2+(r.I-z.selectionWindow)*z.selectionWindow)/1e12,'TFLOP','prefill');
   row('compressedStateOps','压缩状态更新工作量',div(mul(t('compressedOps',z.ops,'FLOP/Token','每Token更新'),I),tera),z.ops*r.I/1e12,'TFLOP','prefill');
   if(z.kind==='deepseek-v4'){
    const idx=ctx.D.models[s.model].cacheProfile.indexHeadDim;
    row('compressedStateElements','压缩器状态的元素数',add(mul(t('compress4Layers',z.c4,'层','4倍压缩层'),c(4,'压缩块长度'),c(4,'重叠状态份数'),add(t('kvWidth',s.kvWidth,'元素','KV向量宽度'),t('indexHeadDim',idx,'元素','索引向量宽度'))),mul(t('compress128Layers',z.c128,'层','128倍压缩层'),c(128,'压缩块长度'),c(2,'两份状态'),t('kvWidth',s.kvWidth,'元素','KV向量宽度'))),z.stateElements,'元素','memory');
    for(const row of rows)for(const leaf of leaves(row.ast))if(leaf.key==='constant'&&/状态元素/.test(leaf.label))leaf.key='compressedStateElements';
   }
  }
  if(ep){
   row('prefillExpertTime','本实例专家矩阵耗时',div(mul(t('groupBatch',r.chosen.B,'路','实例并发'),c(2,'乘加'),t('expertActiveB',ep.activeExpertB,'B','专家激活量'),I),mul(c(1000,'B → T'),t('matrixRate',w.matrix/1e12,'TFLOP/s','实例矩阵速率'))),r.chosen.B*2*ep.activeExpertB*1e9*r.I/w.matrix,'s','prefill');
   row('prefillDenseTime','最忙组共享矩阵耗时',div(mul(t('attentionBatch',w.attentionBatch,'路','最忙组并发'),c(2,'乘加'),t('denseActiveB',ep.activeDenseB,'B','非专家激活量'),I),mul(c(1000,'B → T'),t('attentionMatrixRate',w.attentionMatrix/1e12,'TFLOP/s','组矩阵速率'))),w.attentionBatch*2*ep.activeDenseB*1e9*r.I/w.attentionMatrix,'s','prefill');
   const pa=r.trace.find(t=>t.id==='prefillAttention').value;
   row('prefillAttentionTime','最忙组Attention耗时',div(mul(t('attentionBatch',w.attentionBatch,'路','组并发'),t('prefillAttention',pa/1e12,'TFLOP','单路Attention量')),t('attentionRate',w.attention/1e12,'TFLOP/s','组Attention速率')),w.attentionBatch*pa/w.attention,'s','prefill');
  }
  return units(ctx,rows);
 }
 function stepAt(ctx,n){const {result:r,s}=ctx,w=r.chosen?.w;if(!w)return null;const z=r.formulaContext.compressed,W=z?.W||r.formulaContext.window||0,K=z?.selectionWindow||0;
  const compute=w.ca+w.cb*n+w.cs*Math.min(n,W)+(w.ct||0)*Math.min(n,K),memory=w.ma+w.mb*n+w.ms*Math.min(n,W)+(w.mt||0)*Math.min(n,K);
  return {compute,memory,total:Math.max(compute,memory)+s.stepMs/1000+(w.runtimeStep||0)};
 }
 function stepRows(ctx,n){
  const templates=X.equations(ctx),values=new Map([['endContext',n]]),keys={endContext:'animatedContext',decodeAttention:'animatedAttention',endKV:'animatedKV',decodeComputeTime:'animatedComputeTime',decodeMemoryTime:'animatedMemoryTime',decodeStep:'animatedStep',decodeSpeed:'animatedSpeed'};
  const replace=ast=>ast.op?{...ast,args:ast.args.map(replace)}:{...ast,value:values.has(ast.key)?values.get(ast.key)*(ast.key==='decodeAttention'&&ast.unit==='GFLOP'?1000:1):ast.value,key:keys[ast.key]||ast.key};
  const rows=[];
  for(const id of ['decodeAttention','endKV','decodeComputeTime','decodeMemoryTime','decodeStep','decodeSpeed']){
   const template=templates.find(r=>r.id===id);if(!template)continue;
   const ast=replace(template.ast),value=X.evaluateExpression(ast);values.set(id,value);
   rows.push({...template,id:keys[id],title:'本动画步：'+template.title,ast,result:{...template.result,key:keys[id],value},dynamic:true});
  }
  return units(ctx,rows);
 }
 function cumulative(ctx,k){
  if(k<=0)return 0;const w=ctx.result.chosen.w,z=ctx.result.formulaContext.compressed,win=z?.W||ctx.result.formulaContext.window||0,top=z?.selectionWindow||0;
  const lo=ctx.result.I+1,hi=ctx.result.I+k,cuts=[lo,hi+1,...[win+1,top+1].filter(x=>x>lo&&x<=hi)].sort((a,b)=>a-b);let total=k*(ctx.s.stepMs/1000+(w.runtimeStep||0));
  for(let i=0;i<cuts.length-1;i++){
   const l=cuts[i],h=cuts[i+1]-1;if(h<l)continue;
   total+=E.sumRoofline(w.ca+(l>win?w.cs*win:0)+(l>top?(w.ct||0)*top:0),w.cb+(l<=win?w.cs:0)+(l<=top?w.ct||0:0),w.ma+(l>win?w.ms*win:0)+(l>top?(w.mt||0)*top:0),w.mb+(l<=win?w.ms:0)+(l<=top?w.mt||0:0),l,h);
  }
  return total;
 }
 function outputAt(ctx,elapsed){
  const r=ctx.result,w=r.chosen.w;if(elapsed<w.ttft)return 0;let lo=0,hi=r.O-1;
  while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(cumulative(ctx,mid)<=elapsed-w.ttft+1e-9)lo=mid;else hi=mid-1;}
  return 1+lo;
 }
 const api={preset,initial,build,leaves,stepAt,stepRows,cumulative,outputAt};root.CapacityTeaching=api;if(node)module.exports=api;
})(typeof window==='undefined'?globalThis:window);
