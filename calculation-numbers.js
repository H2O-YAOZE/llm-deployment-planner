'use strict';
// Each number explains its meaning, arithmetic, purpose and consequence.
(function(root){
 const X=root.CalculationExplain,G=root.CapacityTerms,cache=new WeakMap();
 const fmt=n=>typeof n==='number'?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:9}).format(n):String(n??'未知');
 const near=(a,b)=>typeof a==='number'&&typeof b==='number'&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(b));
 function plain(x){
  if(!x.op)return `${fmt(x.value)}${x.unit?' '+x.unit:''}`;
  const args=x.args.map(plain);
  if(['min','max','ceil','floor','log2'].includes(x.op))return `${({min:'取最小',max:'取最大',ceil:'向上取整',floor:'向下取整',log2:'log₂'})[x.op]}(${args.join('，')})`;
  if(x.op==='pow')return `(${args[0]})^(${args[1]})`;
  return '('+args.join(' '+x.op+' ')+')';
 }
 function rows(ctx){
  if(!cache.has(ctx.result)){
   const normalized={...ctx,s:ctx.result.effectiveState||ctx.s},reverse=normalized.s.mode==='reverse'&&root.ReverseCalculation;
   cache.set(ctx.result,[...(reverse?[...reverse.layoutRows(normalized),...reverse.hardwareRows(normalized),...reverse.targetRows(normalized)]:[]),...X.equations(ctx)]);
  }
  return [...(ctx.explanationRows||[]),...cache.get(ctx.result)];
 }
 function named(x){
  if(!x.op)return `${x.label} ${plain(x)}`;
  const args=x.args.map(named);
  return ['min','max','ceil','floor','log2'].includes(x.op)?`${({min:'取最小值',max:'取最大值',ceil:'向上取整',floor:'向下取整',log2:'log₂'})[x.op]}（${args.join('，')}）`:'（'+args.join(' '+x.op+' ')+ '）';
 }
 function cacheParts(ctx,t){
  const z=ctx.result.formulaContext?.compressed,s=ctx.result.effectiveState||ctx.s;
  if(!z||!['kvSessionBase','kvSession'].includes(t.key))return null;
  const n=ctx.result.S,copies=t.key==='kvSessionBase'?1:ctx.result.chosen.w.replication;
  const parts=[['压缩历史与索引',`${fmt(z.storeSlope)} × ${fmt(n)}`,z.storeSlope*n],['近期滑窗',`${fmt(z.windowSlope)} × ${fmt(Math.min(n,z.W))}`,z.windowSlope*Math.min(n,z.W)],['压缩状态与块取整',fmt(z.fixed),z.fixed]].filter(p=>p[2]!==0);
  const steps=parts.map(([label,calc,bytes])=>({label,calculation:`${calc} ÷ 1,000,000,000`,value:bytes/1e9,unit:'GB'}));
  if(copies!==1)steps.push({label:'按实际缓存副本数预留',calculation:`${fmt(parts.reduce((n,p)=>n+p[2],0)/1e9)} × ${fmt(copies)}`,value:t.value,unit:'GB'});
  steps.push({label:'合计',calculation:copies===1?steps.map(p=>fmt(p.value)).join(' + '):'上一步结果',value:t.value,unit:'GB'});
  return {steps,origin:`每一路按输入 ${fmt(ctx.result.I)} + 输出 ${fmt(ctx.result.O)} = ${fmt(n)} Token 预留缓存。先分别计算下面的存储空间，再相加${copies!==1?`并乘 ${fmt(copies)} 份缓存副本`:''}。`};
 }
 const purposes={
  requestCacheTotal:['将每路请求的缓存乘实际总并发，得到所有请求合计需要的空间。','不包含空闲处理组的容量折算；分到不同实例的请求不会重复计数。'],
  allInstanceWeight:['每个独立实例都要保存自己的权重；按实例数汇总模型占用。','不能让多个独立实例共用一份已经分片的权重来低估显存。'],
  actualMemoryTotal:['把全部实例权重与实际请求缓存相加，回答整个方案需要多少显存。','总量够仍不代表各处理组都装得下，必须继续核对最忙组。'],
  instanceRequestCache:['只计算最忙实例实际接到的请求所需缓存。','该实例的请求数可能少于处理组数，不能把预留份数当作实际并发。'],
  groupWeight:['专家均匀分片，非专家按组复制后，计算每组实际分到的权重。','从每组可用显存扣除此值，剩余空间才能容纳该组请求。'],
  groupUsable:['把扣除运行预留后的显存分到各处理组。','其他组的空闲显存不能直接用来补这个组的缺口。'],
  groupUsed:['最忙组的权重加该组请求的缓存，用它检查局部显存是否够。','即使全体显存合计够，只要此值超过组内可用容量，该方案仍不成立。'],
  prefillInputTotal:['每路输入长度乘这个实例同时接到的请求数，确定需要读取多少输入。','每个Token还需要参数运算和Attention运算，分别除以对应有效算力得到耗时。'],
  reverseHardwareMemory:['先列已有卡的显存总容量，之后扣预留、按实例分配。','独立实例各自保存权重，不能跨实例合并剩余显存来放一条请求。'],
  reverseHardwareUsable:['扣掉框架预留和临时空间，确定真正可给模型与请求使用的容量。','选中实例的用卡数决定其可用容量；随后扣该实例实际权重，剩下空间才放请求缓存。'],
  reverseHardwareMatrix:['列出所选参数精度下已有设备的矩阵算力上限。','后续按实例用卡、利用率和效率折减；本页不会把未核实的其他精度峰值自动套用。'],
  reverseHardwareAttention:['将Attention半精度算力与所选精度的矩阵算力分开。','长输入或长历史的注意力工作量用这一精度的有效速率换成时间。'],
  reverseHardwareBandwidth:['列出已有设备显存读写通道的标称能力。','折减并分到每个实例与请求组后，才能用于计算权重和历史缓存的搬运时间。'],
  weight:['先确定模型本身有多大，再算所选布局的实际权重。','不应直接用它替代有共享复制时的实例权重。'],
  storedWeight:['判断这个实例能否装下，并计算装完权重后还能留给多少条请求。','实际显存容量检查以此数为准；每多复制一组共享权重，能留给请求的空间减少。'],
  denseWeight:['专家部分可以分片；共享部分按请求组复制，因此必须先拆出共享权重。','它乘请求组数进入实例实际权重，进而影响显存允许的最大并发。'],
  expertWeight:['所有专家即使这一步没工作，也要先装到显存中。','影响装载容量；每步计算使用的是激活专家参数，两者不同。'],
  expertParamsB:['从模型结构拆出所有专家参数，避免把完整模型都当共享部分复制。','决定专家权重和共享权重的分界；影响实际显存和每步激活量。'],
  expertActiveB:['生成一个Token只叫部分专家工作，用这些参数估计专家矩阵运算。','增加会增加Prefill和Decode计算时间；不会减少需要装载的所有专家权重。'],
  denseActiveB:['这部分每一路都要计算，且在它所在的请求组内使用算力。','它与激活专家部分相加等于总激活参数，决定参数计算耗时。'],
  prefillMatrix:['把输入处理转成工作量，才能用工作量÷有效算力算秒数。','输入越长、激活参数越多，首Token等待通常越久；并发还需在后续累计。'],
  prefillAttention:['模型必须找出输入各处哪些信息相关；只有参数运算还不足以算首Token时间。','这段工作量除Attention有效算力后进入首Token时间，长上下文尤其明显。'],
  compressedGlobalOps:['对压缩历史找相关信息，并扫描索引来决定选哪些历史。','属于Attention工作量，除Attention有效算力后增加首Token等待。'],
  compressedWindowOps:['最近的输入仍要细看，不能只计算压缩历史。','增加Attention工作量；滑窗达到上限后每个新Token只看固定的近期范围。'],
  compressedTopkOps:['索引选完相关历史后，还要对选出的历史计算注意力。','属于Attention工作量；与前面的索引扫描是两段工作，不是重复并发。'],
  compressedStateOps:['把新输入更新到压缩历史的状态中也需要运算。','这项工程近似计入Attention总量，尚未用内核压测校准。'],
  memoryGB:['先知道已有设备能装多少，才可以扣权重和每路缓存。','容量不足时装不下；容量够不代表响应够快。'],
  bandwidth:['算从显存读权重和历史缓存需要多久。','与读写字节数一起限制生成速度；这是显存带宽，不是卡间互联带宽。'],
  matrixTF:['估计所选精度的参数矩阵工作每秒能完成多少。','实际速率还要乘利用率和跨卡效率；不能把FP4宣传峰值用于FP16或INT8路径。'],
  attentionTF:['计算Attention自己的运算时间，独立于低精度参数矩阵。','在这里按FP16/BF16算力估计，不能直接沿用量化矩阵峰值。'],
  matrixRate:['用实例内可合作的卡估算专家/参数矩阵实际速度。','工作量除它得到计算秒数；这是折减后的规划速率，不是峰值承诺。'],
  attentionRate:['算最忙请求组的Attention需要多久。','注意力工作量除它进入首Token及Decode计算时间，不能把全部卡算力重复给每组。'],
  bandwidthRate:['将本实例需要读的专家权重流量换成时间。','越低，显存搬运越慢，单路速度允许的并发通常越低。'],
  attentionBandwidthRate:['共享权重和每路历史缓存在请求组内读取，需要该组带宽。','不能将整机带宽重复分给每个组；它限制Decode的缓存搬运速度。'],
  prefillComputeTime:['估计读完输入所需的数学计算时间。','与显存搬运时间取较慢的一项，再加附加时间，得到首Token等待。'],
  prefillMemoryTime:['估计输入处理期间权重和缓存读写需要多久。','若比计算更慢，首Token主要受显存搬运限制。'],
  ttftResult:['判断这批请求能否在要求的秒数内开始输出。','求最大并发时逐步加请求；本批通过且再多一路失败，才确定首Token并发边界。'],
  decodeComputeTime:['算生成下一Token的数学计算要多少秒。','与搬运时间取较慢的一项，影响单路生成速度允许多少并发。'],
  decodeMemoryTime:['算生成下一Token所需权重和历史缓存的搬运时间。','如果它更慢，Decode受显存带宽限制；需要改善读取量或有效带宽。'],
  decodeStep:['求这一批每路各生成一个Token需要多久。','单路速度=1÷每步秒数；30 Token/s要求每步不超过约0.0333秒。'],
  decodeSpeed:['检查每一路生成速度是否达到客户要求。','求最大并发时逐步加请求，保留速度仍达标的最大批量。'],
  kvSession:['算每增加一条请求需要额外占多少显存。','实例剩余显存除单路状态得到容量边界；分组峰值预留还需整组取整。'],
  reverseMemoryCapacity:['先求只考虑显存时该实例最多放多少请求。','还要与首Token和单路速度允许的并发取最小值。'],
  reverseTTFTCapacity:['在输入输出固定时，寻找首Token仍达标的最大请求批量。','这是并发限制之一，不是事先填入的并发需求。'],
  reverseDecodeCapacity:['在输入输出固定时，寻找每路生成速度仍达标的最大请求批量。','这是并发限制之一；例如要求30 Token/s，就用30作为下限逐批检验。'],
  caps:['同一批请求必须同时装得下、及时出首字、生成速度达标。','因此取三个上限的最小值，不能相加；再乘独立实例数得到总并发。'],
  solveAnswer:['给出在已有设备和其他固定条件下，这一次选择的目标结果。','不会为得到更好答案暗中增加服务器或修改已固定输入。']
 };
 purposes.groups=['一份模型实例可以同时服务多路请求；这里计算已有设备能运行几份独立模型。','总并发＝每实例达标并发×实例数；多实例会分别占用模型权重空间。'];
 purposes.kvSessionBase=['先计算一路请求保存历史需要多少空间，随后按实际布局计入缓存副本。','与剩余显存一起决定可容纳多少路请求。'];
 function describe(ctx,t,detail=''){
  const s=ctx.result.effectiveState||ctx.s,m=ctx.D.models[s.model],card=ctx.D.cards[s.card],q=ctx.result.chosen;
  const list=rows(ctx),matching=list.filter(row=>(row.result.key===t.key&&(t.key!=='constant'||row.result.label===t.label)||row.id===t.key)&&near(row.result.value,t.value));
  const row=matching.find(row=>(ctx.explanationRows||[]).includes(row))||matching.find(row=>row.id===t.key)||matching[0];
  const entry=G.describe(ctx,t),trace=ctx.result.trace.find(n=>n.id===t.key);
  const parent=(ctx.explanationRows||[])[0];
  let meaning=detail||entry.definition;
  let origin,formula=row?`${plain(row.ast)} ≈ ${fmt(t.value)} ${t.unit}`:'';
  if(t.key==='constant'){
   origin=entry.source;
   if(/测试设备有效/.test(t.label||'')&&q?.w.runtimeProfile){const p=q.w.runtimeProfile;const matrix=/矩阵/.test(t.label);origin=`公开测试使用 ${p.referenceCards} 张卡；按公式对照时的统一假设计算：${p.referenceCards} × ${matrix?p.referenceMatrixTF:p.referenceBandwidth} × ${matrix?p.referenceMfu:p.referenceBwEff} × (1 − ${p.referenceParallelLoss})^log2(${p.referenceCards}) = ${t.value} ${t.unit}。利用率和跨卡效率是对照假设，非官方实测值。`;meaning='把公开测试使用的设备资源与当前设备资源换算；数值来自同一套公式对照假设。';}
   if(/专家参数/.test(t.label||''))origin=`模型结构拆分得到的专家参数为 ${fmt(ctx.result.formulaContext?.parallel?.expertB)} B；量化部分取专家参数与可量化参数两者较小值，剩余部分按保留精度保存。`;
   if(/专家数|专家总数/.test(t.label||'')&&m.parallelProfile)origin=`模型配置每层有 ${m.parallelProfile.experts} 个路由专家，每个Token选择 ${m.parallelProfile.selectedExperts} 个工作。来源：${m.parallelProfile.source}。`;
   if(/隐藏维度|各专家层中间维度|每专家矩阵/.test(t.label||''))origin=`模型配置的隐藏维度和专家矩阵结构；SwiGLU专家有gate、up、down三个矩阵。来源：${m.parallelProfile?.source||m.configSource||m.source}`;
   if(/各专家层中间维度/.test(t.label||'')){const g=m.parallelProfile?.geometry;if(g){origin+=`；${g.intermediateWidths.every(x=>x===g.intermediateWidths[0])?`${g.intermediateWidths.length} 层 × 每层 ${g.intermediateWidths[0]} = ${g.intermediateSum}`:`各专家层维度相加 = ${g.intermediateSum}`}。`;}}
   if(/TopK等效|窗口|上限|滑窗|压缩比例/.test(t.label||'')&&ctx.result.formulaContext?.compressed){const z=ctx.result.formulaContext.compressed;origin=`来自模型的压缩、索引和滑窗配置。当前滑窗${z.W} Token、索引TopK ${z.K}个位置，选中历史等效上限${z.selectionWindow} Token。来源：${m.cacheProfile?.source||m.configSource||m.source}`;}
   if(/压缩状态元素|状态元素/.test(t.label||'')&&ctx.result.formulaContext?.compressed?.kind==='deepseek-v4'){const z=ctx.result.formulaContext.compressed;origin=`运行时压缩状态规划：${z.c4} × 4 × 4 × (${s.kvWidth} + ${m.cacheProfile.indexHeadDim}) + ${z.c128} × 128 × 2 × ${s.kvWidth} = ${fmt(z.stateElements)} 个元素。来源：${m.cacheProfile.runtimeSource}。`;}
  }else if(row){
   origin=`${named(row.ast)} = ${fmt(t.value)} ${t.unit}。`;
  }else if(t.key==='input'||t.key==='output'){
   origin=`来自客户填入的${t.key==='input'?'最大输入':'最大输出'}长度，K按1000 Token换算。`;
   formula=`${fmt(t.value/1000)} K × 1,000 = ${fmt(t.value)} Token`;
  }else if(t.key==='weightBytes')origin=`所选权重精度${ctx.E.precision[s.precision].name}的字节定义；8位=1字节。`;
  else if(['memoryGB','bandwidth','matrixTF','attentionTF'].includes(t.key))origin=X.provenance(ctx,t.key,t.value);
  else if(Object.hasOwn(s,t.key))origin=`来自本页设置的“${t.label}”：${fmt(t.value)} ${t.unit}。${ctx.result.solve?.meta.solved===t.key?'这是本次反向计算解出的值。':''}`;
  else origin=/由当前引擎|按本页|本次场景|当前计算值/.test(entry.source)?'':entry.source;
  if(!entry.known&&!detail)meaning=trace?.note||'';
  const resourceMeanings={reverseHardwareMemory:'全部已有物理卡的标称显存容量合计；这是存储空间，单位GB。',reverseHardwareMatrix:'所选参数计算精度下，已有卡每秒理论上能做的矩阵运算合计；尚未扣除利用率与扩展损失。',reverseHardwareAttention:'已有卡的FP16/BF16矩阵峰值合计，作为Attention独立的硬件参考。',reverseHardwareBandwidth:'全部已有卡的标称显存读写带宽合计；单位GB/s，区别于显存容量GB和卡间互联带宽。',reverseHardwareUsable:'扣掉框架与碎片预留、临时工作区之后的全部显存合计；后续要分别分给每个独立实例。',expertParamsB:'模型所有路由专家矩阵中的参数数量。按专家矩阵结构、维度、专家层数和每层专家数量计算，B表示十亿参数。'};
  if(resourceMeanings[t.key])meaning=resourceMeanings[t.key];
  let [why,effect]=purposes[t.key]||['',''];
  if(['runtimeFixed','runtimeSlope','runtimeStep'].includes(t.key)&&q?.w.runtimeProfile){
   const p=q.w.runtimeProfile;
   meaning=t.key==='runtimeStep'?'公开测试的生成时间比纯算力、带宽公式更慢；这里补入公式没有覆盖的耗时，再计算单路速度。':'同模型、FP8和H200公开测试与纯公式的耗时差；是规划修正，不是硬件规格。';
   const one=p.samples.find(a=>a.batch===1),multi=p.samples.filter(a=>a.batch>1);
   origin=`测试为4张H200、8192输入/1024输出，统计为P50，包含推测解码。${one?`固定差 = ${one.observedTPOT} − ${one.analyticMeanStep} = ${p.fixedSeconds} 秒。`:''}每路增长 = max(${multi.map(a=>`(${a.observedTPOT} − ${a.analyticMeanStep} − ${p.fixedSeconds}) ÷ ${a.batch}`).join(', ')}) = ${p.perRequestSeconds} 秒/路。来源：${p.samples[0].source}。长度和设备数量迁移仍是估算。`;
   why='避免把批内权重共享的理论收益直接当成真实服务速度。';effect='补充耗时随实例并发增加，可能降低单路速度并要求更多实例和设备。';
  }
  const section=row?.section||parent?.section;
  if(t.key==='storedWeight'&&q)formula+=`。装载按 ${fmt(q.w.storedWeight)} GB/实例计；${q.groups} 个实例各存一份，不跨实例合并显存。`;
  if(t.key==='groups'&&s.mode==='reverse'&&q){meaning='一份独立运行的模型称为一个实例，每份模型可以同时接多路请求。';origin=q.tp<=s.slots?`每台有 ${s.slots} 张卡，每实例分 ${q.tp} 张，一台能放 ${Math.floor(s.slots/q.tp)} 个实例；${s.servers} 台共能放 ${q.groups} 个。`:`每实例需要跨 ${Math.ceil(q.tp/s.slots)} 台服务器，已有 ${s.servers} 台，共可运行 ${q.groups} 个实例。`;if(s.topologyMode==='single')origin='部署方式选择了“单模型实例”，所以只运行1个实例。';}
  if(t.key==='chosenTP'&&q){meaning='给一份独立运行的模型分配的物理卡数。';origin=s.mode==='reverse'?`比较已有 ${s.servers*s.slots} 张卡的合法分组，按“${ctx.result.solve?.meta.name||'最大并发'}”选择。所选每实例 ${q.tp} 张，可运行 ${q.groups} 个实例；各方案的结果见“为什么这样分卡”。`:`逐一检查不同实例卡数和实例数量，保留满足本次要求的方案，有完整服务器报价时按采购额比较，否则按卡数比较；同价优先减少每实例跨机台数，再减少实例数。选中每实例 ${q.tp} 张，共 ${q.groups} 个实例。`;}
  if(t.key==='caps'&&q){meaning='一个实例同时满足显存、首Token和单路速度要求的并发上限。';origin=`取显存 ${q.kvCap} 路、首Token ${q.ttftCap} 路、单路速度 ${q.decodeCap} 路三者最小值 = ${q.bcap} 路。`;}
  const breakdown=cacheParts(ctx,t);if(breakdown)origin=breakdown.origin;
  const sources=[];
  if(row){const seen=new Set();function walk(x){if(x.op){x.args.forEach(walk);return;}const dep=list.find(r=>r!==row&&(r.id===x.key||r.result.key===x.key&&x.key!=='constant')&&near(r.result.value,x.value));if(dep&&!seen.has(dep.id)){seen.add(dep.id);sources.push(`${x.label} ${plain(x)}：${named(dep.ast)} = ${fmt(x.value)} ${x.unit}`);}}walk(row.ast);}
  const z=ctx.result.formulaContext?.compressed;
  if(z?.kind==='deepseek-v4'&&(breakdown||t.key==='compressedState')){
   sources.push(`压缩层数量：模型配置 ${z.c4} 层采用4倍压缩，${z.c128} 层采用128倍压缩；共享KV宽度 ${s.kvWidth}，索引宽度 ${m.cacheProfile.indexHeadDim}，缓存每元素 ${s.kvBytes} 字节。来源：${m.cacheProfile.source||m.configSource||m.source}。`);
   sources.push(`压缩状态元素数：${z.c4} × 4 × 4 × (${s.kvWidth} + ${m.cacheProfile.indexHeadDim}) + ${z.c128} × 128 × 2 × ${s.kvWidth} = ${fmt(z.stateElements)}。状态按FP32保存，每元素4字节；另外加各压缩层及索引的一块取整预留。运行时依据：${m.cacheProfile.runtimeSource||'目录运行时结构'}。`);
  }
  const clean=str=>String(str||'').replaceAll('当前引擎','规划公式').replaceAll('求解器','逐批试算').replaceAll('工作点','请求批量和设备分配');
  const vague=/本公式中的数学常数|来自本公式标明|本次场景的计算输入|一项条件或中间结果|紧邻它的|当前计算值/;
  if(vague.test(meaning))meaning='';if(vague.test(origin))origin='';
  if(t.key==='constant'){
   const specific={
    '参数 → B':'B表示十亿参数；参数个数除以1,000,000,000得到B。',
    '头分片复制':`缓存复制由模型的KV头分片决定：当前Attention组有 ${q?.attentionTP} 个逻辑设备，${m.kvHeads?`模型有 ${m.kvHeads} 个KV头；设备多于KV头时要复制，`:'共享缓存需在组内设备各保留一份，'}此布局复制 ${t.value} 份。`,
    '递归状态元素':`模型目录 cacheProfile.linearStateElements = ${m.cacheProfile?.linearStateElements}，表示每个递归层为一路请求保存的状态元素数。`,
    '卷积状态元素':`模型目录 cacheProfile.linearConvElements = ${m.cacheProfile?.linearConvElements}，表示每个递归层为一路请求保存的卷积状态元素数。`,
    '状态元素':`模型目录记录每个递归层的状态元素数为 ${m.cacheProfile?.linearStateElements}；按层数累计更新运算量。`,
    '每元素':`此项状态每元素占 ${t.value} 字节，相当于 ${t.value*8} 位存储；状态精度与模型权重精度分别设置。`,
    '固定状态':`递归与卷积状态按层数、每层元素数和每元素字节数计算，合计 ${fmt((ctx.result.formulaContext?.linearFixed||0)/1e9)} GB；此部分不随历史Token数线性增长。`,
    '目录层数':`模型目录记录 ${m.layers} 层；与手填层数相比，按比例调整专家参数。`,
    '保留精度':`未量化参数每个占 ${fmt(t.value)} 字节，来自所选精度及模型混合精度配置。`,
    '激活总量':`所选模型每Token激活 ${s.activeB} B 参数，包括专家和共享部分。`,
    '专家完整参数':`模型专家几何计算结果为 ${fmt(ctx.result.formulaContext?.parallel?.expertB)} B；推导见“所有专家参数如何得到”。`,
    '模型逻辑设备':`${q?.tp} 张物理卡 × 每卡 ${card.logicalDevicesPerModule||1} 个计算设备 = ${q?.logicalTP} 个。`,
    '每卡逻辑设备':`目录中每张 ${card.name} 包含 ${card.logicalDevicesPerModule||1} 个逻辑计算设备；物理卡数量与逻辑设备数量分开计数。`,
    '此批量实例':`将 ${s.concurrency} 路请求尽量平均分给 ${q?.groups} 个实例；这里是承接相同批量的实例数量。`,
    '每实例并发':`将 ${s.concurrency} 路请求尽量平均分给 ${q?.groups} 个实例；请求数不能有小数，余数逐个分配。`,
    '各自完整响应':'这一批量的首Token等待，加上剩余输出逐Token的生成时间。不同批量分别计算，最后汇总各实例的吞吐。',
    '各自末端速度':'对这一批量，在生成最后一个Token时，用1除以每步生成秒数。不同批量各算自己的速度。',
    '活跃实例':`已布置 ${q?.groups} 个实例，有 ${s.concurrency} 路请求；活跃实例取两者较小值 ${q?.activeGroups}。`,
    '缓存按请求组取整':`本实例分成 ${q?.attentionDP} 个请求组；各组按最忙组预留缓存，所以容量按 ${q?.attentionDP} 路一组取整。`,
    '请求组数':`本实例有 ${q?.logicalTP} 个逻辑设备，每个请求组用 ${q?.attentionTP} 个，分为 ${q?.attentionDP} 组。`,
    '每实例搜索上限':'本次最多检查100,000路；到达此数表示搜索边界，不代表硬件的真实极限。',
    '总并发搜索上限':'总并发最多检查100,000路；到达此数表示搜索边界，不代表硬件的真实极限。'
   };
   if(specific[t.label])meaning=specific[t.label];
  }
  return {meaning:clean(meaning),origin:clean(origin),formula,why:clean(why),effect:clean(effect),steps:breakdown?.steps||[],sources};
 }
 root.CalculationNumbers={describe,plain,purposes};
 if(typeof module!=='undefined')module.exports=root.CalculationNumbers;
})(typeof window==='undefined'?globalThis:window);
