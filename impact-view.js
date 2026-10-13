'use strict';
(function(root){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=v=>typeof v==='number'?(Number.isFinite(v)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(v):'未计算'):v===null?'无有限交点':String(v??'未计算');
 const same=(a,b)=>typeof a==='number'&&typeof b==='number'?Math.abs(a-b)<=Math.max(1,Math.abs(a),Math.abs(b))*1e-10:Object.is(a,b);
 const lanes=[
  ['memory','显存','权重与全部并发 KV，能否装下？',['weight','kv','kvSession','used','usable'],['weight','kv','kvSession','weightCardFloor','requestCardFloor','used','usable']],
  ['prefill','首 Token 时延','输入越长，参数运算与 Attention 如何变化？',['prefillMatrix','prefillAttention','prefillComputeTime','ttftResult'],['input','pairs','attentionCoef','prefillMatrix','prefillAttention','prefillComputeTime','prefillTraffic','prefillMemoryTime','prefillTime','ttftResult']],
  ['decode','Decode 速度','上下文增加后，算力或带宽谁更紧？',['decodeAttention','decodeComputeTime','decodeMemoryTime','decodeSpeed'],['decodeMatrix','decodeAttention','union','decodeComputeTime','decodeMemoryTime','decodeStep','decodeSpeed','decodeDuration','response']]
 ];
 function token(ctx,node,value){
  let shown=value,unit=node.unit;
  if(typeof value==='number'&&unit.startsWith('FLOP')&&Math.abs(value)>=1e12){shown=value/1e12;unit='T'+unit;}
  else if(typeof value==='number'&&unit.startsWith('FLOP')&&Math.abs(value)>=1e9){shown=value/1e9;unit='G'+unit;}
  else if(typeof value==='number'&&unit.startsWith('bytes')&&Math.abs(value)>=1e9){shown=value/1e9;unit=unit.replace('bytes','GB');}
  return root.CalculationExplain.token(ctx,node.id,typeof shown==='number'?shown:fmt(shown),node.title.replaceAll('副本','实例'),unit,node.note||'由当前计算引擎推导。');
 }
 function ctxAt(ctx,s,result){return {...ctx,s,result};}
 function compare(ctx,base,current,options={}){
  const a=base.result,b=current.result,A=new Map((a.trace||[]).map(n=>[n.id,n])),B=new Map((b.trace||[]).map(n=>[n.id,n]));
  const ca=ctxAt(ctx,base.state,a),cb=ctxAt(ctx,current.state,b);
  const changes=Object.keys(current.state).filter(k=>!same(base.state[k],current.state[k]));
  const value=(s,k)=>{if(k==='model')return ctx.D.models[s[k]]?.name;if(k==='card')return ctx.D.cards[s[k]]?.name;if(k==='precision')return ctx.E.precision[s[k]]?.name;if(k==='api')return ctx.D.apiPrices[s[k]]?.name;return typeof s[k]==='boolean'?(s[k]?'是':'否'):ctx.fields[k]?fmt(s[k]*(ctx.fields[k][6]||1))+' '+ctx.fields[k][1]:fmt(s[k]);};
  const row=id=>{const x=A.get(id),y=B.get(id),n=y||x;if(!n)return '';return `<div class="impact-row ${!same(x?.value,y?.value)?'changed':''}"><span>${esc(n.title.replaceAll('副本','实例'))}</span><div>${x?token(ca,x,x.value):'未计算'}<span class="impact-arrow" aria-label="变为">→</span>${y?token(cb,y,y.value):'未计算'}</div></div>`;};
  const detail=id=>{const n=B.get(id)||A.get(id);if(!n)return '';const nc=B.has(id)?cb:ca;return `<article class="impact-formula"><h4>${esc(n.title.replaceAll('副本','实例'))}</h4>${row(id)}<p class="formula">${esc(n.formula)}</p>${root.CalculationExplain.dependencies(nc,n)}<p class="muted">${esc(n.note)}</p></article>`;};
  const minimum=(result,kind)=>{const key={memory:'fits',prefill:'ttftOK',decode:'speedOK'}[kind];const qs=(result.candidates||[]).filter(q=>q.w?.[key]);return qs.length?Math.min(...qs.map(q=>q.tp)):null;};
  const constraintChanged=(kind,ids)=>ids.some(id=>!same(A.get(id)?.value,B.get(id)?.value))||minimum(a,kind)!==minimum(b,kind);
  let html=`<div class="impact-heading"><div><h2>调整前后，影响在哪里</h2><p class="muted">${base.confirmed?'上次确认方案':'初始对照（尚未确认）'} → ${options.name||'当前试算'} · 所有数字来自同一个计算引擎</p></div><span class="status-chip">${changes.length} 项参数变化</span></div>`;
  html+=changes.length?`<details class="impact-changes" open><summary>改动的参数（含更换目录项带来的默认值变化）</summary><div>${changes.map(k=>`<p><span>${esc(ctx.labels[k]||k)}</span><span>${esc(value(base.state,k))} → <b>${esc(value(current.state,k))}</b></span></p>`).join('')}</div></details>`:'<p class="notice">还没有参数差异。调整输入、输出或体验目标，观察计算与费用变化。</p>';
  if(!a.ok||!b.ok)html+=`<div class="notice error">${!a.ok?'基准参数无效；':''}${!b.ok?'当前参数无效：'+esc((b.errors||[]).join('；')):''} 未计算项不按 0 处理。</div>`;
  html+=`<div class="impact-hardware"><span>自动重选配置：<b>${a.chosen?.activeCards??'未找到'} → ${b.chosen?.activeCards??'未找到'} 张参与计算</b>，${a.chosen?.servers??'—'} → ${b.chosen?.servers??'—'} 台</span><p>下方时延与速度采用两边各自的配置，不是固定硬件测试；变快可能来自卡数增加。前置负载公式与候选卡数下限分别列出。</p></div>`;
  html+=`<div class="impact-lanes">${lanes.map(([id,title,question,primary,full])=>`<section class="impact-lane ${constraintChanged(id,full)?'affected':''}" data-impact-lane="${id}"><header><h3>${title}</h3><span>${constraintChanged(id,full)?'有变化':'未变化'}</span></header><p class="muted">${question}</p>${primary.map(row).join('')}<p class="impact-floor">本项约束的候选卡数下限 <strong>${minimum(a,id)??'未找到'} → ${minimum(b,id)??'未找到'}</strong></p><details><summary>展开本路径公式与变量</summary>${full.map(detail).join('')}</details></section>`).join('')}</div>`;
  html+=`<section class="impact-merge"><h3>三项约束联合校验，再按整机配置取整</h3><p class="muted">各路径卡数不相加。最终配置必须同时通过显存、首 Token 和 Decode 检查；还受每台卡位、跨机范围及并行效率影响。</p><div class="impact-outcomes">${['activeCards','serverCount','purchasedCards'].map(row).join('')}</div><p>${b.feasible?(same(a.chosen?.activeCards,b.chosen?.activeCards)?'参与卡数未变：变化仍落在同一候选配置内，或由其他约束/整机粒度限制。':'候选配置发生变化，详见下方完整推导。'):'当前搜索范围未找到满足全部约束的配置，不等于模型完全不能运行。'}</p></section>`;
  html+=`<details class="impact-money" open><summary>最后看成本变化</summary><div class="impact-outcomes">${['capex','localMonthly','apiMonthly','payback','localTCO','apiTCO'].map(row).join('')}</div><p class="muted">${current.state.costMode==='manual'?'手动每日账单不会随 Token 参数自动改变。':'12 小时 API 用量按目标体验估算；需求变化时工作量也可能变化，不可直接视为同服务水平省钱。'} 卡数、报价和运行费用均为规划值，不是压测或采购承诺。</p><button data-page="workbench">回推演页查看云端 / 本地成本交点</button></details>`;
  const full=new Set([...A.keys(),...B.keys()]);html+=`<details class="impact-all"><summary>完整计算链 · ${full.size} 个步骤（含未变化项）</summary>${[...full].map(detail).join('')}</details>`;
  return html;
 }
 root.ImpactView={compare,same};
})(typeof window==='undefined'?globalThis:window);
