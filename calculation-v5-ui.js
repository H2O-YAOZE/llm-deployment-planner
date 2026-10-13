'use strict';
// Inspectable expressions mirror the executed v5 workpoint, not the old v4 renderer.
(function(root){
 const old=root.CalculationExplain;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const literal=(key,label,value,unit='')=>({key,label,value,unit});
 const expression=(op,...args)=>({op,args});
 const add=(...a)=>expression('+',...a),mul=(...a)=>expression('×',...a),div=(...a)=>expression('÷',...a),sub=(...a)=>expression('−',...a),max=(...a)=>expression('max',...a),min=(...a)=>expression('min',...a);
 function evaluate(x){
  if(!x.op)return x.value;
  const a=x.args.map(evaluate);
  return ({'+':()=>a.reduce((x,y)=>x+y,0),'×':()=>a.reduce((x,y)=>x*y,1),'÷':()=>a[0]/a[1],'−':()=>a[0]-a[1],max:()=>Math.max(...a),min:()=>Math.min(...a),ceil:()=>Math.ceil(a[0]),floor:()=>Math.floor(a[0]),pow:()=>Math.pow(a[0],a[1]),log2:()=>Math.log2(a[0])})[x.op]();
 }
 function equations(ctx){
  const r=ctx.result,s=r.effectiveState||ctx.s,q=r.chosen;
  if(!r.ok||!q)return [];
  const w=q.w,h=r.formulaContext,m=ctx.D.models[s.model],v=Object.fromEntries(r.trace.map(n=>[n.id,n.value])),rows=[],z=h.compressed;
  const t=(key,label,unit='',value)=>literal(key,label,value!==undefined?value:Object.hasOwn(v,key)?v[key]:s[key],unit);
  const c=(value,label='换算',unit='')=>literal('constant',label,value,unit);
  const row=(id,title,ast,result,section,detail=false)=>{rows.push({id,title,ast,result,section,detail});return result;};
  const rep=t('kvReplicationEffective','KV复制','倍',w.replication),B=t('groupBatch','实例内并发','路',q.B),coef=t('attentionCoef','单层每Token对','FLOP/对/层');
  const lf=t('fullLayers','全注意力层','层',h.fullLayers),ls=t('slidingLayers','滑窗层','层',h.slidingLayers),win=t('window','窗口长度','Token',h.window);
  const byteGB=c(1e9,'bytes → GB'),tera=c(1e12,'FLOP → TFLOP');
  const matrix=t('matrixRate','有效矩阵','TFLOP/s',w.matrix/1e12),attention=t('attentionRate','有效Attention','TFLOP/s',w.attention/1e12),bw=t('bandwidthRate','有效带宽','GB/s',w.bw/1e9);
  const ep=h.parallel,AB=t('attentionBatch','最忙Attention组并发','路',w.attentionBatch),DP=t('attentionDP','Attention请求分组','组',q.attentionDP),CB=t('cacheBatch','逐组容量折合份数','份',w.cacheBatch);
  const groupCards=t('attentionCards','Attention组卡份额','张',w.layout.attentionCards),groupEta=t('attentionEfficiency','组效率','倍',w.attentionEta);
  const groupMatrix=t('attentionMatrixRate','Attention组矩阵','TFLOP/s',w.attentionMatrix/1e12),groupBW=t('attentionBandwidthRate','Attention组带宽','GB/s',w.attentionBW/1e9);
  const expertB=ep?t('expertActiveB','激活专家参数','B',ep.activeExpertB):null,denseB=ep?t('denseActiveB','非专家激活参数','B',ep.activeDenseB):null;
  const expertWeight=ep?t('expertWeight','分片专家权重','GB',ep.expertWeight):null,denseWeight=ep?t('denseWeight','一份非专家权重','GB',ep.denseWeight):null;
  const expertActive=ep?t('expertActiveWeight','专家激活权重','GB',ep.activeExpert):null,denseActive=ep?t('denseActiveWeight','非专家激活权重','GB',ep.activeDense):null;
  const expertUnion=ep?min(expertWeight,mul(expertActive,add(c(1),mul(sub(B,c(1)),t('unionGrowth','专家并集增长比例'))))):null;
  const prefillExpert=ep?(r.I>1?expertWeight:expertUnion):null,prefillDense=ep?(r.I>1?denseWeight:denseActive):null;
  const parameterCompute=length=>add(div(div(mul(B,c(2,'乘加'),expertB,length),c(1000,'B → T')),matrix),div(div(mul(AB,c(2,'乘加'),denseB,length),c(1000,'B → T')),groupMatrix));
  const parameterBytes=t('weightBytes','每参数','bytes',h.weightBytes),overhead=t('weightOverhead','元数据系数','倍');
  let weightAst=mul(t('totalB','完整参数','B'),parameterBytes,overhead);
  if(h.precisionProfile)weightAst=mul(add(mul(t('quantB','量化参数','B',h.quantB),parameterBytes),mul(t('nonquantB','保留参数','B',s.totalB-h.quantB),t('nonquantBytes','保留精度','bytes',h.nonquantBytes)),...(h.metadataGB?[t('metadataGB','固定元数据','GB',h.metadataGB)]:[])),overhead);
  row('weight','模型权重',weightAst,t('weight','全量权重','GB'),'memory');
  if(ep){
   const g=m.parallelProfile.geometry;
   if(g)row('expertParamsB','所有专家参数如何得到',min(t('totalB','模型完整参数','B'),mul(div(mul(c(g.matrices,'每专家矩阵数'),c(g.hiddenSize,'模型隐藏维度'),c(g.intermediateSum,'各专家层中间维度之和'),c(ep.experts,'模型专家总数')),c(1e9,'参数 → B')),div(t('layers','当前层数','层'),c(m.layers,'目录层数','层')))),t('expertParamsB','全部专家参数','B',ep.expertB),'memory',true);
   row('expertWeight','专家权重存储',mul(add(mul(c(Math.min(ep.expertB,h.quantB),'量化专家参数','B'),parameterBytes),mul(c(ep.expertB-Math.min(ep.expertB,h.quantB),'未量化专家参数','B'),c(h.nonquantBytes,'保留精度','bytes'))),overhead),expertWeight,'memory',true);
   row('denseWeight','一份非专家权重',sub(t('weight','一份全权重','GB'),expertWeight),denseWeight,'memory',true);
   row('expertActiveB','每Token激活专家参数',min(c(s.activeB,'激活总量','B'),mul(c(ep.expertB,'专家完整参数','B'),div(c(ep.selectedExperts,'每Token专家数'),c(ep.experts,'专家总数')))),expertB,'prefill',true);
   row('denseActiveB','每Token非专家激活参数',sub(t('activeB','激活总量','B'),expertB),denseB,'prefill',true);
   row('expertActiveWeight','专家访存参考',mul(t('activeWeight','全部激活访存','GB'),div(expertB,t('activeB','激活总量','B'))),expertActive,'decode',true);
   row('denseActiveWeight','非专家访存参考',sub(t('activeWeight','全部激活访存','GB'),expertActive),denseActive,'decode',true);
   row('attentionDP','Attention请求分组',div(c(q.logicalTP,'模型逻辑设备','个'),t('attentionTP','每组逻辑设备','个',q.attentionTP)),DP,'memory',true);
   row('attentionCards','每Attention组卡份额',div(t('attentionTP','每组逻辑设备','个',q.attentionTP),c(ctx.D.cards[s.card].logicalDevicesPerModule||1,'每卡逻辑设备','个')),groupCards,'memory',true);
   row('attentionBatch','最忙Attention组并发',expression('ceil',div(B,DP)),AB,'memory',true);
   row('cacheBatch','逐组峰值预留份数',mul(AB,DP),CB,'memory',true);
   row('storedWeight','实例权重（含非专家复制）',add(expertWeight,mul(denseWeight,DP)),t('storedWeight','实例权重','GB',w.storedWeight),'memory');
   row('attentionEfficiency','Attention组效率',expression('pow',sub(c(1),t('parallelLoss','每翻倍损失')),expression('log2',max(c(1),groupCards))),groupEta,'prefill',true);
   row('attentionMatrixRate','Attention组矩阵算力',mul(groupCards,t('matrixTF','单卡矩阵峰值','TFLOP/s'),t('mfu','矩阵利用率'),groupEta),groupMatrix,'prefill',true);
   row('attentionBandwidthRate','Attention组显存带宽',mul(groupCards,t('bandwidth','单卡带宽','GB/s'),t('bwEff','带宽利用率'),groupEta),groupBW,'decode',true);
  }
  if(m.kvHeads&&s.kvWidth===2*m.kvHeads*m.headDim)row('kvWidth','每层 KV 宽度',mul(c(2,'K与V两份'),t('kvHeads','KV头数','个',m.kvHeads),t('headDim','每头维度','维',m.headDim)),t('kvWidth','每层KV宽度','元素'),'memory');
  if(h.fullLayers)row('kv','每 Token 的 KV（全注意力层）',mul(lf,t('kvWidth','每层KV宽度','元素'),t('kvBytes','每元素','bytes')),t('kv','每Token KV','bytes/Token'),'memory');
  if(h.slidingLayers)row('slideKV','每 Token 的滑窗 KV',mul(ls,t('kvWidth','每层KV宽度','元素'),t('kvBytes','每元素','bytes')),t('slideKV','滑窗KV','bytes/Token',h.slideKV),'memory');
  row('context','单路预留长度',add(t('input','最大输入','Token'),t('output','最大输出','Token')),t('context','单路上下文','Token'),'memory');
  const compressedCache=(length,read=false,copies=rep)=>div(mul(add(mul(t(read?'compressedReadSlope':'kv',read?'全局/索引读取率':'完整KV与索引存储率','bytes/Token',read?z.readSlope:z.storeSlope),length),mul(t('compressedWindowSlope','各层滑窗KV率','bytes/Token',z.windowSlope),min(length,t('compressedWindow','滑窗长度','Token',z.W))),...(read?[mul(t('compressedSelectedSlope','TopK被选KV率','bytes/Token',z.selectedSlope),min(length,c(z.selectionWindow,'TopK等效原长度','Token')))]:[]),t('compressedState','压缩状态+块取整预留','bytes',z.fixed)),copies),byteGB);
  const cacheAst=length=>z?compressedCache(length):add(...(h.fullLayers||h.slidingLayers?[div(mul(add(...(h.fullLayers?[mul(t('kv','每Token KV','bytes/Token'),length)]:[]),...(h.slidingLayers?[mul(t('slideKV','滑窗KV','bytes/Token',h.slideKV),min(length,win))]:[])),rep),byteGB)]:[]),...(h.linearFixed?[t('linearState','固定递归状态','GB',h.linearFixed/1e9)]:[]));
  if(z?.kind==='deepseek-v4'){
   const p=m.cacheProfile,c4=t('compress4Layers','压缩4层','层',z.c4),c128=t('compress128Layers','压缩128层','层',z.c128),idx=t('indexHeadDim','索引维度','元素',p.indexHeadDim),idxHeads=t('indexHeads','索引头数','个',p.indexHeads);
   row('kv','完整压缩缓存增长率',mul(t('kvBytes','每元素','bytes'),add(mul(t('kvWidth','共享KV向量','元素'),add(div(c4,c(4,'压缩比例')),div(c128,c(128,'压缩比例')))),mul(idx,div(c4,c(4,'索引压缩比例'))))),t('kv','增长率','bytes/Token'),'memory',true);
   row('compressedState','压缩状态与块取整预留',add(mul(c(z.stateElements,'压缩状态元素'),c(4,'FP32状态','bytes')),mul(add(c4,c128),t('kvWidth','共享KV维度','元素'),t('kvBytes','缓存元素','bytes')),mul(c4,idx,t('kvBytes','索引元素','bytes'))),c(z.fixed,'固定预留','bytes'),'memory',true);
   row('compressedWindowSlope','滑窗缓存率',mul(t('layers','主干层','层'),t('kvWidth','共享KV向量','元素'),t('kvBytes','每元素','bytes')),t('compressedWindowSlope','滑窗率','bytes/Token',z.windowSlope),'memory',true);
   row('compressedReadSlope','全局压缩与索引读取率',mul(t('kvBytes','每元素','bytes'),add(mul(t('kvWidth','共享KV向量','元素'),div(c128,c(128))),mul(idx,div(c4,c(4))))),t('compressedReadSlope','全局读取率','bytes/Token',z.readSlope),'decode',true);
   row('compressedSelectedSlope','压缩4选中KV读取率',mul(t('kvBytes','每元素','bytes'),t('kvWidth','共享KV向量','元素'),div(c4,c(4))),t('compressedSelectedSlope','TopK读取率','bytes/Token',z.selectedSlope),'decode',true);
   row('compressedFullCoef','压缩128加完整索引扫描',add(mul(coef,div(c128,c(128))),mul(c(2,'乘加计数'),idxHeads,idx,div(c4,c(4)))),t('compressedFullCoef','全局运算系数','FLOP/Token',z.fullCoef),'prefill',true);
   row('compressedWindowCoef','各层滑窗运算系数',mul(coef,t('layers','主干层','层')),t('compressedWindowCoef','滑窗系数','FLOP/Token',z.windowCoef),'prefill',true);
   row('compressedSelectedCoef','压缩4 TopK运算系数',mul(coef,div(c4,c(4))),t('compressedSelectedCoef','TopK系数','FLOP/Token',z.selectedCoef),'prefill',true);
   row('compressedOps','压缩状态更新工程近似',mul(c(z.stateElements,'状态元素'),c(8,'每元素近似','FLOP/Token')),t('compressedOps','更新运算','FLOP/Token',z.ops),'prefill',true);
  }
  else if(z){
   const p=m.cacheProfile,ix=t('indexerLayers','独立索引层','层',z.indexLayers),width=t('kvWidth','MLA潜变量KV','元素'),idx=t('indexHeadDim','索引维度','元素',p.indexHeadDim),bytes=t('kvBytes','缓存每元素','bytes');
   row('kv','完整MLA加索引缓存率',mul(bytes,add(mul(t('layers','主干层','层'),width),mul(ix,idx))),t('kv','完整缓存率','bytes/Token'),'memory',true);
   row('compressedReadSlope','完整索引扫描读取率',mul(bytes,ix,idx),t('compressedReadSlope','索引读取率','bytes/Token',z.readSlope),'decode',true);
   row('compressedSelectedSlope','选中MLA缓存读取率',mul(bytes,t('layers','主干层','层'),width),t('compressedSelectedSlope','被选KV率','bytes/Token',z.selectedSlope),'decode',true);
   row('compressedFullCoef','独立索引层完整扫描系数',mul(c(2,'乘加计数'),t('indexHeads','索引头数','个',p.indexHeads),idx,ix),t('compressedFullCoef','索引扫描系数','FLOP/Token',z.fullCoef),'prefill',true);
   row('compressedSelectedCoef','各层TopK主Attention系数',mul(coef,t('layers','主干层','层')),t('compressedSelectedCoef','主Attention系数','FLOP/Token',z.selectedCoef),'prefill',true);
  }
  if(z)row('kvSessionBase','复制前的单路完整缓存',compressedCache(t('context','单路上下文','Token'),false,c(1,'复制前')),t('kvSessionBase','基础单路缓存','GB',r.kvSessionBase),'memory',true);
  row('kvSession','单路 KV / 请求状态显存',z?mul(t('kvSessionBase','基础单路缓存','GB',r.kvSessionBase),rep):cacheAst(t('context','单路上下文','Token')),t('kvSession','单路峰值状态','GB',w.kvSession),'memory');
  const session=t('kvSession','单路缓存','GB',w.kvSession),stored=t('storedWeight','每实例权重','GB',w.storedWeight),groups=t('groups','实例数量','个',q.groups),requests=t('batch','全部实际请求','路',s.concurrency);
  row('requestCacheTotal','全部请求需要的缓存',mul(requests,session),t('requestCacheTotal','缓存合计','GB',s.concurrency*w.kvSession),'memory');
  row('instanceRequestCache','最忙实例的实际请求缓存',mul(B,session),t('instanceRequestCache','请求缓存','GB',q.B*w.kvSession),'memory',true);
  row('allInstanceWeight','全部实例的权重',mul(groups,stored),t('allInstanceWeight','权重合计','GB',q.groups*w.storedWeight),'memory');
  row('actualMemoryTotal','权重与实际请求缓存合计',add(t('allInstanceWeight','全部权重','GB',q.groups*w.storedWeight),t('requestCacheTotal','全部请求缓存','GB',s.concurrency*w.kvSession)),t('actualMemoryTotal','合计','GB',q.groups*w.storedWeight+s.concurrency*w.kvSession),'memory');
  row('groupWeight','一个处理组分到的权重',div(stored,DP),t('groupWeight','组内权重','GB',w.storedWeight/q.attentionDP),'memory',true);
  row('groupUsable','一个处理组可用显存',div(t('usable','实例可用显存','GB',w.usable),DP),t('groupUsable','组内可用','GB',w.usable/q.attentionDP),'memory',true);
  row('groupUsed','最忙处理组需要的显存',add(t('groupWeight','组内权重','GB',w.storedWeight/q.attentionDP),mul(AB,session)),t('groupUsed','组内需要','GB',w.used/q.attentionDP),'memory',true);
  row('used','按最忙处理组检查的容量',add(t(ep?'storedWeight':'weight','实例权重','GB',w.storedWeight),mul(CB,t('kvSession','每份峰值状态','GB',w.kvSession))),t('used','需要','GB',w.used),'memory');
  row('usable','本实例可用显存',mul(t('chosenTP','实例用卡','张',q.tp),sub(mul(t('memoryGB','单卡显存','GB'),sub(c(1,'完整比例'),t('reserve','运行预留比例'))),t('scratchGB','每卡工作区','GB'))),t('usable','可用','GB',w.usable),'memory',true);
  if(h.linearFixed){const p=m.cacheProfile;row('linearState','线性递归与卷积状态',div(mul(t('linearLayers','线性层','层',h.linearLayers),add(mul(c(p.linearStateElements,'递归状态元素'),c(p.stateBytes||4,'每元素','bytes')),mul(c(p.linearConvElements||0,'卷积状态元素'),t('kvBytes','卷积元素','bytes')))),byteGB),t('linearState','单路固定状态','GB',h.linearFixed/1e9),'memory',true);}
  row('kvReplicationEffective','KV复制倍数',mul(t('kvReplication','手动额外复制','倍'),c(w.replication/s.kvReplication,'头分片复制','倍')),rep,'memory',true);
  const stepOverhead=div(t('stepMs','阶段/每步附加','ms'),c(1000,'ms → s'));
  row('prefillInputTotal','本实例同时读取的输入',mul(B,t('input','每路输入','Token')),t('prefillInputTotal','输入总量','Token',q.B*r.I),'prefill');
  row('prefillMatrix','参数矩阵运算',div(mul(c(2,'乘加计数'),t('activeB','激活参数','B'),t('input','输入长度','Token')),c(1000,'B → T')),t('prefillMatrix','参数运算','TFLOP',v.prefillMatrix/1e12),'prefill');
  const pairsAt=n=>h.window&&n>h.window?h.window*(h.window+1)/2+(n-h.window)*h.window:n*(n+1)/2;
  const cappedPairs=(length,window)=>{const n=min(length,c(window,'上限','Token'));return add(div(mul(n,add(n,c(1))),c(2)),mul(max(sub(length,c(window,'上限','Token')),c(0)),c(window,'窗口','Token')));};
  const attentionAst=(length,prefill)=>z?div(add(mul(t('compressedFullCoef','全局/索引扫描系数','FLOP/Token',z.fullCoef),prefill?div(mul(length,add(length,c(1))),c(2)):length),mul(t('compressedWindowCoef','所有层滑窗系数','FLOP/Token',z.windowCoef),prefill?cappedPairs(length,z.W):min(length,c(z.W,'滑窗','Token'))),mul(t('compressedSelectedCoef','TopK注意力系数','FLOP/Token',z.selectedCoef),prefill?cappedPairs(length,z.selectionWindow):min(length,c(z.selectionWindow,'TopK等效长度','Token'))),mul(t('compressedOps','压缩状态更新近似','FLOP/Token',z.ops),prefill?length:c(1))),tera):div(add(mul(coef,add(mul(lf,prefill?t('pairs','因果配对','对'):length),...(h.slidingLayers?[mul(ls,prefill?t('windowPairs','滑窗配对','对',pairsAt(r.I)):min(length,win))]:[]))),...(h.linearOps?[mul(t('linearOps','递归近似','FLOP/Token',h.linearOps),prefill?t('input','输入','Token'):c(1,'本步'))]:[])),tera);
  if(z)row('prefillAttentionDetail','压缩 Attention 的完整代入',attentionAst(t('input','输入','Token'),true),t('prefillAttention','Attention','TFLOP',v.prefillAttention/1e12),'prefill',true);
  const pairsCap=n=>r.I<=n?r.I*(r.I+1)/2:n*(n+1)/2+(r.I-n)*n;
  const compactAttention=z?add(t('compressedGlobalOps','全局与索引扫描','TFLOP',z.fullCoef*r.I*(r.I+1)/2/1e12),t('compressedWindowOps','滑窗运算','TFLOP',z.windowCoef*pairsCap(z.W)/1e12),t('compressedTopkOps','TopK运算','TFLOP',z.selectedCoef*pairsCap(z.selectionWindow)/1e12),t('compressedStateOps','状态更新近似','TFLOP',z.ops*r.I/1e12)):attentionAst(t('input','输入','Token'),true);
  if(z){
   const length=t('input','输入长度','Token');
   row('compressedGlobalOps','全局与索引扫描工作量',div(mul(t('compressedFullCoef','全局和索引运算系数','FLOP/Token',z.fullCoef),div(mul(length,add(length,c(1,'当前位置'))),c(2,'因果三角'))),tera),t('compressedGlobalOps','扫描工作量','TFLOP',z.fullCoef*r.I*(r.I+1)/2/1e12),'prefill',true);
   row('compressedWindowOps','近期滑窗工作量',div(mul(t('compressedWindowCoef','滑窗运算系数','FLOP/Token',z.windowCoef),cappedPairs(length,z.W)),tera),t('compressedWindowOps','滑窗工作量','TFLOP',z.windowCoef*pairsCap(z.W)/1e12),'prefill',true);
   row('compressedTopkOps','TopK选中历史工作量',div(mul(t('compressedSelectedCoef','选中历史系数','FLOP/Token',z.selectedCoef),cappedPairs(length,z.selectionWindow)),tera),t('compressedTopkOps','选中历史工作量','TFLOP',z.selectedCoef*pairsCap(z.selectionWindow)/1e12),'prefill',true);
   row('compressedStateOps','压缩状态更新工作量',div(mul(t('compressedOps','每Token状态更新','FLOP/Token',z.ops),length),tera),t('compressedStateOps','更新工作量','TFLOP',z.ops*r.I/1e12),'prefill',true);
  }
  row('prefillAttention','Attention 运算'+(h.linearOps?'与递归近似':''),compactAttention,t('prefillAttention','Attention','TFLOP',v.prefillAttention/1e12),'prefill');
  row('prefillComputeTime','计算耗时',ep?add(parameterCompute(t('input','输入','Token')),mul(AB,div(t('prefillAttention','Attention运算','TFLOP',v.prefillAttention/1e12),attention))):mul(B,add(div(t('prefillMatrix','参数运算','TFLOP',v.prefillMatrix/1e12),matrix),div(t('prefillAttention','Attention','TFLOP',v.prefillAttention/1e12),attention))),t('prefillComputeTime','计算','s',w.pCompute),'prefill');
  row('ttftResult','首 Token 延迟',add(max(t('prefillComputeTime','计算','s',w.pCompute),t('prefillMemoryTime','访存','s',w.pMemory)),stepOverhead,div(t('transportMs','请求传输','ms'),c(1000,'ms → s'))),t('ttftResult','预计首Token','s',w.ttft),'prefill');
  row('attentionCoef','单层每个注意力对',mul(c(2,'乘加计数'),t('qHeads','Q头','个'),add(t('qkDim','QK维度','维'),t('vDim','V维度','维')),t('attentionFraction','运算保留比例')),coef,'prefill',true);
  row('pairs','因果注意力配对',div(mul(t('input','输入','Token'),add(t('input','输入','Token'),c(1,'当前位置'))),c(2,'因果三角')),t('pairs','因果配对','对'),'prefill',true);
  if(h.slidingLayers)row('windowPairs','滑窗注意力配对',r.I<=h.window?div(mul(t('input','输入','Token'),add(t('input','输入','Token'),c(1))),c(2)):add(div(mul(win,add(win,c(1))),c(2)),mul(sub(t('input','输入','Token'),win),win)),t('windowPairs','滑窗配对','对',pairsAt(r.I)),'prefill',true);
  if(h.linearOps)row('linearOps','每Token递归运算近似',mul(t('linearLayers','线性层','层',h.linearLayers),c(m.cacheProfile.linearStateElements,'状态元素'),c(8,'每元素近似','FLOP')),t('linearOps','递归运算','FLOP/Token',h.linearOps),'prefill',true);
  row('efficiency','跨卡效率假设',expression('pow',sub(c(1),t('parallelLoss','每翻倍损失比例')),expression('log2',t('chosenTP','实例用卡','张',q.tp))),t('efficiency','效率','倍',w.eta),'prefill',true);
  row('matrixRate','有效矩阵算力',mul(t('chosenTP','实例用卡','张',q.tp),t('matrixTF','单卡峰值','TFLOP/s'),t('mfu','矩阵利用率'),t('efficiency','跨卡效率','倍',w.eta)),matrix,'prefill',true);
  row('attentionRate','有效 Attention 算力',mul(groupCards,t('attentionTF','Attention峰值','TFLOP/s'),t('attentionMfu','Attention利用率'),groupEta),attention,'prefill',true);
  row('prefillTraffic','Prefill读取流量',add(t('prefillWeight','实例读取权重','GB',w.prefillWeight),mul(CB,sub(cacheAst(t('input','输入','Token')),c(h.linearFixed/1e9,'固定状态','GB')),t('kvTraffic','缓存流量系数')),...(h.linearFixed?[mul(CB,t('linearState','固定状态','GB',h.linearFixed/1e9))]:[])),t('prefillTraffic','总流量','GB',w.pTraffic/1e9),'prefill',true);
  row('prefillMemoryTime','Prefill访存耗时',ep?add(div(prefillExpert,bw),div(add(prefillDense,mul(AB,add(mul(sub(cacheAst(t('input','输入','Token')),c(h.linearFixed/1e9,'固定状态','GB')),t('kvTraffic','缓存读写系数')),c(h.linearFixed/1e9,'固定状态','GB')))),groupBW)):div(t('prefillTraffic','读取流量','GB',w.pTraffic/1e9),bw),t('prefillMemoryTime','访存','s',w.pMemory),'prefill',true);
  row('prefillTime','读取输入阶段',add(max(t('prefillComputeTime','计算','s',w.pCompute),t('prefillMemoryTime','访存','s',w.pMemory)),stepOverhead),t('prefillTime','Prefill','s',w.prefill),'prefill',true);
  row('prefillWeight','Prefill权重读取',ep?add(prefillExpert,mul(prefillDense,DP)):s.activeB<s.totalB&&r.I>1?t('weight','长输入MoE全权重','GB'):t('union','批内并集','GB',w.union),t('prefillWeight','读取权重','GB',w.prefillWeight),'prefill',true);
  if(r.O>1){
   const end=t('endContext','末端已有上下文','Token',r.S-1),endCache=z?evaluate(compressedCache(end,true)):(h.fullKV*(r.S-1)+h.slideKV*Math.min(r.S-1,h.window))*w.replication/1e9+h.linearFixed/1e9;
   row('decodeComputeTime','末端计算耗时',ep?add(parameterCompute(c(1,'每路本步Token')),mul(AB,div(t('decodeAttention','Attention运算','TFLOP',v.decodeAttention/1e12),attention))):mul(B,add(div(t('decodeMatrix','参数运算','GFLOP',v.decodeMatrix/1e9),t('matrixRate','有效矩阵','GFLOP/s',w.matrix/1e9)),div(t('decodeAttention','末端Attention','GFLOP',v.decodeAttention/1e9),t('attentionRate','有效Attention','GFLOP/s',w.attention/1e9)))),t('decodeComputeTime','计算','s/步',w.endCompute),'decode');
   row('decodeMemoryTime','末端访存耗时',ep?add(div(expertUnion,bw),div(add(denseActive,mul(AB,t('endKV','单路读取缓存','GB',endCache))),groupBW)):div(add(t('union','读取权重并集','GB',w.union),mul(B,t('endKV','单路KV/状态','GB',endCache))),bw),t('decodeMemoryTime','访存','s/步',w.endMemory),'decode');
   const runtime=[];
   if(w.runtimeProfile){
    const p=w.runtimeProfile,refEta=Math.pow(1-p.referenceParallelLoss,Math.log2(p.referenceCards));
    const resourceRatio=max(div(c(p.referenceCards*p.referenceMatrixTF*p.referenceMfu*refEta,'测试设备有效矩阵','TFLOP/s'),matrix),div(c(p.referenceCards*p.referenceBandwidth*p.referenceBwEff*refEta,'测试设备有效带宽','GB/s'),bw));
    row('runtimeStep','公开测试补充的生成耗时',add(t('runtimeFixed','测试中的固定耗时差','s',p.fixedSeconds),mul(t('runtimeSlope','每路额外耗时','s/路',p.perRequestSeconds),B,resourceRatio)),t('runtimeStep','补充耗时','s/步',w.runtimeStep),'decode',true);
    runtime.push(t('runtimeStep','公开测试耗时差','s',w.runtimeStep));
   }
   row('decodeStep','每步时间',add(max(t('decodeComputeTime','计算','s',w.endCompute),t('decodeMemoryTime','访存','s',w.endMemory)),stepOverhead,...runtime),t('decodeStep','每步','s',w.endStep),'decode');
   row('decodeSpeed','每路生成速度',div(c(1,'每路每步','Token'),t('decodeStep','每步','s',w.endStep)),t('decodeSpeed','末端速度','Token/s/路',w.speed),'decode');
   row('decodeMatrix','每步参数运算',mul(c(2,'乘加计数'),t('activeB','激活参数','B')),t('decodeMatrix','参数运算','GFLOP',v.decodeMatrix/1e9),'decode',true);
   row('endContext','最后一个Token生成前',sub(t('context','输入+输出','Token'),c(1,'尚未生成的Token')),end,'decode',true);
   row('decodeAttention','末端Attention运算',attentionAst(end,false),t('decodeAttention','末端运算','TFLOP',v.decodeAttention/1e12),'decode',true);
   row('endKV','末端单路读取缓存/状态',z?compressedCache(end,true):cacheAst(end),t('endKV','末端读取缓存/状态','GB',endCache),'decode',true);
  }
  row('bandwidthRate','有效显存带宽',mul(t('chosenTP','实例用卡','张',q.tp),t('bandwidth','单卡带宽','GB/s'),t('bwEff','有效比例'),t('efficiency','跨卡效率','倍',w.eta)),bw,'decode',true);
  row('activeWeight','每路激活权重',h.denseMixed?t('weight','Dense混合精度权重','GB'):mul(t('activeB','激活参数','B'),t('activeBytes','访存参考精度','bytes',h.activeBytes),overhead),t('activeWeight','激活权重','GB'),'decode',true);
  row('union','批内读取权重并集',ep?add(expertUnion,denseActive):min(t('weight','全权重','GB'),mul(t('activeWeight','单路激活权重','GB'),add(c(1),mul(sub(B,c(1)),t('unionGrowth','并集增长比例'))))),t('union','并集','GB',w.union),'decode',true);
  row('response','完整响应时间',add(t('ttftResult','首Token','s',w.ttft),t('decodeDuration','剩余输出生成','s',w.decode)),t('response','完整响应','s',w.response),'throughput');
  const workloads=q.workloads||[{count:q.activeGroups,B:q.B,w}];
  row('totalOutputThroughput','完整周期总输出吞吐',add(...workloads.map(g=>div(mul(c(g.count,'此批量实例','个'),c(g.B,'每实例并发','路'),t('output','每路输出','Token')),c(g.w.response,'各自完整响应','s')))),t('totalOutputThroughput','总输出吞吐','Token/s',q.outputThroughput),'throughput');
  row('completedRequests','完整请求吞吐',div(t('totalOutputThroughput','总输出吞吐','Token/s',q.outputThroughput),t('output','每请求输出','Token')),t('completedRequests','请求吞吐','请求/s',q.requestsPerSecond),'throughput',true);
  if(r.O>1)row('totalDecodeThroughput','Decode末端总吞吐',add(...workloads.map(g=>mul(c(g.count,'此批量实例','个'),c(g.B,'每实例并发','路'),c(g.w.speed,'各自末端速度','Token/s/路')))),t('totalDecodeThroughput','末端总吞吐','Token/s',q.decodeThroughput),'throughput',true);
  row('activeCards','参与计算的卡数',mul(c(q.activeGroups,'活跃实例','个'),t('chosenTP','每实例用卡','张',q.tp)),t('activeCards','参与计算','张',q.activeCards),'deployment');
  row('groupBatch','最忙实例内的并发',expression('ceil',div(t('batch','需求并发','路',s.concurrency),t('groups','布置实例','个',q.groups))),B,'deployment',true);
  row('activeGroups','本批活跃实例',min(t('groups','布置实例','个',q.groups),t('batch','需求并发','路',s.concurrency)),t('activeGroups','活跃实例','个',q.activeGroups),'deployment',true);
  if(s.mode==='forward'){
   if(q.groups===Math.ceil(s.concurrency/q.bcap))row('groups','按容量分配实例',expression('ceil',div(t('batch','需求并发','路',s.concurrency),c(q.bcap,'每实例容量','路'))),t('groups','布置实例','个',q.groups),'deployment',true);
   row('serverCount','按整机卡位配置',q.tp<=s.slots?expression('ceil',div(t('groups','实例','个',q.groups),c(Math.floor(s.slots/q.tp),'每台可放实例','个/台'))):mul(t('groups','实例','个',q.groups),expression('ceil',div(t('chosenTP','每实例卡数','张',q.tp),t('slots','每台卡位','张/台')))),t('serverCount','需要服务器','台',q.servers),'deployment');
  }else row('serverCount','使用已有设备',t('servers','客户已有设备','台'),t('serverCount','已有服务器','台',q.servers),'deployment');
  row('purchasedCards','整机配置卡位',mul(t('serverCount','采购/已有','台',q.servers),t('slots','每台卡位','张')),t('purchasedCards','配置卡位','张',q.purchasedCards),'deployment');
  if(ctx.E.precision[s.precision].compute==='int8'){
   const integerKeys=new Set(['matrixTF','matrixRate','attentionMatrixRate','prefillMatrix','decodeMatrix']);
   const normalize=x=>{if(x.op)x.args.forEach(normalize);else if(integerKeys.has(x.key))x.unit=x.unit.replace('TFLOP','TOP').replace('GFLOP','GOP');};
   rows.forEach(row=>{normalize(row.ast);normalize(row.result);});
  }
  return rows;
 }
 function renderEquation(ctx,row){
  const scoped={...ctx,explanationRows:[row,...(ctx.explanationRows||[])]};
  const factor=x=>old.token(scoped,x.key,x.value,x.label,x.unit);
  const op=s=>`<span class="calc-op" aria-hidden="true">${esc(s)}</span>`;
  function expr(x,parent='',index=0){
   if(!x.op)return factor(x);
   const args=x.args.map((a,i)=>expr(a,x.op,i));
   if(['max','min','ceil','floor','log2'].includes(x.op))return op(({ceil:'向上取整',floor:'向下取整',log2:'log₂'})[x.op]||x.op)+op('(')+args.join(op(', '))+op(')');
   if(x.op==='pow')return op('(')+args[0]+op(')^(')+args[1]+op(')');
   const rank={'+':1,'−':1,'×':2,'÷':2};
   const wrap=args.length>1&&((rank[x.op]||3)<(rank[parent]||0)||(index>0&&['÷','−'].includes(parent)&&(rank[x.op]||3)<=(rank[parent]||0)));
   return (wrap?op('('):'')+args.join(op(x.op))+(wrap?op(')'):'');
  }
  return `<div class="equation-values">${expr(row.ast)}${op('≈')}${factor(row.result)}</div>`;
 }
 function render(ctx,options={}){
  const r=ctx.result,s=r.effectiveState||ctx.s,q=r.chosen;
  if(!r.ok||!q)return '<p class="core-empty">当前没有可用计算结果。请核对上方模型、精度、设备与需求；未知或不可行组合不显示旧方案的公式。</p>';
  const rows=equations(ctx),w=q.w,ignored=new Set(r.options?.ignoreTargets||[]),hasDecode=r.O>1;
  const factor=x=>old.token(ctx,x.key,x.value,x.label,x.unit);
  const eq=row=>`<div class="core-equation" id="overview-${row.id}" data-equation="${row.id}" tabindex="-1"><div class="equation-name">${esc(row.title)}</div>${renderEquation(ctx,row)}</div>`;
  const section=(id,detail)=>rows.filter(x=>x.section===id&&x.detail===detail).map(eq).join('');
  const details=(id,title)=>`<details class="core-assumptions"><summary>${title}</summary>${section(id,true)}</details>`;
  const target=(key,label,value,unit)=>factor(literal(key,label,value,unit));
  const head=(title,ok,status)=>`<header class="core-branch-heading"><h3>${title}</h3><span class="core-check ${ok?'pass':'fail'}">${status}</span></header>`;
  const ttftOK=ignored.has('ttft')||w.ttft<=s.ttft,speedOK=!hasDecode||ignored.has('speed')||w.speed>=s.speed;
  const decodeSum=hasDecode?`<details class="core-assumptions"><summary>剩余输出时间如何累加</summary><p>首Token由Prefill产生，后续共 ${r.O-1} 步。已有上下文从 ${r.I+1} 到 ${r.S-1} Token，每一步按同一公式取计算与访存较慢值，加每步开销后求和。</p><p>Σ [max(该步计算时间, 该步访存时间) + ${s.stepMs}/1000] ≈ ${w.decode.toPrecision(7)} s。不能用末端速度直接除全部输出；各步上下文不同。</p></details>`:'';
  const throughput=`<section class="core-branch core-throughput" data-core="throughput"><header class="core-branch-heading"><h3>响应与吞吐怎么算</h3></header>${section('throughput',false)}${decodeSum}${details('throughput','其他吞吐口径')}</section>`;
  const conclusion=`<details class="core-assumptions" id="overview-solveAnswer" tabindex="-1"><summary>卡数与整机配置依据</summary>${section('deployment',false)}${details('deployment','实例分配与并发取整')}<p>${s.mode==='reverse'?'已有设备卡数固定，按模型实例分配参与计算的卡数；不能为了满足目标自动增加设备。':'参与计算的卡数按实例分配，采购配置按整机卡位取整。两者可能不同；具体卡数和费用以上方配置结果为准。'}</p></details>`;
  if(options.sectionsOnly)return {throughput,conclusion};
  return `<div class="core-intro"><span>${q.groups} 个实例 · 最忙实例 ${q.B} 路并发</span><p>每步显示实际代入值；数字可悬停或聚焦查看来源。显示取整，计算保留完整精度。</p></div>${r.performanceEvidence?.referenceOnly?`<p class="notice">${esc(r.performanceEvidence.reason)}</p>`:''}<div class="core-branches core-four-columns"><section class="core-branch" data-core="memory" id="overview-loadingCheck" tabindex="-1">${head('显存：能不能装下',w.fits,w.fits?'容量满足':'显存不足')}${section('memory',false)}${details('memory','可用显存、复制与运行预留')}</section><section class="core-branch" data-core="prefill">${head('首 Token：能否及时回答',ttftOK,ignored.has('ttft')?'本次求解结果':ttftOK?'首字满足':'首字超时')}<div class="core-target">${ignored.has('ttft')?'':target('ttft','客户目标',s.ttft,'s')}${target('ttftResult','当前估算',w.ttft,'s')}</div>${section('prefill',false)}${details('prefill','层数、Attention、有效算力与访存')}</section><section class="core-branch" data-core="decode">${head('Decode：生成能否跟上',speedOK,!hasDecode?'不适用':ignored.has('speed')?'本次求解结果':speedOK?'速度满足':'速度不足')}${hasDecode?`<div class="core-target">${ignored.has('speed')?'':target('speed','客户目标',s.speed,'Token/s/路')}${target('decodeSpeed','当前估算',w.speed,'Token/s/路')}</div>${section('decode',false)}`:'<p>本次只输出1个Token，首Token后即结束，Decode速度不适用。</p>'}${details('decode','末端上下文、带宽与激活权重')}</section>${throughput}</div>${conclusion}`;
 }
 Object.assign(old.meanings,{groupBatch:'最忙实例实际承载的并发，不等于多实例的总并发。',batch:'同时处理请求总数，分配到各实例。',constant:'公式中的常数、单位换算或按当前批量分组的数值。',fullLayers:'当前架构的全注意力层数；混合架构不把全部层计入全KV。',endContext:'生成最后一个输出Token前，已有上下文为输入加输出减1。显存预留仍按输入加输出。',servers:'已有服务器数量，每台卡位参与实例分组。'});
 root.CalculationExplain={...old,render,renderEquation,equations,evaluateExpression:evaluate};
 if(typeof module!=='undefined'&&module.exports){require('./capacity-terms');require('./calculation-numbers');require('./reverse-calculation');}
})(typeof window==='undefined'?globalThis:window);
