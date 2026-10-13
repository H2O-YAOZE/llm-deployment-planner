'use strict';
// Reverse explanations start with fixed resources and end at the selected unknown.
(function(root){
 const node=typeof module!=='undefined'&&module.exports;
 if(node&&!root.CalculationExplain?.equations){require('./calculation-explain');require('./calculation-v5-ui');}
 const X=root.CalculationExplain;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names={concurrency:'最大并发',speed:'最高单路生成速度',ttft:'最低首 Token 延迟',input:'最大输入长度',output:'最大输出长度',throughput:'最大总吞吐'};
 const v=(key,label,value,unit='')=>({key,label,value,unit}),op=(op,...args)=>({op,args}),mul=(...a)=>op('×',...a),div=(...a)=>op('÷',...a),sub=(...a)=>op('−',...a),min=(...a)=>op('min',...a);
 const floor=x=>op('floor',x),ceil=x=>op('ceil',x),constant=(n,label='换算')=>v('constant',label,n);
 const normalized=ctx=>({...ctx,s:ctx.result.effectiveState||ctx.s});
 const number=(ctx,key,label,value,unit='',definition='')=>X.token(ctx,key,value,label,unit,definition);
 const equation=(ctx,row,prefix='overview-')=>`<article class="core-equation reverse-equation" id="${prefix+row.id}" data-equation="${row.id}" tabindex="-1"><h4 class="equation-name">${esc(row.title)}</h4>${X.renderEquation(ctx,row)}</article>`;
 function fixed(ctx){
  const s=ctx.s,r=ctx.result,meta=r.solve?.meta||root.ReverseSolver?.targets[s.reverseTarget],labels={concurrency:['同时请求',s.concurrency,'路'],inputK:['输入',Math.round(s.inputK*1000),'Token'],outputK:['输出',Math.round(s.outputK*1000),'Token'],ttft:['首 Token 上限',s.ttft,'s'],speed:['单路速度下限',s.speed,'Token/s/路'],responseSlo:['完整答案限时',s.responseSlo,'s'],throughput:['总吞吐下限',s.throughput,'Token/s']};
  return `<div class="reverse-known"><span><b>设备固定</b>${esc(ctx.D.cards[s.card]?.name)} · ${number(ctx,'servers','已有设备',s.servers,'台')} × ${number(ctx,'slots','每台卡数',s.slots,'张/台')}</span><span><b>模型固定</b>${esc(ctx.D.models[s.model]?.name)} · ${esc(ctx.E.precision[s.precision]?.name)}</span>${(meta?.conditions||[]).filter(k=>labels[k]&&(k!=='throughput'||s.throughput>0)).map(k=>{const [label,val,unit]=labels[k];return `<span data-fixed-input="${k}">${number(ctx,k,label,val,unit)}</span>`;}).join('')}</div>`;
 }
 function layoutRows(ctx){
  const s=ctx.s,q=ctx.result.chosen;if(!q)return [];
  const cards=v('reverseHardwareCards','固定总卡数',s.servers*s.slots,'张'),tp=v('chosenTP','选中每实例用卡',q.tp,'张/实例'),groups=v('groups','可布置实例',q.groups,'个');
  const groupAST=s.topologyMode==='single'?constant(1,'固定单实例'):q.tp<=s.slots?mul(v('servers','已有服务器',s.servers,'台'),floor(div(v('slots','每台卡数',s.slots,'张'),tp))):floor(div(v('servers','已有服务器',s.servers,'台'),ceil(div(tp,v('slots','每台卡数',s.slots,'张/台')))));
  return [{id:'reverseHardwareCards',title:'先算已有卡数',ast:mul(v('servers','已有设备',s.servers,'台'),v('slots','每台卡数',s.slots,'张/台')),result:cards},
   {id:'reverseInstanceCount',title:'用已有设备布置模型实例',ast:groupAST,result:groups},
   {id:'reverseAllocatedCards',title:'实例占用的卡数',ast:mul(groups,tp),result:v('reverseAllocatedCards','布置用卡',q.allocatedCards,'张')}];
 }
 function hardwareRows(ctx){
  const s=ctx.s,cards=v('reverseHardwareCards','已有总卡数',s.servers*s.slots,'张'),rows=[];
  const resource=(id,title,key,label,unit)=>{if(Number.isFinite(s[key]))rows.push({id,title,ast:mul(cards,v(key,label,s[key],unit)),result:v(id,title,s.servers*s.slots*s[key],unit==='GB'?'GB':unit),section:'deployment'});};
  resource('reverseHardwareMemory','已有总显存','memoryGB','单卡显存','GB');
  resource('reverseHardwareMatrix','所选精度的矩阵峰值合计','matrixTF','单卡矩阵峰值',ctx.E.precision[s.precision]?.compute==='int8'?'TOP/s':'TFLOP/s');
  resource('reverseHardwareAttention','Attention半精度峰值合计','attentionTF','单卡Attention峰值','TFLOP/s');
  resource('reverseHardwareBandwidth','显存带宽标称合计','bandwidth','单卡显存带宽','GB/s');
  if(Number.isFinite(s.memoryGB))rows.push({id:'reverseHardwareUsable',title:'扣除预留后可用于模型和缓存的显存',ast:mul(cards,sub(mul(v('memoryGB','单卡显存',s.memoryGB,'GB'),sub(constant(1,'完整比例'),v('reserve','框架预留比例',s.reserve))),v('scratchGB','每卡临时工作区',s.scratchGB,'GB'))),result:v('reverseHardwareUsable','可用显存合计',s.servers*s.slots*(s.memoryGB*(1-s.reserve)-s.scratchGB),'GB'),section:'memory'});
  return rows;
 }
 function resources(ctx){
  const card=ctx.D.cards[ctx.s.card],all=hardwareRows(ctx),usable=all.find(r=>r.id==='reverseHardwareUsable');
  const titles=['总显存','参数运算峰值','Attention运算峰值','显存带宽'],uses=['存模型和请求缓存','计算模型参数','计算上下文之间的关系','读取权重和历史缓存'];
  return `<div class="reverse-resources">${all.slice(0,4).map((row,i)=>{const scoped={...ctx,explanationRows:[row]};return `<article class="resource-item" id="overview-${row.id}" data-equation="${row.id}"><h4>${titles[i]}</h4><div class="resource-value">${number(scoped,row.result.key,row.result.label,row.result.value,row.result.unit)}</div><p>${ctx.s.servers*ctx.s.slots} 张 × ${row.ast.args[1].value.toLocaleString('zh-CN')} ${esc(row.ast.args[1].unit)} / 张</p><small>${uses[i]}</small>${i===0&&usable?`<details class="reverse-bound-proof"><summary>扣预留后可用 ${usable.result.value.toLocaleString('zh-CN')} GB</summary>${equation(ctx,usable)}</details>`:''}</article>`;}).join('')}</div><p class="reverse-step-note">算力、带宽是标称合计；实际计算还会扣除利用率和多卡协作损失。${card.specStatus!=='official-spec'?'本芯片规格尚待核实，按目录规划值估算。':''}</p><details class="reverse-bound-proof"><summary>显存带宽与卡间互联有什么区别？</summary><p>显存带宽决定从卡上读取数据的速度；卡间互联决定卡与卡传送数据的速度。该设备互联资料：${esc(card.interconnect||'尚无核实数值')}。目前用多卡效率估算协作损失。</p></details>`;
 }
 function layoutChoice(ctx){
  const r=ctx.result,q=r.chosen,s=ctx.s,z=r.solve,lower=z.target==='ttft';
  const pool=(z.alternatives||[]).filter(a=>a.valid&&Number.isFinite(a.value)),best=new Map();
  for(const a of pool){const old=best.get(a.tp);if(!old||(lower?a.value<old.value:a.value>old.value)||a.id===q.id)best.set(a.tp,a);}
  const selected=pool.find(a=>a.id===q.id),other=[...best.values()].filter(a=>a.id!==q.id).sort((a,b)=>b.tp-a.tp)[0];
  const f=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(n);
  const table=items=>`<div class="layout-comparison"><table><thead><tr><th>分卡方式</th>${z.target==='concurrency'?'<th>每实例并发</th>':''}<th>${esc(names[z.target])}</th><th>选择</th></tr></thead><tbody>${items.map(a=>`<tr${a.id===q.id?' class="selected-layout"':''}><td>${a.tp} 张 / 实例 × ${a.groups} 个</td>${z.target==='concurrency'?`<td>${f(a.perInstance)} 路</td>`:''}<td>${f(a.value)} ${esc(z.meta.unit)}</td><td>${a.id===q.id?'当前方案':'可行方案'}</td></tr>`).join('')}</tbody></table></div>`;
  let reason=selected&&other?`${q.tp} 张一组的${names[z.target]}估算为 ${f(selected.value)} ${z.meta.unit}；${other.tp} 张一组为 ${f(other.value)} ${z.meta.unit}。`: '在已检查且满足固定条件的分卡方案中选择。';
  if(selected&&other){const delta=Math.abs(selected.value-other.value),ratio=delta/Math.max(Math.abs(other.value),1e-9);reason+=delta<1e-9?' 两者结果相同，按每实例跨机台数更少、实例数更少的次序选择；不代表性能更好。':ratio<.05?' 差异不足5%，不足以认定实际部署有明显优势。':` 当前按“${names[z.target]}”选择；实际差距需压测核对。`;}
  const scoped={...ctx,explanationRows:layoutRows(ctx)};
  return `<p class="reverse-step-note">一个实例是一份独立运行的模型，可以同时服务多路请求。比较分卡方式，选择本次目标表现较好的方案。</p><div class="layout-decision">${number(scoped,'chosenTP','每实例分配',q.tp,'张')}<span aria-hidden="true">→</span>${number(scoped,'groups','可运行实例',q.groups,'个')}${s.servers*s.slots>q.allocatedCards?`<small>剩余 ${s.servers*s.slots-q.allocatedCards} 张卡未分配</small>`:''}</div>${selected?table([selected,...(other?[other]:[])]):''}<p class="reverse-step-note">${esc(reason)}搜索范围为同规格实例、均衡分配请求。</p><details class="reverse-bound-proof"><summary>实例数如何计算 · 其他分卡方案</summary>${equation(scoped,layoutRows(ctx)[1])}${pool.length>2?table([...best.values()].sort((a,b)=>a.tp-b.tp)):''}</details>`;
 }
 function targetRows(ctx){
  const r=ctx.result,q=r.chosen;if(!r.solve||!q||!r.feasible)return [];
  const s=ctx.s,t=r.solve.target,templates=X.equations(ctx),take=ids=>ids.map(id=>templates.find(row=>row.id===id)).filter(Boolean);
  if(t==='concurrency'){
   const w=q.w,DP=r.formulaContext.parallel?q.attentionDP:1,capLimit=root.ReverseSolver?.MAX_CONCURRENCY||100000;
   const space=sub(v('usable','实例可用显存',w.usable,'GB'),v('storedWeight','实例已存权重',w.storedWeight,'GB')),session=v('kvSession','每路峰值状态',w.kvSession,'GB');
   const memoryCapacity=DP===1?floor(div(space,session)):mul(constant(DP,'缓存按请求组取整'),floor(div(space,mul(constant(DP,'请求组数'),session))));
   const capacity=q.proof.kv.capped?min(constant(capLimit,'每实例搜索上限'),memoryCapacity):memoryCapacity;
   const total=mul(v('groups','已有设备可布置',q.groups,'实例'),v('caps','每实例可接',q.bcap,'路/实例'));
   return [{id:'reverseMemoryCapacity',title:'显存最多容纳多少路',ast:capacity,result:v('reverseMemoryCapacity','每实例显存上限',q.kvCap,'路')},
    {id:'caps',title:'每实例同时满足三个固定条件的并发',ast:min(v('reverseMemoryCapacity','显存上限',q.kvCap,'路'),v('reverseTTFTCapacity','首 Token 上限允许',q.ttftCap,'路'),v('reverseDecodeCapacity','单路速度下限允许',q.decodeCap,'路')),result:v('caps','每实例并发上限',q.bcap,'路')},
    {id:'solveAnswer',title:'最后解出总并发',ast:q.capacity>capLimit?min(total,constant(capLimit,'总并发搜索上限')):total,result:v('solveAnswer','最大并发',r.solve.answer,'路')}];
  }
  if(t==='speed')return take(['groupBatch','decodeComputeTime','decodeMemoryTime','decodeStep','decodeSpeed']);
  if(t==='ttft')return take(['groupBatch','prefillComputeTime','prefillMemoryTime','prefillTime','ttftResult']);
  if(t==='throughput')return take(['groupBatch','response',s.throughputMetric==='requests'?'completedRequests':s.throughputMetric==='decode-output'?'totalDecodeThroughput':'totalOutputThroughput']);
  return [];
 }
 function atBatch(ctx,B){
  const q=ctx.result.chosen,w=q.w,rows=X.equations(ctx),AB=ctx.result.formulaContext.parallel?Math.ceil(B/q.attentionDP):B,values={groupBatch:B,attentionBatch:AB,cacheBatch:AB*q.attentionDP};
  function replace(ast){return ast.op?{...ast,args:ast.args.map(replace)}:{...ast,value:Object.hasOwn(values,ast.key)?values[ast.key]:ast.value};}
  const computed=[];
  for(const id of ['union','prefillComputeTime','prefillMemoryTime','prefillTime','ttftResult','decodeComputeTime','decodeMemoryTime','runtimeStep','decodeStep','decodeSpeed']){
   const template=rows.find(row=>row.id===id);if(!template)continue;const ast=replace(template.ast),value=X.evaluateExpression(ast);values[id]=value;computed.push({...template,ast,result:{...template.result,value}});
  }
  return {B,rows:computed,ttft:values.ttftResult,speed:values.decodeSpeed,used:w.storedWeight+(ctx.result.formulaContext.parallel?AB*q.attentionDP:B)*w.kvSession};
 }
 function capProof(ctx,kind){
  const p=ctx.result.chosen.proof[kind],q=ctx.result.chosen,labels={kv:'显存',ttft:'首 Token',decode:'单路速度'},key={kv:'reverseMemoryCapacity',ttft:'reverseTTFTCapacity',decode:'reverseDecodeCapacity'}[kind];
  if(p.inactive)return `<p>${kind==='decode'?'只输出首 Token，无后续 Decode，单路生成速度不限制并发。':'此项未作为本次约束。'}</p>`;
  const unit=kind==='kv'?'GB':kind==='ttft'?'s':'Token/s/路',compare=kind==='decode'?'≥':'≤';
  let proof=`<p>在选中实例布局中，逐步增加请求数，检查${labels[kind]}条件。</p><div class="reverse-bound-pair">${number(ctx,key,'边界批量',p.cap,'路/实例')}：${number(ctx,'constant',labels[kind]+'在边界处的值',p.at,unit,`保持同一实例布局，代入${p.cap}路后得到。`)} ${compare} ${number(ctx,'constant','固定条件',p.limit,unit)}</div>`;
  if(ctx.result.formulaContext.parallel&&kind!=='kv'&&p.cap>0)proof+=`<p>请求分到 ${q.attentionDP} 个组，按最忙组计算：${p.cap} ÷ ${q.attentionDP} 向上取整＝${Math.ceil(p.cap/q.attentionDP)} 路/组。${p.next!==null?`加一路后变为 ${Math.ceil((p.cap+1)/q.attentionDP)} 路/组；组内工作量按这个批量累计。`:''}</p>`;
  if(p.next!==null)proof+=`<div class="reverse-bound-pair">${number(ctx,'constant','再加一路',p.cap+1,'路/实例')}：${number(ctx,'constant',labels[kind]+'多一路后的值',p.next,unit,`同一布局代入${p.cap+1}路后得到；不修改其他已知条件。`)} ${kind==='decode'?'<':'>'} ${number(ctx,'constant','固定条件',p.limit,unit)}，不通过。</div>`;
  else proof+='<p>已到当前搜索上限，边界之外尚未搜索。</p>';
  if(p.cap>0){
   const work=atBatch(ctx,p.cap),ids=kind==='ttft'?['prefillComputeTime','prefillMemoryTime','ttftResult']:kind==='decode'?['decodeComputeTime','decodeMemoryTime','decodeStep','decodeSpeed']:[];
   const scoped={...ctx,explanationRows:work.rows};
   proof+=work.rows.filter(row=>ids.includes(row.id)).map(row=>equation(scoped,row,'reverse-bound-'+kind+'-')).join('');
  }
  return `<details class="reverse-bound-proof" data-proof-kind="${kind}"><summary>${labels[kind]}并发边界如何得到</summary>${proof}</details>`;
 }
 function concurrencyFlow(ctx){
  const q=ctx.result.chosen,r=ctx.result,s=ctx.s,templates=X.equations(ctx),target=targetRows(ctx),take=ids=>ids.map(id=>templates.find(row=>row.id===id)).filter(Boolean);
  const equations=(rows,prefix='overview-')=>rows.map(row=>equation(ctx,row,prefix)).join('');
  const memory=equations([target[0]]);
  const stored=r.formulaContext.parallel?`模型本身是一份 ${number(ctx,'weight','全量权重',r.weight,'GB')}；当前每实例实际存 ${number(ctx,'storedWeight','装载按此数',q.w.storedWeight,'GB')}。专家分散保存，共享部分在 ${q.attentionDP} 个请求组各存一份，所以这两个数不同。`:'先存一份模型权重，再给每路请求留缓存空间。';
  const proofSummary=(kind)=>{const p=q.proof[kind],ttft=kind==='ttft',unit=ttft?'s':'Token/s',key=ttft?'reverseTTFTCapacity':'reverseDecodeCapacity',label=ttft?'首 Token':'单路速度';if(p.inactive)return '<p>本次仅输出首 Token，此项不限制并发。</p>';return `<div class="capacity-answer">${number(ctx,key,'每实例上限',p.cap,'路')}</div><table class="capacity-check"><thead><tr><th>并发</th><th>${label}</th><th>检查</th></tr></thead><tbody>${p.cap>0?`<tr><td>${p.cap} 路</td><td>${p.at.toLocaleString('zh-CN',{maximumFractionDigits:3})} ${unit}</td><td>通过</td></tr>`:''}${p.next!==null?`<tr><td>${p.cap+1} 路</td><td>${p.next.toLocaleString('zh-CN',{maximumFractionDigits:3})} ${unit}</td><td>不通过</td></tr>`:''}</tbody></table>`;};
  return `<div class="reverse-limits-grid"><section class="reverse-capacity-block" data-capacity="memory"><h4>① 显存能容纳多少路</h4><p class="limit-rule">可用显存扣掉实例权重，再除每路缓存。</p><div class="capacity-answer">${number(ctx,'reverseMemoryCapacity','每实例上限',q.kvCap,'路')}</div>${memory}<details class="reverse-bound-proof"><summary>权重与缓存怎么算</summary><p class="reverse-step-note">每实例可用 ${number(ctx,'usable','可用显存',q.w.usable,'GB')}。${stored}</p>${equations(take(['weight',...(r.formulaContext.parallel?['storedWeight']:[]),'context','kvSession','expertParamsB','expertWeight','denseWeight','attentionDP','cacheBatch','kvSessionBase','kv','compressedState','compressedWindowSlope']),'reverse-memory-source-')}</details>${capProof(ctx,'kv')}</section><section class="reverse-capacity-block" data-capacity="ttft"><h4>② 首 Token 能否按时出来</h4><p class="limit-rule">逐步增加并发，首 Token 不超过 ${s.ttft} 秒。</p>${proofSummary('ttft')}<details class="reverse-bound-proof"><summary>输入处理工作量怎么算</summary><p>模型参数运算和Attention运算分别除对应有效算力，得到计算时间；读取量除显存带宽得到搬运时间。取较慢的一项，加上附加时间，得到首 Token 延迟。</p>${equations(take(['prefillMatrix','prefillAttention','expertActiveB','denseActiveB','compressedGlobalOps','compressedWindowOps','compressedTopkOps','compressedStateOps']),'reverse-prefill-source-')}</details>${capProof(ctx,'ttft')}</section><section class="reverse-capacity-block" data-capacity="decode"><h4>③ 每路生成速度能否达标</h4><p class="limit-rule">逐步增加并发，每路不低于 ${s.speed} Token/s。</p>${proofSummary('decode')}<details class="reverse-bound-proof"><summary>生成工作量与读取量怎么算</summary><p>每批每步给每路生成一个Token。计算和搬运取较慢的一项，再加附加时间；单路速度＝1÷每步秒数。</p>${equations(take(['expertActiveB','denseActiveB','expertActiveWeight','denseActiveWeight','endContext','endKV','union','bandwidthRate','attentionBandwidthRate']),'reverse-decode-source-')}</details>${capProof(ctx,'decode')}</section></div><section class="reverse-capacity-block reverse-final" data-capacity="final"><h4>三项同时达标，取最小上限</h4><div class="reverse-final-equations">${equations(target.slice(1))}</div></section>`;
 }
 function lengthProof(ctx){
  const s=ctx.s,r=ctx.result,z=r.solve,q=r.chosen,input=z.target==='input',m=ctx.D.models[s.model],native=s.contextMode==='extended'?m.extendedContextTokens:m.nativeContextTokens,other=input?r.O:r.I,upper=Math.min(10000000,Math.floor(native)-other),x=z.answer;
  const rows=[{id:'reverseContextLimit',title:'先限定模型允许的长度',ast:sub(v('constant','模型上下文上限',native,'Token'),v(input?'output':'input',input?'固定输出':'固定输入',other,'Token')),result:v('reverseContextLimit','上下文剩余空间',native-other,'Token')}];
  const read=n=>ctx.E.calculate({...s,[z.meta.solved]:n/1000},ctx.D,{performanceOnly:true,forceTP:q.tp,forceAttentionTP:q.attentionTP,...(input?{}:{responseSlo:s.responseSlo})});
  const next=x<upper?read(x+1):null,nw=next?.chosen?.w;
  const failures=next?[!next.ok?'输入限制':'',nw&&!nw.fits?'显存不足':'',nw&&!nw.ttftOK?'首 Token 超时':'',nw&&!nw.speedOK?'单路速度低于下限':'',nw&&z.target==='output'&&nw.response>s.responseSlo?'完整答案超过限时':'',next.chosen&&!next.chosen.throughputOK?'总吞吐低于下限':''].filter(Boolean):['模型原生上下文或搜索上限'];
  return {rows,next,failures,html:`<p>把待求${input?'输入':'输出'}长度记为 <strong>x</strong>。硬件、模型、精度及其他已知条件全部固定；在合法布局中试算整数长度，保留通过全部约束的最大 x。</p><div class="reverse-length-check"><span>${number(ctx,'solveAnswer','最大通过长度',x,'Token')}：满足固定条件。</span><span>${next?number(ctx,'constant','再增加一个 Token',x+1,'Token')+'：'+esc(failures.join('、')||'边界约束未通过')+'。':esc(failures.join('、'))+'，不继续增加。'}</span></div><details class="reverse-bound-proof"><summary>查看长度边界的约束检查</summary>${lengthChecks(ctx,q.w,'边界')}${nw?lengthChecks(ctx,nw,'多一个 Token'):''}<p>单路速度检查采用末端速度；完整答案限时仅在求最大输出时参与。</p></details>`};
 }
 function lengthChecks(ctx,w,label){
  const s=ctx.s,z=ctx.result.solve,parts=[['显存',w.used,'≤',w.usable,'GB'],['首 Token',w.ttft,'≤',s.ttft,'s']];
  if(w.speed!==null)parts.push(['单路速度',w.speed,'≥',s.speed,'Token/s/路']);if(z.target==='output')parts.push(['完整答案时间',w.response,'≤',s.responseSlo,'s']);
  return `<p><strong>${label}</strong></p>`+parts.map(([title,value,compare,limit,unit])=>`<div class="reverse-check-line">${number(ctx,'constant',title+'检查值',value,unit)} ${compare} ${number(ctx,'constant',title+'固定上限/下限',limit,unit)}</div>`).join('');
 }
 function constraints(ctx){
  const s=ctx.s,r=ctx.result,w=r.chosen.w,t=r.solve.target,parts=[['显存',w.used,'≤',w.usable,'GB']];
  if(t!=='ttft')parts.push(['首 Token',w.ttft,'≤',s.ttft,'s']);if(t!=='speed'&&r.O>1)parts.push(['单路速度',w.speed,'≥',s.speed,'Token/s/路']);
  return `<details class="reverse-bound-proof"><summary>核对其他固定条件是否满足</summary>${parts.map(([label,value,compare,limit,unit])=>`<div class="reverse-check-line">${number(ctx,'constant',label+'约束检查',value,unit)} ${compare} ${number(ctx,'constant',label+'固定条件',limit,unit)}</div>`).join('')}</details>`;
 }
 function candidates(ctx){
  const r=ctx.result,z=r.solve,target=z?.target||ctx.s.reverseTarget;
  const metric=q=>target==='concurrency'?Math.min(100000,q.capacity):target==='speed'?q.w.speed:target==='ttft'?q.w.ttft:target==='throughput'?ctx.s.throughputMetric==='requests'?q.requestsPerSecond:ctx.s.throughputMetric==='decode-output'?q.decodeThroughput:q.outputThroughput:null;
  return `<details class="reverse-bound-proof"><summary>查看该目标的布局候选</summary><div class="table-wrap"><table><thead><tr><th>每实例卡数</th><th>实例数</th><th>Attention 分组</th><th>${target==='input'||target==='output'?'最终长度处的检查':esc(names[target])}</th></tr></thead><tbody>${(r.candidates||[]).map(q=>`<tr><td>${q.tp}</td><td>${q.groups}</td><td>${q.attentionDP}</td><td>${q.valid?metric(q)===null?'通过':ctx.E.fmt(metric(q)):'未满足固定条件'}${q.id===r.chosen?.id?' · 当前选中':''}</td></tr>`).join('')}</tbody></table></div><p>上下文目标的表格核对最终长度；每个布局的整数边界由求解器分别搜索。布局是本次求解的中间选择，不会增加已有设备。</p></details>`;
 }
 function render(ctx){
  ctx=normalized(ctx);const r=ctx.result,z=r.solve,t=z?.target||ctx.s.reverseTarget||'concurrency',title=names[t]||'所选目标',q=r.chosen;
  const section=(n,title,body)=>`<section class="reverse-chain-step"><header><span>${n}</span><h3>${title}</h3></header>${body}</section>`;
  const known=section('01','已有硬件与请求条件',fixed(ctx)+resources(ctx));
  if(!r.ok||!r.feasible||!q||!z||z.answer===null)return `<section class="reverse-calculation" data-core="reverse" data-reverse-goal="${esc(t)}">${known}<p class="core-empty">${esc((r.errors||[]).join('；')||'当前固定设备与条件没有满足所选目标的方案，不能输出能力边界。')}</p></section>`;
  const rateRows=X.equations(ctx).filter(row=>['usable','matrixRate','attentionMatrixRate','attentionRate','bandwidthRate','attentionBandwidthRate'].includes(row.id));
  const layout=section('02','为什么这样分卡',layoutChoice(ctx)+`<details class="reverse-bound-proof"><summary>每实例实际可用的显存、算力与带宽</summary>${rateRows.map(row=>equation(ctx,row,'reverse-resource-')).join('')}</details>`);
  const memoryRows=X.equations(ctx).filter(row=>['weight','storedWeight','context','kvSession','requestCacheTotal','allInstanceWeight','actualMemoryTotal','attentionBatch','groupWeight','groupUsed','groupUsable'].includes(row.id));
  const memoryAccount=`<details class="reverse-bound-proof reverse-memory-account"><summary>模型、全部请求缓存与逐组显存检查</summary><p>以下按求得结果或已固定的 ${ctx.s.concurrency} 路核对：权重与实际请求缓存相加；每个处理组还必须分别装得下。容量预留不增加实际请求。</p>${memoryRows.map(row=>equation(ctx,row,'reverse-account-')).join('')}</details>`;
  let body,answerAnchored=false;
  if(t==='concurrency')body=concurrencyFlow(ctx),answerAnchored=true;
  else if(t==='input'||t==='output'){const proof=lengthProof(ctx);body=proof.rows.map(row=>equation(ctx,row)).join('')+proof.html;}
  else body=targetRows(ctx).map(row=>equation(ctx,row)).join('')+constraints(ctx);
  const answer=answerAnchored?'':`<div class="reverse-goal-answer" id="overview-solveAnswer" tabindex="-1"><span>本次唯一求解结果 · ${esc(title)}</span>${number(ctx,'solveAnswer',z.meta.answer,z.answer,z.meta.unit)}</div>`;
  return `<section class="reverse-calculation" data-core="reverse" data-reverse-goal="${esc(t)}"><p class="reverse-direction">固定硬件与条件 → 比较分卡方式 → 解出${esc(title)}</p>${known}${layout}${memoryAccount}${section('03','求出'+esc(title),body+answer)}${z.search?.limitHit?'<p class="notice">已到模型原生上下文或搜索上限；显示的是当前范围边界。</p>':''}</section>`;
 }
 function technical(ctx){
  ctx=normalized(ctx);if(!ctx.result.solve)return '<p class="core-empty">暂无已执行的反向求解。</p>';
  return `<p class="reverse-step-note">下面只展开所选目标使用的固定参数与假设。每个数字可聚焦查看来源；完整运行记录仍保留在导出报告中。</p>${candidates(ctx)}<details class="reverse-bound-proof"><summary>硬件效率、缓存精度与运行假设</summary><div class="reverse-known">${['memoryGB','reserve','scratchGB','weightOverhead','kvBytes','mfu','attentionMfu','bwEff','parallelLoss','stepMs','transportMs'].map(key=>`<span>${number(ctx,key,ctx.labels?.[key]||key,ctx.s[key]*(ctx.fields?.[key]?.[6]||1),ctx.fields?.[key]?.[1]||'')}</span>`).join('')}</div></details>`;
 }
 Object.assign(X.meanings,{reverseHardwareCards:'已有服务器数量乘每台卡数，是本次固定硬件输入，不由需求反推增加。',reverseAllocatedCards:'在固定设备内选中的实例数乘每实例卡数，不能超过已有卡数。',reverseMemoryCapacity:'固定每实例显存、权重与每路缓存，解可容纳的并发；Attention DP按整组峰值预留取整。',reverseTTFTCapacity:'保持输入、输出和实例布局不变，增加并发，求首 Token 仍不超过已填上限的最大批量。',reverseDecodeCapacity:'保持输入、输出和布局不变，增加并发，求末端单路速度仍不低于已填下限的最大批量。',reverseContextLimit:'模型原生上下文上限减去另一侧已固定的输入或输出，限定待求长度的搜索范围。',groups:'当前模型布局的实例数量；反向在固定设备中布置，正向按需求计算所需数量。',solveAnswer:'本次所选的唯一未知量，在已有硬件与其他固定条件下求得。'});
 const api={render,technical,candidates,targetRows,layoutRows,hardwareRows,concurrencyFlow,atBatch,lengthProof,fixed,names};root.ReverseCalculation=api;if(node)module.exports=api;
 const forward=X.render;X.render=(ctx,options={})=>ctx.s.mode==='reverse'&&!options.sectionsOnly?render(ctx):forward(ctx,options);
})(typeof window==='undefined'?globalThis:window);
