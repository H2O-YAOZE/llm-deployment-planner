'use strict';
// Customer-facing, compressed causal routes. Arithmetic stays in PlanningEngine.
(function(root){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const set=s=>new Set(s.split(' '));
 const memory=set('inputK outputK concurrency totalB layers kvWidth kvBytes kvReplication precision weightOverhead memoryGB reserve scratchGB');
 const prefill=set('inputK concurrency activeB totalB precision weightOverhead layers qHeads qkDim vDim attentionFraction matrixTF mfu attentionTF attentionMfu bandwidth bwEff parallelLoss kvWidth kvBytes kvReplication kvTraffic unionGrowth stepMs transportMs ttft');
 const decode=set('inputK outputK concurrency activeB totalB precision weightOverhead layers qHeads qkDim vDim attentionFraction matrixTF mfu attentionTF attentionMfu bandwidth bwEff parallelLoss kvWidth kvBytes kvReplication unionGrowth stepMs speed');
 const topology=set('slots maxTP multiNode servers mode reverseTarget model card');
 const financial=set('cardWan platformWan tdpW hostW pue electricity powerHours days years maintenance');
 const api=set('inputK outputK concurrency ttft speed api apiHit apiMiss apiOut apiCache peakShare days costMode manualDaily');
 const resource=set('matrixTF mfu attentionTF attentionMfu bandwidth bwEff parallelLoss stepMs transportMs');
 const same=(a,b)=>typeof a==='number'&&typeof b==='number'?Math.abs(a-b)<Math.max(1,Math.abs(a),Math.abs(b))*1e-10:Object.is(a,b);
 function routes(s,r,key,D){
  let why='';
  if(s.mode==='reverse'&&r.solve?.meta?.solved===key)why='此项是当前反向模式的求解结果，不是驱动条件。请调整其他条件。';
  else if(s.mode==='reverse'&&r.options?.ignoreTargets?.includes(key))why='此体验目标在当前反向模式中未启用，不参与约束。';
  else if(key==='servers'&&s.mode==='forward')why='“已有服务器”仅在已有硬件模式生效；按需求选配卡会自动求出台数。';
  else if(key==='maxTP'&&(s.mode==='reverse'||!s.multiNode))why='当前模式不使用此搜索上限：单机模式按每台卡位，已有硬件模式按已填设备。';
  else if(key==='reverseTarget'&&s.mode!=='reverse')why='反向求解目标只在已有硬件模式生效。';
  else if(key==='responseSlo'&&!(s.mode==='reverse'&&s.reverseTarget==='output'))why='完整响应限时仅在已有硬件的“最大输出”求解中生效。';
  else if((financial.has(key)||api.has(key))&&s.mode==='reverse'&&!['inputK','outputK','concurrency','ttft','speed'].includes(key))why='已有硬件验证仅求能力边界，当前分支不计算费用。';
  else if(['api','apiHit','apiMiss','apiOut','apiCache','peakShare'].includes(key)&&s.costMode==='manual')why='手动每日账单不使用 Token 单价、缓存命中率或峰谷倍率。';
  else if(key==='manualDaily'&&s.costMode!=='manual')why='12 小时连续调用模式不使用手动每日账单。';
  else if(key==='peakShare'&&!D.apiPrices[s.api]?.peakPricing)why='当前 API 目录未设置峰谷价，峰时占比不参与费用。';
  else if(key==='unionGrowth'&&s.activeB===s.totalB)why='当前为全参数激活，批内权重并集已等于完整权重；专家并集增长不生效。';
  if(why)return {memory:false,prefill:false,decode:false,local:false,api:false,why};
  const config=topology.has(key),response=key==='responseSlo';
  const paths={memory:memory.has(key)||config,prefill:prefill.has(key)||config||response,decode:decode.has(key)||config||response};
  // Different reverse targets also change the solved batch / context in the other constraints.
  if(s.mode==='reverse'&&Object.values(paths).some(Boolean))Object.assign(paths,{memory:true,prefill:true,decode:true});
  paths.local=s.mode==='forward'&&(Object.values(paths).some(Boolean)||financial.has(key));
  paths.api=s.mode==='forward'&&api.has(key)&&(s.costMode==='manual'?['manualDaily','days','costMode'].includes(key):key!=='manualDaily');
  return {...paths,why};
 }
 function minimum(r,kind){
  const flag={memory:'fits',prefill:'ttftOK',decode:'speedOK'}[kind];
  const list=(r.candidates||[]).filter(q=>q.w?.[flag]);
  return list.length?Math.min(...list.map(q=>q.tp)):null;
 }
 function render(ctx,base,current,key){
  const r=current.result,s=r.effectiveState||current.state,old=base.result;
  const A=new Map((old.trace||[]).map(n=>[n.id,n])),B=new Map((r.trace||[]).map(n=>[n.id,n]));
  const path=routes(current.state,r,key,ctx.D),cc={...ctx,s:current.state,result:r};
  const v=id=>B.get(id)?.value;
  const number=(value,unit='')=>{
   let val=value,u=unit;if(typeof val==='number'&&unit.startsWith('FLOP')&&Math.abs(val)>=1e12){val/=1e12;u='T'+unit;}else if(typeof val==='number'&&unit.startsWith('FLOP')&&Math.abs(val)>=1e9){val/=1e9;u='G'+unit;}
   if(typeof val==='number'&&unit.startsWith('bytes')&&Math.abs(val)>=1e9){val/=1e9;u=unit.replace('bytes','GB');}
   return (typeof val==='number'?Number.isFinite(val)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(val):'未计算':String(val??'未计算'))+(u?' '+u:'');
  };
  const chip=(id,val,label,unit='',note='')=>root.CalculationExplain.token(cc,id,typeof val==='number'?val:String(val??'未计算'),label,unit,note);
  const param=k=>chip(k,s[k]*(ctx.fields[k]?.[6]||1),ctx.labels[k]||k,ctx.fields[k]?.[1]||'');
  const token=id=>{const n=B.get(id);return n?root.CalculationExplain.token(cc,id,id==='payback'&&n.value===null?'无有限交点':number(n.value,n.unit),n.title.replaceAll('副本','实例'),''): '<span class="causal-missing">未计算</span>';};
  const previous=id=>{const x=A.get(id),y=B.get(id);return x&&y&&!same(x.value,y.value)?`<small class="causal-before">原 ${esc(number(x.value,x.unit))}</small>`:'';};
  const arrow='<span class="causal-arrow" aria-hidden="true">→</span>';
  const node=(id,title,body,formula='',note='')=>`<article class="causal-node" data-causal-node="${id}"><h3>${esc(title)}</h3><div class="causal-value">${body}</div>${formula?`<div class="causal-simple">${formula}</div>`:''}${note?`<p class="causal-note">${esc(note)}</p>`:''}</article>`;
  const traced=(id,title,formula)=>node(id,title,token(id)+previous(id),formula);
  const floor=kind=>{
   const now=minimum(r,kind),before=minimum(old,kind),labels={memory:'显存约束',prefill:'首 Token 约束',decode:'Decode 约束'};
   const constraints={memory:'权重 + 并发 KV ≤ 可用显存',prefill:'计算 / 访存取较慢，再加附加耗时 ≤ 首 Token 目标',decode:'计算 / 访存取较慢，再加附加耗时 ≤ 每 Token 预算'};
   if(s.mode==='reverse'){
    const proof=r.chosen?.proof?.[{memory:'kv',prefill:'ttft',decode:'decode'}[kind]];
    return node(kind+'Cards',labels[kind]+'的并发边界',proof?.inactive?'本目标未设约束':chip(kind+'Cap',proof?.cap,labels[kind]+'并发边界',proof?'路':'',proof?.capped?'达到搜索上限，表示至少可承接这些并发，不是已证明的物理上限。':'固定已有硬件，在同一方程中求并发边界。'),esc(constraints[kind]),'已有硬件不自动增减卡数');
   }
   return node(kind+'Cards',labels[kind]+'需要的卡数',chip(kind+'Cards',now===null?'未找到':now,labels[kind]+'候选卡数下限',now===null?'':'张','使用当前引擎的全部候选，取单独满足本项约束的最小物理卡数；不是最终配置，也不是实测拓扑保证。')+(before!==now?`<small class="causal-before">原 ${before??'未找到'}${before===null?'':' 张'}</small>`:''),esc(constraints[kind]),s.mode==='reverse'?'已有硬件保持不变，这里是该硬件的约束检查。':'同一组方程，逐个卡数候选验算');
  };
  const row=(kind,label,nodes)=>`<section class="causal-branch" data-causal-branch="${kind}"><div class="causal-branch-label">${label}</div><div class="causal-sequence">${nodes.join(arrow)}</div></section>`;
  const sourceValue=ctx.fields[key]?number(current.state[key]*(ctx.fields[key][6]||1),ctx.fields[key][1]):key==='model'?ctx.D.models[current.state.model]?.name:key==='card'?ctx.D.cards[current.state.card]?.name:key==='precision'?ctx.E.precision[current.state.precision]?.name:key==='api'?ctx.D.apiPrices[current.state.api]?.name:String(current.state[key]);
  const source=chip(key,ctx.fields[key]?current.state[key]*(ctx.fields[key][6]||1):sourceValue,ctx.labels[key]||key,ctx.fields[key]?.[1]||'',ctx.fields[key]?.[5]||'选中的驱动条件；箭头展示它进入哪些计算步骤。未启用的参数不会连向结果。');
  let html=`<div class="causal-heading"><h2>沿着这个变量，看结果怎么来</h2><p>箭头表示影响路径；只展示关键运算，数字悬停查看含义。</p></div><div class="causal-source"><span>从这个变量出发</span>${source}</div>`;
  if(!r.ok)return html+`<div class="notice error">参数无效，计算已停止：${esc((r.errors||[]).join('；'))}。不使用上一次结果继续连线。</div>`;
  if(path.why)return html+`<div class="notice">${esc(path.why)}</div>`;
  if(s.mode==='reverse')html+=`<div class="causal-join" aria-hidden="true">↓</div>${node('reverseSolve','先求当前目标，再检查三项能力',chip('solveAnswer',r.solve?.answer,r.solve?.meta?.answer||'反向求解结果',r.solve?.meta?.unit||''),'固定已有硬件；求解得到的并发或长度，会连带改变各路径工作点')}`;
  const rows=[];
  if(path.memory){
   let steps=[];
   if(['slots','maxTP','multiNode','servers','mode','reverseTarget'].includes(key))steps=[traced('topology','可用的卡数候选','按设备数量、每台卡位与跨机范围枚举')];
   else if(['memoryGB','reserve','scratchGB','card'].includes(key))steps=[node('perCardUsable','每卡可用于权重与 KV 的显存',chip('perCardUsable',r.diagnostics?.perCard,'每卡可用显存','GB'),`${param('memoryGB')} × (1 − ${param('reserve')}) − ${param('scratchGB')}`)];
   else if(key==='model')steps=[node('modelMemory','模型权重与 KV 结构',token('weight')+' / '+token('kv'),'模型参数、层数和 KV 宽度决定占用')];
   else if(['totalB','precision','weightOverhead'].includes(key))steps=[traced('weight','完整模型权重',`${param('totalB')} × 每参数字节 × ${param('weightOverhead')}`)];
   else if(key==='concurrency')steps=[node('allKV','所有并发的 KV',chip('allKV',s.concurrency*r.kvSession,'全部并发的 KV','GB'),`${param('concurrency')} × 单路 KV`)];
   else if(key==='kvReplication')steps=[traced('kvSession','单路 KV 显存','每 Token 字节 × 上下文 × 复制系数 ÷ 10⁹')];
   else if(['layers','kvWidth','kvBytes'].includes(key))steps=[traced('kv','每 Token 的 KV',`${param('layers')} × ${param('kvWidth')} × ${param('kvBytes')}`),traced('kvSession','单路 KV 显存','每 Token 字节 × 上下文 × 复制系数 ÷ 10⁹')];
   else steps=[traced('context','单路上下文','最大输入 + 最大输出'),traced('kvSession','单路 KV 显存',`${param('layers')} × KV 宽度 × 字节 × 上下文 × 复制系数 ÷ 10⁹`)];
   if(!['memoryGB','reserve','scratchGB','card','slots','maxTP','multiNode','servers','mode','reverseTarget'].includes(key))steps.push(node('memoryDemand','权重 + 全部并发 KV',chip('memoryDemand',r.weight+s.concurrency*r.kvSession,'单实例显存需求','GB'),`完整权重 + ${param('concurrency')} × 单路 KV`));
   steps.push(floor('memory'));rows.push(row('memory','显存这条路',steps));
  }
  if(path.prefill){
   let steps=[];
   if(['slots','maxTP','multiNode','servers','mode','reverseTarget'].includes(key))steps=[traced('topology','可用的卡数候选','搜索范围改变，本项可通过的候选也会改变')];
   else if(key==='card')steps=[node('prefillResource','芯片计算与访存能力',param('matrixTF')+' / '+param('bandwidth'),'按芯片目录更新峰值和带宽，利用率仍取当前假设')];
   else if(resource.has(key))steps=[node('prefillResource','有效资源 / 附加耗时',param(key),['bandwidth','bwEff'].includes(key)?'带宽越低，同样输入的访存越慢':['stepMs','transportMs'].includes(key)?'附加耗时直接占用首 Token 预算':'利用率与并行效率，决定峰值能用多少')];
   else if(key==='ttft')steps=[node('prefillBudget','首 Token 可用时间',param('ttft'),'时间要求越紧，越难通过候选校验')];
   else if(['kvWidth','kvBytes','kvReplication','kvTraffic','unionGrowth','totalB','precision','weightOverhead'].includes(key))steps=[node('prefillRead','首批 Prefill 访存量',r.chosen?token('prefillTraffic'):chip('prefillRead','按候选计算','首批访存量'),'批内权重并集 + 并发 × 输入 × KV 字节 × 读写系数')];
   else steps=[node('prefillWork','单路 Prefill 工作量',`<div>参数 ${token('prefillMatrix')}</div><div>Attention ${token('prefillAttention')}</div>`,'参数运算 ∝ 输入；完整 Attention ∝ 输入²'),node('batchWork','全部并发的 Prefill',`<div>参数 ${chip('batchMatrix',number(v('prefillMatrix')*s.concurrency,'FLOP'),'整批参数运算')}</div><div>Attention ${chip('batchAttention',number(v('prefillAttention')*s.concurrency,'FLOP'),'整批 Attention 运算')}</div>`,`${param('concurrency')} × 单路工作量`)];
   if(key==='concurrency')steps=steps.filter(x=>!x.includes('data-causal-node="prefillWork"'));
   steps.push(floor('prefill'));rows.push(row('prefill','首 Token 这条路',steps));
  }
  if(path.decode){
   let steps=[];
   if(['slots','maxTP','multiNode','servers','mode','reverseTarget'].includes(key))steps=[traced('topology','可用的卡数候选','搜索范围改变，本项可通过的候选也会改变')];
   else if(key==='card')steps=[node('decodeResource','芯片计算与访存能力',param('matrixTF')+' / '+param('bandwidth'),'逐步比较计算与访存耗时，不只看带宽')];
   else if(key==='speed')steps=[node('tokenBudget','每个 Token 的时间预算',chip('tokenBudget',1000/s.speed,'每 Token 时间预算','ms'),`1000 ÷ ${param('speed')}`)];
   else if(resource.has(key))steps=[node('decodeResource','生成阶段的有效资源',param(key),'每一步同时受计算、访存和附加耗时限制')];
   else if(['activeB','totalB','precision','weightOverhead','unionGrowth'].includes(key))steps=[node('decodeWeight','每步参数运算 / 权重读取',`<div>运算 ${token('decodeMatrix')}</div><div>读取 ${r.chosen?token('union'):'随批内专家并集计算'}</div>`,'激活参数决定运算；权重并集决定读取量')];
   else if(key==='concurrency')steps=[node('decodeBatch','全部并发的单步负担',`<div>KV ${chip('batchKV',s.concurrency*r.kvSession,'批内每步 KV 读取','GB')}</div><div>Attention ${chip('batchDecodeAttention',number(s.concurrency*v('decodeAttention'),'FLOP'),'批内每步 Attention')}</div>`,'并发 × 单路 KV/Attention；另外读取批内权重并集')];
   else {steps=[node('decodeLoad','每步读取 KV 与计算 Attention',`<div>单路 KV ${token('kvSession')}</div><div>Attention ${token('decodeAttention')}</div>`,`${param('concurrency')} 路同时生成；上下文越长，单步负担越大`)];if(['inputK','outputK'].includes(key))steps.unshift(traced('context','每路生成时的上下文','最大输入 + 最大输出（保守末端检查）'));}
   steps.push(floor('decode'));rows.push(row('decode','Decode 这条路',steps));
  }
  if(rows.length){
   html+=`<div class="causal-branches">${rows.join('')}</div><div class="causal-join" aria-hidden="true">↓</div><section class="causal-merge"><span class="causal-branch-label">三项约束一起检查</span><div class="causal-sequence">${(s.mode==='reverse'?node('joint','固定硬件下的三项并发边界',['kv','ttft','decode'].map(k=>r.chosen?.proof[k]?.inactive?'未约束':(r.chosen?.proof[k]?.cap??'—')+' 路').join(' / '),'显存 / 首 Token / Decode；取共同可行范围'):node('joint','找同时通过的卡数候选',`<span>${minimum(r,'memory')??'—'} / ${minimum(r,'prefill')??'—'} / ${minimum(r,'decode')??'—'} 张</span>`,'显存 / 首 Token / Decode 的候选下限；不相加'))}${arrow}${node('selectedCards',s.mode==='reverse'?'同一实例使用的已有卡':'选出参与计算的卡数',r.chosen?chip('chosenTP',r.chosen.activeCards,'单实例参与计算卡数','张'):'当前范围无可行配置','同时满足约束，再考虑卡位与搜索范围')}${arrow}${node('machines',s.mode==='reverse'?'已有服务器':'整机台数 / 满配卡位',r.chosen?`<div>${chip('serverCount',r.chosen.servers,'服务器数量','台')} · ${chip('purchasedCards',r.chosen.purchasedCards,'整机满配卡位','张')}</div>`:'未计算',`参与卡数按每台 ${param('slots')} 向上取整`)}</div></section>`;
   const absent=[!path.memory?'显存需求':null,!path.prefill?'Prefill 首批负载':null,!path.decode?'Decode 单步负载':null].filter(Boolean);
   if(absent.length)html+=`<p class="causal-scope">未单独展开：${absent.map(esc).join('、')}。它们仍参加最终联合校验；本变量没有直接改变这些路径的输入。</p>`;
   html+=`<p class="causal-scope">${s.mode==='reverse'?'已有硬件不因修改需求而自动增减；只重新求能力边界。':'整机卡位可能不变：例如同一台 8 卡服务器，参与计算从 2 张变 8 张，采购仍为 1 台。'} 跨卡效率、KV 分片和框架适配仍需验证。</p>`;
  }
  if(path.local){
   const moneyNodes=[];
   if(rows.length||['cardWan','platformWan'].includes(key))moneyNodes.push(traced('capex','硬件采购额','（卡位 × 单卡万元价 + 台数 × 平台万元价）× 1万'));
   else if(key==='maintenance')moneyNodes.push(traced('maintenanceCost','月维护准备金','采购额 × 年维护比例 ÷ 12'));
   else if(key==='years')moneyNodes.push(traced('depreciation','每月硬件摊销','采购额 ÷（年限 × 12）'));
   else moneyNodes.push(traced('energy','月电费','设施功率 × 每日时长 × 天数 × 电价'));
   moneyNodes.push(key==='years'?traced('localMonthly','本地每月摊销总成本','摊销 + 电费 + 维护'):node('monthlyOpex','本地月运营费（不含折旧）',chip('monthlyOpex',r.cost?r.cost.energy+r.cost.maintenance:undefined,'本地月运营费','元/月'),'电费 + 维护；回本不再扣一次硬件摊销'));
   moneyNodes.push(key==='years'?traced('localTCO','对比年限总成本','采购额 + 年限内电费与维护'):traced('payback','与 API 的成本交点','采购额 ÷（API 月费 − 本地月运营费）'));
   html+=`<div class="causal-money">${row('local','再影响本地费用',moneyNodes)}</div>`;
  }
  if(path.api){
   let steps=[];
   if(s.costMode==='manual')steps=[traced('dailyAPI','手动每日账单','保留手填金额，不按 Token 数推算')];
   else if(['api','apiHit','apiMiss','apiOut','apiCache','peakShare'].includes(key))steps=[node('apiRates','输入 / 输出有效单价',`<div>${token('apiInputPrice')}</div><div>${token('apiOutputPrice')}</div>`,'按命中率、峰谷比例加权')];
   else if(key==='days')steps=[];
   else steps=[node('apiVolume','12 小时每日 Token 量',`<div>输入 ${token('dailyInput')}</div><div>输出 ${token('dailyOutput')}</div>`,'并发 × 12 小时可完成轮次 × 每轮 Token')];
   if(key!=='days'&&s.costMode!=='manual')steps.push(traced('dailyAPI','每日 API 费用','（输入量 × 输入价 + 输出量 × 输出价）÷ 100万'));
   steps.push(traced('apiMonthly','API 月费','每日费用 × 每月天数'));
   steps.push(traced('payback','与本地部署的成本交点','采购额 ÷（API 月费 − 本地月运营费）'));
   html+=`<section class="causal-api"><p>${rows.length||path.local?'同一个变量的另一条支路：':'直接影响：'}<strong>${esc(ctx.labels[key]||key)}</strong> → 云端费用，不经过本地卡数。</p>${row('api','云端调用这条路',steps)}<p class="causal-scope">12 小时用量是目标体验情景，不是实际账单；月差额不大于零时没有有限交点。</p></section>`;
  }
  if(!rows.length&&!path.local&&!path.api)html+='<p class="notice">此变量在当前分支中没有生效的计算路径。</p>';
  if(!r.feasible&&r.ok)html+='<p class="notice">当前范围未找到满足全部要求的配置。各路径仍可解释，但不生成有效采购结论。</p>';
  return html;
 }
 root.CausalChain={render,routes,minimum};
 if(typeof module!=='undefined')module.exports=root.CausalChain;
})(typeof window==='undefined'?globalThis:window);
