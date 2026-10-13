 'use strict';
(function(root){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=n=>Number.isFinite(n)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:Math.abs(n)<.1?4:2}).format(n):'—';
 const names={used:'每套容量检查',context:'保存的上下文',kvSession:'每路缓存',storedWeight:'每套模型权重',weight:'模型权重',ttftResult:'首 Token 等待',prefillMatrix:'输入计算量',prefillComputeTime:'读取输入的计算',prefillTime:'处理输入',decodeStep:'生成一个 Token',decodeSpeed:'每路生成速度',chosenTP:'每套分卡',caps:'每套能接多少路',groups:'需要几套模型',serverCount:'所需服务器',purchasedCards:'需要多少卡',input:'每路输入',output:'每路输出',totalOutputThroughput:'总输出吞吐'};
 const meaningful=new Set(Object.keys(names));let active=null,dispose=()=>{};
 function render(ctx,base,current,key){
  const cmp=ctx.comparison,r=current.result,s=current.state,cc={...ctx,s,result:r},before=new Map(base.result.trace.map(n=>[n.id,n])),after=new Map(r.trace.map(n=>[n.id,n]));
  const label=id=>names[id]||root.InfluencePaths.label(id)||ctx.labels[id]||after.get(id)?.title||id;
  const raw=(map,id)=>map.get(id)?.value;
  const changed=id=>raw(before,id)!==raw(after,id);
  const show=(map,id)=>{const n=map.get(id);return n?`${typeof n.value==='number'?fmt(n.value):esc(n.value??'—')} ${esc(n.unit||'')}`:'—';};
  const metric=(id,title,unit)=>{const scale=id==='budget'?10000:1,a=cmp.before[id]===null?null:cmp.before[id]/scale,b=cmp.after[id]===null?null:cmp.after[id]/scale,delta=Number.isFinite(a)&&Number.isFinite(b)?b-a:null;return `<div class="impact-metric" data-impact-metric="${id}"><span>${title}</span><strong>${fmt(b)} <small>${unit}</small></strong><p>${delta!==null&&Math.abs(delta)<1e-9?'不变':`原来 ${fmt(a)}${delta===null?'':` · ${delta>0?'+':''}${fmt(delta)}`}`}${id==='cards'&&cmp.after.servers!==null?` · ${cmp.after.servers} 台`:''}</p></div>`;};
  const summary=`<div class="impact-metrics">${metric('budget','预计采购费用','万元')}${metric('cards','设备','张')}${metric('ttft','首 Token','秒')}${metric('speed','每路生成','Token/s')}</div><p class="impact-verdict${r.feasible?'':' needs-attention'}">${esc(cmp.reason)}</p>${cmp.layoutChanged?`<p class="impact-layout-change">分组变化：${base.result.chosen.groups} 套 × ${base.result.chosen.tp} 张 → ${r.chosen.groups} 套 × ${r.chosen.tp} 张。下方比较已包含重新分组的影响。</p>`:''}${cmp.automaticChanges.length?`<p class="impact-layout-change">目录联动调整了${cmp.automaticChanges.map(k=>({precision:'精度',model:'模型',card:'芯片'})[k]).join('、')}，请在参考条件中核对。</p>`:''}`;
  const budgetProof=cmp.after.budget!==null?`<details class="impact-budget-proof"><summary>费用怎么算</summary><p>${fmt(cmp.after.cards)} 张 × ${fmt(s.cardWan)} 万元/张 + ${fmt(cmp.after.servers)} 台 × ${fmt(s.platformWan)} 万元/台 = ${fmt(cmp.after.budget/10000)} 万元。服务器费用不含卡，按每台 ${s.slots} 卡整机采购。</p><p>目录规划报价，非最新询价；不含交换机及布线。卡数未跨过整机边界时，费用不变。</p></details>`:'';
  active=null;if(!r.ok||!r.chosen)return summary+budgetProof;
  const projected=root.InfluencePaths.project(cc,r,key),eqs=new Map(root.CalculationExplain.equations(cc).map(n=>[n.id,n]));
  function proof(row,id){const n=after.get(id),eq=eqs.get(id);return `<h4>${esc(label(id))}</h4><p>原来 ${show(before,id)} → 修改后 ${show(after,id)}</p>${eq?root.CalculationExplain.renderEquation(cc,eq):`<p>${esc(n?.formula||'目录参数随选型更新。')}</p>`}${n?root.CalculationExplain.dependencies(cc,n):''}<details><summary>完整依赖路径</summary><p>${row.path.map(id=>esc(label(id))).join(' → ')}</p></details>`;}
  const selected=['used',...(r.chosen.w.fits?['ttftResult','decodeSpeed']:[]),...(cmp.mode==='auto'?['purchasedCards']:[])].map(id=>projected.find(p=>p.n.id===id)).filter(Boolean);
  const lanes=selected.map(row=>{
   const path=row.path.slice(1).filter(id=>meaningful.has(id)).filter(id=>!(key==='inputK'&&id==='input'||key==='outputK'&&id==='output')).filter(id=>row.n.id!=='ttftResult'||!['prefillComputeTime','prefillTime'].includes(id)).filter(id=>row.n.id!=='decodeSpeed'||id!=='decodeStep');
   let steps=path.length<=3?path:[path[0],path.at(-2),path.at(-1)];steps=[...new Set(steps)];if(!steps.includes(row.n.id))steps.push(row.n.id);
   const laneTitle={used:'显存',ttftResult:'等待',decodeSpeed:'生成',purchasedCards:'选配设备'}[row.n.id];
   return `<section class="lab-lane" data-chain-lane="${row.n.id}"><h3>${laneTitle}</h3><div class="impact-route" data-chain-route="${row.n.id}"><div class="impact-track" data-steps="${steps.length}">${steps.map((id,i)=>`<button type="button" class="impact-node ${changed(id)?'is-changed':''}" data-causal-node="${esc(id)}" aria-expanded="false"><span>${esc(label(id))}</span><strong>${id==='prefillMatrix'?(changed(id)?raw(after,id)>raw(before,id)?'计算量增加':'计算量减少':'计算量不变'):show(after,id)}</strong><small>${id==='prefillMatrix'?'点击查看依据':changed(id)?'原来 '+show(before,id):'不变'}</small></button>${i<steps.length-1?'<span class="impact-arrow" aria-hidden="true">→</span>':''}`).join('')}</div><div class="impact-proof" hidden></div></div></section>`;
  }).join('');
  active={selected,proof};
  return summary+budgetProof+`<div class="impact-chain"><h2>${esc(ctx.labels[key]||key)}的影响 <small>点击环节看计算</small></h2>${lanes||'<p>当前变量没有进入这些计算分支。</p>'}</div><p class="impact-footnote">性能为规划估算 · 点击环节查看公式。费用使用目录规划报价，非最新询价。</p>`;
 }
 function mount(panel){dispose();if(!active)return;const view=active;const click=e=>{const b=e.target.closest('[data-causal-node]');if(!b)return;const route=b.closest('.impact-route'),box=route.querySelector('.impact-proof'),was=b.getAttribute('aria-expanded')==='true';panel.querySelectorAll('.impact-proof').forEach(x=>{x.hidden=true;});panel.querySelectorAll('[data-causal-node]').forEach(x=>x.setAttribute('aria-expanded','false'));if(!was){box.innerHTML=view.proof(view.selected.find(x=>x.n.id===route.dataset.chainRoute),b.dataset.causalNode);box.hidden=false;b.setAttribute('aria-expanded','true');}};panel.addEventListener('click',click);dispose=()=>panel.removeEventListener('click',click);}
 root.CausalChain={...root.CausalChain,render,mount};
})(typeof window==='undefined'?globalThis:window);
