'use strict';
(function(root){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=n=>typeof n!=='number'?String(n??'未计算'):!Number.isFinite(n)?'未计算':n!==0&&Math.abs(n)<.0001?n.toExponential(3):new Intl.NumberFormat('zh-CN',{maximumFractionDigits:4}).format(n);
 const meanings={
  layers:'模型参与计算的 Transformer 层数。每层都要保存相应 KV 状态；其他条件相同时，层数越多，KV 和 Attention 运算越多。',
  totalB:'全部模型参数量，B 表示十亿参数。MoE 也要存储全部专家权重，不能只按每 Token 的激活参数算显存。',
  activeB:'每个 Token 实际激活的参考参数量，单位为十亿参数。用于参数矩阵运算及激活权重流量，不等同于完整模型存储量。',
  kvWidth:'每层、每个 Token 要保存的 KV 元素总数。GQA 通常是 K/V 两份 × KV 头数 × 头维度；MLA 使用压缩宽度参考，不能通用套 GQA 公式。',
  kvHeads:'KV 头数，来自当前模型目录；不是 Q 头数。头分片时，卡数超过 KV 头数可能引入复制，当前仍需显式填写复制系数。',
  headDim:'每个 KV 头的维度，来自模型目录。用于将 KV 头数换算为每层缓存元素数。',
  qHeads:'查询 Q 的头数，参与 QKᵀ 和 AV 的 Attention 运算量计算，不用于替代 KV 头数。',
  qkDim:'每个 Q/K 头参与点积的维度；越大，QKᵀ 计算越多。',
  vDim:'每个 V 头的维度；越大，Attention 权重与 V 相乘的计算越多。',
  kvBytes:'每个 KV 元素占用多少字节。默认 2 bytes，独立于模型权重量化；填 1 不证明设备或框架具备对应 KV 量化内核。',
  weightBytes:'所选权重路径的每参数参考字节数。FP16/BF16 为 2，W8A8/FP8 为 1，W4A16 为 0.5；混合精度层用元数据系数近似。',
  input:'这一次请求的最大输入 Token 数，包含本次携带的历史；不是全天输入量。Prefill 与后续 KV/Attention 都受影响。',
  output:'这一次请求最多生成的 Token 数。影响预留 KV、后段 Decode 和完整响应时间，不直接增加第一次 Prefill 的输入运算。',
  context:'单路预留上下文 = 本次输入 + 本次最大输出；不乘全天请求数。并发占用在后续独立相乘。',
  batch:'此刻同时处理的请求数，不是注册用户或在线总人数。当前页面只运行一个实例，全部并发进入同一实例。',
  groupBatch:'一个实例实际处理的并发。本页为单实例，因此等于本次生效并发；反向最大并发模式使用求出的答案。',
  kvReplication:'KV 存储和读取的额外复制倍数。当前不是自动推导，需要按实际分片方案填写；复制会增加显存和访存量。',
  weightOverhead:'权重、量化元数据等的规划放大系数。1.1 表示在纯权重字节数上增加 10%，不是实测显存预留。',
  memoryGB:'每张物理卡的显存容量，按十进制 GB 计算；不与逻辑 NPU 数重复相乘。',
  reserve:'每张卡为框架、碎片等预留的比例。15% 表示仅剩 85% 可用，之后还要另外扣除 workspace。',
  scratchGB:'每张卡额外扣除的临时工作区。当前是固定规划值，实际会受输入、批量、分块与图捕获影响。',
  chosenTP:'当前检查的单实例物理卡数，不是副本数，也不等于可直接用于框架的逻辑 TP 参数。跨卡通信与实际分片需验证。',
  matrixTF:'所选权重/激活路径的单卡非稀疏矩阵峰值，浮点为 TFLOP/s，INT8 为 TOP/s；不能填广告综合 AI TOPS。',
  attentionTF:'Attention 独立使用的单卡 FP16/BF16 峰值，不能直接替换成 INT8 或 FP8 矩阵峰值。',
  mfu:'参数矩阵计算利用率；峰值乘该比例才是有效算力。属于需要压测校准的规划假设。',
  attentionMfu:'Attention 有效利用率，独立于参数矩阵利用率。长上下文算子、内核实现都会影响它。',
  bandwidth:'单卡标称显存带宽，GB/s。有效值还要乘带宽利用率和跨卡效率。',
  bwEff:'实际有效带宽与标称带宽的比例；不是芯片固定规格，需要目标场景压测。',
  parallelLoss:'单实例卡数每翻倍的统一效率损失。当前 η=(1−损失)^log₂(卡数)，只是通信与扩展效率近似。',
  attentionFraction:'保留的 Attention 运算比例。只缩放运算量，不自动缩小 KV，也不证明稀疏内核达到该加速。',
  kvTraffic:'Prefill KV 写入及分块重读的流量系数，是工程近似；它不直接进入 Decode 流量公式。',
  unionGrowth:'并发增加时，各请求激活专家权重并集的增长系数。不是精确专家路由模型，长输入内部专家变化也未单独模拟。',
  stepMs:'每个 Prefill 阶段或 Decode 步的固定附加耗时，用于规划调度/内核等开销。不是完整跨机通信模型。',
  transportMs:'一次请求额外传输时间，加入首 Token 延迟；不是通过增加 GPU 就一定能降低的时间。',
  ttft:'客户希望最晚多久看到第一个 Token，单位秒；包含本页 Prefill 与额外传输时间。',
  speed:'客户要求的每路生成速度，Token/s/路，不是整个集群的聚合吞吐。',
  billion:'十进制单位换算：1 B 参数 = 10⁹ 个参数；1 GB = 10⁹ bytes。',
  two:'这里的 2 表示一次乘加计作两次运算，或 GQA 的 K/V 两份；每个公式旁的名称会明确区分。',
  one:'固定常数 1，用于表示完整比例或计数，不是另一个用户输入。',
  thousand:'毫秒与秒的单位换算：1000 ms = 1 s。',
  slots:'每台服务器装配的物理卡数量。参与整机取整和采购报价，不是模型副本数。',
  servers:'已有服务器数量。根据合法卡数组合分配实例，不把不同实例的显存合并。',
  responseSlo:'完整答案的限时，包含首 Token 和后续全部输出，仅反向求最大输出时作为额外约束。'
 };
 const modelKeys=new Set(['totalB','activeB','layers','qHeads','qkDim','vDim','kvWidth','kvHeads','headDim','attentionFraction']);
 const cardKeys=new Set(['memoryGB','bandwidth','matrixTF','attentionTF','tdpW','cardWan','platformWan']);
 function provenance(ctx,key,value){
  const s=ctx.result.effectiveState||ctx.s,m=ctx.D.models[s.model],c=ctx.D.cards[s.card],modelDefaults=ctx.E.modelDefaults(m),defaults=ctx.E.defaults(ctx.D);
  if(key==='constant')return '公式中的计数、数学常数或单位换算；带“此批量实例/各自”标签的数值来自已选实例组的实际工作点。';
  if(['expertWeight','denseWeight','expertActiveB','denseActiveB','expertActiveWeight','denseActiveWeight'].includes(key))return '由统一目录 parallelProfile 的专家数、topK、专家层与矩阵形状拆分参数；非专家部分取总量减专家部分。来源：'+(m.parallelProfile?.source||m.configSource||'目录参考')+'。量化组成和访存精度沿用当前精度配置。';
  if(['attentionTP','attentionDP','attentionCards','attentionBatch','cacheBatch','storedWeight','attentionEfficiency','attentionMatrixRate','attentionBandwidthRate'].includes(key))return '当前候选的模型分片与Attention请求分组：Attention TP受头数和输出分组约束；请求均分到DP组，按最忙组整数批量计算。KV预留份数可能多于实际并发，不增加实际请求数。EP路由和通信使用规划效率，实际部署待验证。';
  if(['fullLayers','slidingLayers','linearLayers','window','linearStateElements','linearConvElements','stateBytes','compress4Layers','compress128Layers','indexHeads','indexHeadDim','indexTopk','compressedWindow'].includes(key))return '来自统一模型目录 cacheProfile（层型、窗口、压缩比例、索引与状态结构）。主干层计入，MTP关闭。模型：'+m.name+'。来源：'+(m.configSource||m.source||'目录参考')+'。';
  if(key.startsWith('compressed'))return '由当前模型的压缩层、TopK、滑窗与索引结构推导；展开当前分支可看代入公式。来源：'+(m.cacheProfile?.runtimeSource||m.configSource||m.source)+'。压缩状态更新运算为显式工程近似，并非实测校准。';
  if(['quantB','nonquantB','nonquantBytes','metadataGB','activeBytes'].includes(key))return '来自统一模型目录 precisionProfile 的 '+s.precision+' 精度组成；保留参数 = 完整参数 − 量化参数。来源：'+(m.configSource||m.source||'目录参考')+'。未公开的分组/元数据仍采用目录注明的近似。';
  if(key==='weightBytes')return '来自所选精度：'+ctx.E.precision[s.precision].name+'。';
  if(modelKeys.has(key)){
   if(m.runtimeStructure&&Object.hasOwn(m.runtimeStructure,key))return '来自固定版本推理框架的MLA吸收路径规划维度；不是原始Q/V投影维度。'+m.runtimeStructure.note+' 来源：'+m.runtimeStructure.source+'。当前手动值：'+num(value)+'。';
   const baseline=key in modelDefaults?modelDefaults[key]:m[key];
   const edited=baseline!==undefined&&baseline!==(key in s?s[key]:value);
   const verified=['qHeads','qkDim','vDim','kvWidth'].includes(key)&&m.verifiedStructure?.[key]!==undefined;
   return (edited?'当前值已偏离模型默认值；视为手动/方案输入。默认 '+num(baseline)+'。':verified?'目录中标有官方配置核对记录。':'目录/结构参考值；不是本轮重新核验的官方规格。')+' 模型：'+m.name+'。'+(m.source?'来源：'+m.source+'。':'')+(m.note?'边界：'+m.note:'');
  }
  if(cardKeys.has(key)){
   const baseline=({memoryGB:c.memoryGB,bandwidth:c.bandwidthGBs,matrixTF:c.computeTflops[ctx.E.precision[s.precision].compute],attentionTF:c.computeTflops.fp16,tdpW:c.tdpW,cardWan:c.cardPriceWan,platformWan:c.platformPriceWan})[key];
   return (baseline!==value?'当前值与硬件目录不同，按自填/方案输入计算。':'硬件目录值，不是本场景实测。')+' 芯片：'+c.name+'。'+(c.source?'来源：'+c.source+'。':'')+(c.confidence?'证据等级：'+c.confidence:'')+(c.sourceGaps?.length?'。待补证据：'+c.sourceGaps.join('；'):'');
  }
  if(['billion','two','one','thousand'].includes(key))return '公式定义的常数，不是可调参数。';
  if(key in s)return '来自本次生效的场景/假设输入。'+(ctx.result.solve?.meta.solved===key?'此项已由反向求解得到，不使用原先输入。':key in defaults?'可在对应参数区修改；默认 '+num(defaults[key])+'。':'');
  return '由当前引擎计算得到；与本页实际工作点一致。';
 }
 function token(ctx,key,value,label,unit='',detail=''){
  const n=ctx.result.trace.find(x=>x.id===key),title=label||ctx.labels[key]||n?.title||key;
  const body=detail||meanings[key]||n?.note||ctx.fields?.[key]?.[5]||'本次场景的计算输入；改变它会重新计算下游结果。';
  const from=provenance(ctx,key,value),shown=num(value)+(unit?' '+unit:'');
  const explained=root.CalculationNumbers?.describe(ctx,{key,value,label:title,unit},detail),rich=explained?` data-explain-meaning="${esc(explained.meaning)}" data-explain-origin="${esc(explained.origin)}" data-explain-formula="${esc(explained.formula)}" data-explain-why="${esc(explained.why)}" data-explain-effect="${esc(explained.effect)}" data-explain-steps="${esc(JSON.stringify(explained.steps))}" data-explain-sources="${esc(JSON.stringify(explained.sources))}"`:'';
  return `<span class="calc-factor"><span class="factor-label">${esc(title)}</span><span tabindex="0" class="calc-number" data-explain-key="${esc(key)}" data-explain-title="${esc(title+' · '+shown)}" data-explain-body="${esc(explained?.meaning||body)}" data-explain-source="${esc(explained?.origin||from)}"${rich} aria-label="${esc(title+'：'+shown+'。聚焦查看含义与来源')}">${esc(shown)}</span></span>`;
 }
 function dependencies(ctx,n){const s=ctx.result.effectiveState||ctx.s;return `<div class="explain-dependencies">${n.deps.map(key=>{const dep=ctx.result.trace.find(x=>x.id===key),def=ctx.fields?.[key],value=dep?dep.value:def&&typeof s[key]==='number'?s[key]*(def[6]||1):s[key];return token(ctx,key,value,ctx.labels[key]||dep?.title||key,dep?.unit||def?.[1]||'');}).join('')}</div>`;}
 function render(ctx){
  const r=ctx.result,s=r.effectiveState||ctx.s,m=ctx.D.models[s.model],p=ctx.E.precision[s.precision];
  if(!r.ok)return '<div class="core-empty">先修正上方输入。未完成计算时不展示旧数字，也不把缺失值当成零。</div>';
  const q=r.chosen||r.candidates?.at(-1);if(!q)return '<div class="core-empty">当前范围没有可检查的单实例卡数组合。跨机关闭时，多台设备不能合并成一个实例。</div>';
  const w=q.w,v=Object.fromEntries(r.trace.map(n=>[n.id,n.value]));
  Object.assign(v,{chosenTP:q.tp,groupBatch:q.B,weight:r.weight,kvSession:r.kvSession,used:w.used,usable:w.usable,efficiency:w.eta,matrixRate:w.matrix/1e12,attentionRate:w.attention/1e12,bandwidthRate:w.bw/1e9,union:w.union,prefillComputeTime:w.pCompute,prefillMemoryTime:w.pMemory,prefillTime:w.prefill,ttftResult:w.ttft,decodeComputeTime:w.endCompute,decodeMemoryTime:w.endMemory,decodeStep:w.endStep,decodeSpeed:w.speed,purchasedCards:q.purchasedCards,serverCount:q.servers});
  const t=(key,label,unit='',override,detail='')=>token(ctx,key,override!==undefined?override:key in v?v[key]:s[key],label,unit,detail);
  const op=x=>`<span class="calc-op" aria-hidden="true">${x}</span>`;
  const eq=(name,parts,out)=>`<div class="core-equation"><div class="equation-name">${name}</div><div class="equation-values">${parts.join('')}${out?op('=')+out:''}</div></div>`;
  const head=(name,pass,target)=>`<header class="core-branch-heading"><h3>${name}</h3><span class="core-check ${pass?'pass':'fail'}">${target}</span></header>`;
  const val=(key,label,unit)=>t(key,label,unit);
  const ignored=new Set(r.options?.ignoreTargets||[]),hasDecode=r.O>1,ttftOK=ignored.has('ttft')||w.ttft<=s.ttft,speedOK=!hasDecode||ignored.has('speed')||w.speed>=s.speed;
  const memory=eq('模型权重',[t('totalB','完整参数','B'),op('×'),t('weightBytes','每参数','bytes',p.bytes),op('×'),t('weightOverhead','元数据系数','倍')],t('weight','全量权重','GB'))+
    (m.kvHeads&&s.kvWidth===2*m.kvHeads*m.headDim?eq('每层 KV 宽度',[t('two','K 与 V 两份','',2,'K 和 V 各保存一份，因此乘 2；此处不是乘加 FLOPs 的系数。'),op('×'),t('kvHeads','KV 头数','个',m.kvHeads),op('×'),t('headDim','每头维度','维',m.headDim)],t('kvWidth','每层 KV 宽度','元素')):'')+
    eq('每 Token 的 KV',[t('layers','模型层数','层'),op('×'),t('kvWidth','每层 KV 宽度','元素'),op('×'),t('kvBytes','每元素','bytes')],t('kv','每 Token KV','bytes'))+
    eq('单路预留长度',[t('input','最大输入','Token'),op('+'),t('output','最大输出','Token')],t('context','单路上下文','Token'))+
    eq('单路 KV 显存',[t('kv','每 Token KV','bytes'),op('×'),t('context','单路上下文','Token'),op('×'),t('kvReplication','复制倍数','倍'),op('÷'),t('billion','bytes → GB','',1e9)],t('kvSession','单路峰值 KV','GB'))+
    eq('总显存需求',[t('weight','全量权重','GB'),op('+'),t('groupBatch','同时并发','路'),op('×'),t('kvSession','单路 KV','GB')],t('used','需要','GB'))+
    `<details class="core-assumptions"><summary>可用显存与运行预留</summary>${eq('可用显存',[t('chosenTP','实例用卡','张'),op('× ('),t('memoryGB','单卡显存','GB'),op('× (1 −'),t('reserve','预留','%',s.reserve*100,meanings.reserve),op(') −'),t('scratchGB','每卡工作区','GB'),op(')')],t('usable','可用','GB'))}<p>百分比按小数参与计算；GB 按十进制。KV复制和临时工作区仍需目标框架验证。</p></details>`;
  const computeDetails=`<details class="core-assumptions"><summary>层数、Attention 与有效算力</summary>${eq('每个注意力对',[t('two','乘加计数','',2),op('×'),t('layers','层数','层'),op('×'),t('qHeads','Q头','个'),op('× ('),t('qkDim','QK维度','维'),op('+'),t('vDim','V维度','维'),op(') ×'),t('attentionFraction','运算保留比例','%',s.attentionFraction*100)],t('attentionCoef','每 Token 对','FLOP/对'))}${eq('因果注意力对数',[t('input','输入','Token'),op('× ('),t('input','输入','Token'),op('+ 1) ÷ 2')],t('pairs','因果配对','对'))}${eq('有效矩阵算力',[t('chosenTP','实例用卡','张'),op('×'),t('matrixTF','单卡矩阵峰值','T/s'),op('×'),t('mfu','矩阵利用率','%',s.mfu*100),op('×'),t('efficiency','跨卡效率','倍')],t('matrixRate','有效矩阵','T/s'))}${eq('有效 Attention',[t('chosenTP','实例用卡','张'),op('×'),t('attentionTF','半精度峰值','TFLOP/s'),op('×'),t('attentionMfu','Attention利用率','%',s.attentionMfu*100),op('×'),t('efficiency','跨卡效率','倍')],t('attentionRate','有效 Attention','TFLOP/s'))}${eq('跨卡效率',[op('(1 −'),t('parallelLoss','每翻倍损失','%',s.parallelLoss*100),op(')^log₂('),t('chosenTP','实例用卡','张'),op(')')],t('efficiency','效率','倍'))}<p>百分比按小数参与计算。T=10¹²次运算；这里使用完整 Attention 参考方程，不代表稀疏内核实测。</p></details>`;
  const prefill=eq('参数矩阵运算',[t('two','乘加计数','',2),op('×'),t('activeB','激活参数','B'),op('×'),t('input','输入长度','Token')],t('prefillMatrix','参数运算','TFLOP',v.prefillMatrix/1e12,'2 × 激活参数 × 10⁹ × 输入Token，结果除10¹²显示为TFLOP。B参数与T运算相差1000倍，不能直接用显示值忽略单位。'))+
    eq('Attention 运算',[t('attentionCoef','每Token对','FLOP/对'),op('×'),t('pairs','因果配对','对')],t('prefillAttention','Attention','TFLOP',v.prefillAttention/1e12))+
    eq('计算耗时',[t('groupBatch','并发','路'),op('× ('),t('prefillMatrix','参数运算','TFLOP',v.prefillMatrix/1e12),op('÷'),t('matrixRate','有效矩阵','T/s'),op('+'),t('prefillAttention','Attention','TFLOP',v.prefillAttention/1e12),op('÷'),t('attentionRate','有效 Attention','TFLOP/s'),op(')')],t('prefillComputeTime','计算','s'))+
    eq('首 Token 延迟',[op('max('),t('prefillComputeTime','计算','s'),op(','),t('prefillMemoryTime','访存','s'),op(') +'),t('stepMs','阶段附加','ms'),op('÷ 1000 +'),t('transportMs','额外传输','ms'),op('÷ 1000')],t('ttftResult','预计首字','s'))+
    computeDetails+`<details class="core-assumptions"><summary>Prefill 访存怎么算</summary>${eq('访存耗时',[op('('),t('union','读取权重并集','GB'),op('+'),t('groupBatch','并发','路'),op('×'),t('input','输入','Token'),op('×'),t('kv','每Token KV','bytes'),op('×'),t('kvReplication','复制','倍'),op('×'),t('kvTraffic','KV读写系数','倍'),op('÷ 10⁹) ÷'),t('bandwidthRate','有效带宽','GB/s')],t('prefillMemoryTime','访存','s'))}<p>权重并集与有效带宽的展开公式见 Decode；Prefill 专家读取流量是近似，不是精确内核画像。</p></details>`;
  const decode=hasDecode?eq('末端计算耗时',[t('groupBatch','并发','路'),op('× ('),t('decodeMatrix','参数运算','TFLOP',v.decodeMatrix/1e12),op('÷'),t('matrixRate','有效矩阵','T/s'),op('+'),t('decodeAttention','末端 Attention','TFLOP',v.decodeAttention/1e12),op('÷'),t('attentionRate','有效 Attention','TFLOP/s'),op(')')],t('decodeComputeTime','计算','s/步'))+
    eq('末端访存耗时',[op('('),t('union','读取权重并集','GB'),op('+'),t('groupBatch','并发','路'),op('×'),t('kvSession','末端单路 KV','GB'),op(') ÷'),t('bandwidthRate','有效带宽','GB/s')],t('decodeMemoryTime','访存','s/步'))+
    eq('每步时间',[op('max('),t('decodeComputeTime','计算','s'),op(','),t('decodeMemoryTime','访存','s'),op(') +'),t('stepMs','每步附加','ms'),op('÷ 1000')],t('decodeStep','每步','s'))+
    eq('每路生成速度',[op('1 ÷'),t('decodeStep','每步','s')],t('decodeSpeed','末端速度','Token/s/路'))+
    `<details class="core-assumptions"><summary>带宽、激活参数与专家并集</summary>${eq('有效显存带宽',[t('chosenTP','实例用卡','张'),op('×'),t('bandwidth','单卡带宽','GB/s'),op('×'),t('bwEff','有效比例','%',s.bwEff*100),op('×'),t('efficiency','跨卡效率','倍')],t('bandwidthRate','有效带宽','GB/s'))}${eq('每步参数运算',[t('two','乘加计数','',2),op('×'),t('activeB','激活参数','B')],t('decodeMatrix','参数运算','GFLOP',v.decodeMatrix/1e9))}${eq('末端 Attention',[t('attentionCoef','每Token对','FLOP/对'),op('×'),t('context','末端上下文','Token')],t('decodeAttention','末端运算','TFLOP',v.decodeAttention/1e12))}${eq('读取权重并集',[op('min('),t('weight','全权重','GB'),op(','),t('activeWeight','单路激活权重','GB'),op('× [1 + ('),t('groupBatch','并发','路'),op('− 1) ×'),t('unionGrowth','专家并集增长','%',s.unionGrowth*100),op('])')],t('union','权重并集','GB'))}${eq('单路激活权重',[t('activeB','激活参数','B'),op('×'),t('weightBytes','每参数','bytes',p.bytes),op('×'),t('weightOverhead','元数据系数','倍')],t('activeWeight','激活权重','GB'))}<p>长上下文不能只看带宽；KV读取和Attention计算都随上下文增大。</p></details>`:'<p class="core-explanation">本次只输出1个Token，生成首Token后即结束，没有后续Decode速度指标。</p>';
  const core=`<div class="core-intro"><span>${q.groups||1} 个实例 · 最忙实例 ${q.B} 路并发</span><p>每个带虚线的数字都能悬停或聚焦查看含义与来源；公式直接展示本次代入值。</p></div>${!r.chosen?'<p class="notice">没有找到满足全部目标的配置。下面仅展开搜索中最大规模候选，用于定位原因，不是推荐结果。</p>':''}<div class="core-branches"><section class="core-branch" data-core="memory">${head('显存：能不能装下',w.fits,w.fits?'容量满足':'显存不足')}${memory}</section><section class="core-branch" data-core="prefill">${head('首 Token：能否及时回答',ttftOK,ignored.has('ttft')?'本目标不限制首字':ttftOK?'首字满足':'首字超时')}<div class="core-target">${ignored.has('ttft')?'当前在求速度/首字，不施加首字上限。':t('ttft','客户目标','s')}${t('ttftResult','当前估算','s')}</div>${prefill}</section><section class="core-branch" data-core="decode">${head('Decode：生成能否跟上',speedOK,!hasDecode?'不适用':ignored.has('speed')?'本目标不限制速度':speedOK?'速度满足':'速度不足')}${hasDecode?`<div class="core-target">${ignored.has('speed')?'当前在求速度/首字，不施加速度下限。':t('speed','客户目标','Token/s/路')}${t('decodeSpeed','当前估算','Token/s/路')}</div>`:''}${decode}</section></div>`;
  const mins=[['显存',x=>x.w.fits],['首字',x=>x.w.ttftOK],['Decode',x=>x.w.speedOK]].map(([name,pass])=>{const hit=r.candidates.filter(pass).sort((a,b)=>a.tp-b.tp)[0];return `<span>${name}：${s.mode==='reverse'?(name==='首字'&&ignored.has('ttft')||name==='Decode'&&ignored.has('speed')?'未设目标':hit?'当前规模满足':'当前规模不满足'):hit?t('chosenTP',name+'单项门槛','张',hit.tp,'仅这一项约束在本次候选中的最小卡数；不等于同时满足全部条件的卡数。'):'搜索范围内未满足'}</span>`;}).join('');
  const result=eq(r.feasible?'三项合并后的配置':'当前检查的配置',[t('chosenTP','单实例参与','张'),op('÷'),t('slots','每台卡位','张/台'),op('向上取整')],t('serverCount',s.mode==='reverse'?'已有设备':'所需设备','台'));
  return core+`<section class="core-conclusion"><h3>${r.feasible?(ignored.size?'按当前已设条件检查单实例':'满足三项约束后，再按整机取整'):'不能把“不满足目标”解释成所有设备都跑不动'}</h3><div class="core-minima">${mins}</div>${result}<p>${s.mode==='forward'?'只选一个模型实例；空余卡位计入整机采购，但不自动变成其他副本。':'所填设备共同组成一个模型实例；不按多副本叠加并发。'}当前是物理卡资源近似，框架拓扑、KV复制、通信和稀疏算子仍需验证。</p></section>`;
 }
 let tip,active,showTimer,hideTimer,dismissed;
 function resetTooltip(){clearTimeout(showTimer);clearTimeout(hideTimer);if(active)active.removeAttribute('aria-describedby');active=null;if(tip)tip.hidden=true;}
 function ensure(){if(tip)return;tip=document.createElement('div');tip.id='calc-number-tooltip';tip.className='calc-number-tooltip';tip.setAttribute('role','tooltip');tip.hidden=true;document.body.append(tip);tip.addEventListener('pointerenter',()=>clearTimeout(hideTimer));tip.addEventListener('pointerleave',()=>{hideTimer=setTimeout(resetTooltip,160);});}
 function show(el){
  if(!el?.isConnected||el===dismissed)return;ensure();resetTooltip();active=el;tip.replaceChildren();
  const heading=document.createElement('strong');heading.textContent=el.dataset.explainTitle;tip.append(heading);
  const section=(title,text,fold=false)=>{if(!text)return;const box=document.createElement(fold?'details':'section'),label=document.createElement(fold?'summary':'b'),body=document.createElement('p');label.textContent=title;body.textContent=text;box.append(label,body);tip.append(box);return box;};
  if('explainSteps' in el.dataset){
   section('是什么',el.dataset.explainMeaning);
   section('怎么来的',el.dataset.explainOrigin);
   const steps=JSON.parse(el.dataset.explainSteps||'[]');
   if(steps.length){const list=document.createElement('div');list.className='number-arithmetic';for(const step of steps){const line=document.createElement('div'),name=document.createElement('b'),calc=document.createElement('span'),answer=document.createElement('strong');name.textContent=step.label;calc.textContent=step.calculation;answer.textContent=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:9}).format(step.value)+' '+step.unit;line.append(name,calc,answer);list.append(line);}tip.append(list);}
   section('用途',[el.dataset.explainWhy,el.dataset.explainEffect].filter(Boolean).join(' '));
   const sources=JSON.parse(el.dataset.explainSources||'[]');
   section('各项数值来源',sources.join('\n\n'),true);
   section('完整代入计算',el.dataset.explainFormula,true);
   if(!el.dataset.explainMeaning&&!el.dataset.explainOrigin&&!el.dataset.explainFormula)section('说明','这个数尚缺少具体来源说明。');
  }else{section('说明',el.dataset.explainBody);section('来源',el.dataset.explainSource);}
  tip.hidden=false;el.setAttribute('aria-describedby',tip.id);
  const position=()=>{const a=el.getBoundingClientRect(),b=tip.getBoundingClientRect();tip.style.left=Math.max(10,Math.min(innerWidth-b.width-10,a.left))+'px';let top=a.bottom+9;if(top+b.height>innerHeight-10)top=Math.max(10,a.top-b.height-9);tip.style.top=top+'px';};
  position();tip.querySelectorAll('details').forEach(d=>d.addEventListener('toggle',position));
 }
 function bind(){
  document.addEventListener('pointerover',e=>{const el=e.target.closest('.calc-number');if(!el)return;clearTimeout(hideTimer);if(el===active)return;clearTimeout(showTimer);showTimer=setTimeout(()=>show(el),100);});
  document.addEventListener('pointerout',e=>{const el=e.target.closest('.calc-number');if(!el||el.contains(e.relatedTarget))return;clearTimeout(showTimer);if(dismissed===el)dismissed=null;if(tip?.contains(e.relatedTarget))return;hideTimer=setTimeout(resetTooltip,180);});
  document.addEventListener('focusin',e=>{if(tip?.contains(e.target)){clearTimeout(hideTimer);return;}const el=e.target.closest('.calc-number');if(el){dismissed=null;show(el);}});
  document.addEventListener('focusout',e=>{if(tip?.contains(e.relatedTarget))return;if(e.target.closest('.calc-number')||tip?.contains(e.target))hideTimer=setTimeout(resetTooltip,160);});
  document.addEventListener('pointerup',e=>{if(e.pointerType==='mouse')return;const el=e.target.closest('.calc-number');if(el){dismissed=null;show(el);}else if(!tip?.contains(e.target))resetTooltip();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){dismissed=active;resetTooltip();}});
  document.addEventListener('scroll',e=>{if(tip?.contains(e.target))return;const focused=document.activeElement?.closest('.calc-number');resetTooltip();if(focused)showTimer=setTimeout(()=>{const box=focused.getBoundingClientRect();if(focused===document.activeElement&&box.bottom>0&&box.top<innerHeight)show(focused);},120);},true);root.addEventListener('resize',resetTooltip);
 }
 root.CalculationExplain={render,dependencies,token,meanings,provenance,resetTooltip};
 if(typeof document!=='undefined')bind();
 if(typeof module!=='undefined')module.exports=root.CalculationExplain;
})(typeof window==='undefined'?globalThis:window);
