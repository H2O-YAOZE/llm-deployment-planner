'use strict';
(() => {
 const P=window.PanelV4,C=window.AdvisorCore,D=window.AppData,E=window.PlanningEngine;
 const $=s=>document.querySelector(s),clone=v=>structuredClone(v);
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const num=n=>Number.isFinite(n)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n):'待核实';
 const money=n=>Number.isFinite(n)?'¥'+num(n):'报价待核实';
 const labels={concurrency:'并发',inputK:'输入长度',outputK:'输出长度',ttft:'开始回答的等待时间',speed:'每路生成速度',responseSlo:'完整回答时间',model:'模型',card:'芯片',precision:'精度',mode:'部署方向',servers:'设备数量',slots:'每台卡数',budgetWan:'采购预算'};
 const displayValue=(key,value)=>key==='model'?D.models[value]?.name||'待确认':key==='card'?D.cards[value]?.name||'待确认':key==='precision'?E.precision[value]?.name||'待确认':key==='mode'?({forward:'按需求采购',reverse:'评估已有硬件'})[value]||'待确认':typeof value==='number'?num(value):String(value);
 let requirements={},suggestions={},flexibleFields=[],flow=null,locks=new Set(),messages=[],entries=[],questions=[],unresolved=[],recommendations=[],plans=[],revision=0,confirmed=false,controller=null,lastReview=null;
 const base=()=>({...E.defaults(D),contextMode:'native',throughput:0});
 function wording(text){return String(text||'').replace(/local\s*=\s*false/g,'本地部署数据未核实').replace(/catalog\.paths|requirements|inputK|outputK|responseSlo/g,k=>labels[k]||'目录数据');}
 function shortQuestion(text){
  if(/人数|同时发起请求|同一时刻.*请求数/.test(text))return '大家会同时提问吗，还是错开使用？高峰时大约同时几路？';
  if(/你说的.*快/.test(text))return '你说的“快”，是开始回答快、文字生成快，还是整段完成快？';
  if(/首.*Token.*(?:秒|等)/i.test(text))return '发出问题后，最多能接受等几秒开始看到回答？';
  if(/每路.*输出|每次.*输出/.test(text))return '每次回答大约多长？可以说字数或最大输出 Token 数。';
  if(/每路.*输入/.test(text))return '每次实际要读取多少内容？包含提示词和历史对话。';
  return wording(text);
 }
 const proposedRequirements=()=>({...suggestions,...requirements});
 function pending(){const r=proposedRequirements(),selection={model:'想部署哪个模型？',card:'使用哪款芯片，或是否必须国产？',precision:'请确认精度格式，例如 INT8 或 FP8；也可以说“你推荐”。'};return [...new Set([...Object.keys(selection).filter(k=>!r[k]).map(k=>selection[k]),C.selectionIssue(r,D,E),...C.blockers(r),...unresolved].filter(Boolean))];}
 function ready(){return ['model','card','precision'].every(k=>proposedRequirements()[k])&&(flow?flow.ready:true)&&!pending().length;}
 function summary(r){
  const lines=[];
  const selection=[D.models[r.model]?.name,E.precision[r.precision]?.name].filter(Boolean).join(' · ');
  if(selection)lines.push(selection);
  if(r.card)lines.push((r.mode==='reverse'?'已有 ':'使用 ')+(D.cards[r.card]?.name||r.card)+(r.servers?'，'+r.servers+'台':'')+(r.slots?'，每台'+r.slots+'张卡':''));
  if(r.mode==='reverse')lines.push('计算'+({concurrency:'最大同时并发',speed:'最高每路生成速度',ttft:'最短开始等待时间',input:'最大输入',output:'最大输出'})[r.reverseTarget]);
  else if(r.concurrency)lines.push(r.concurrency+'路同时请求');
  if(Number.isFinite(r.inputK)||Number.isFinite(r.outputK))lines.push([Number.isFinite(r.inputK)?'输入 '+num(r.inputK)+'K Token':'',Number.isFinite(r.outputK)?'输出 '+num(r.outputK)+'K Token':''].filter(Boolean).join('，'));
  if(Number.isFinite(r.ttft)||Number.isFinite(r.speed))lines.push([Number.isFinite(r.ttft)?'开始等待 ≤ '+num(r.ttft)+'秒':'',Number.isFinite(r.speed)?'每路生成 ≥ '+num(r.speed)+' Token/s':''].filter(Boolean).join('，'));
  if(Number.isFinite(r.responseSlo))lines.push('整段回答 ≤ '+num(r.responseSlo)+'秒');
  if(r.budgetWan)lines.push('采购预算 ≤ '+num(r.budgetWan)+'万元');
  const path=C.precisionPath(r,D,E);if(path?.note)lines.push(path.note);
  return lines.join('\n');
 }
 function planChangeText(plan,source=requirements){
  const value=(key,v)=>key==='model'?D.models[v]?.name||v:key==='card'?D.cards[v]?.name||v:key==='precision'?E.precision[v]?.name||v:num(v);
  return [...(plan.selectionChanges||[]),...Object.entries(plan.adjustments||{}).filter(([key,to])=>to!==source[key]).map(([key,to])=>({key,before:source[key],after:to}))].map(x=>(labels[x.key]||x.key)+'：'+value(x.key,x.before)+' → '+value(x.key,x.after)).join('；');
 }
 function resultHtml(entry,index){
  const p=entry.plans[entry.selected],r=p?.result,q=r?.chosen,current=entry.revision===revision&&!controller;
  if(!p)return '';
  const failed=wording([...p.conflicts,...(r?.errors||[])][0]||'这些条件下未找到可行配置。');
  const total=q?.purchasedCards??q?.activeCards;
  const equipment=q?`${q.servers}台 · ${total}张卡${total!==q.activeCards?'（'+q.activeCards+'张参与运行）':''}；${q.groups}个模型实例，每实例最多${q.B}路并发`:'';
  const answer=r?.solve?.answer;
  const answerLine=Number.isFinite(answer)?({concurrency:'最大同时并发约 '+num(answer)+'路',speed:'每路生成速度约 '+num(answer)+' Token/s',ttft:'开始回答约需 '+num(answer)+'秒',input:'最大输入约 '+num(answer)+' Token',output:'最大输出约 '+num(answer)+' Token'})[r.solve.target]:'';
  const change=planChangeText(p,entry.requirements);
  return `<p>${p.allowed?'这组需求可以做规划试算。':esc(failed)}</p>${entry.plans.length>1?`<div class="chat-plan-choices">${entry.plans.map((plan,i)=>`<button type="button" data-chat-plan="${index}:${i}" ${current?'':'disabled'} aria-pressed="${i===entry.selected}">方案 ${i+1}</button>`).join('')}</div>`:''}<p class="chat-plan-name">${esc(D.models[p.model]?.name)} · ${esc(D.cards[p.card]?.name)} · ${esc(E.precision[p.precision]?.name)}</p>${p.planningNotice?`<p class="chat-small">${esc(p.planningNotice)}</p>`:""}${change?`<p class="chat-change">${esc(change)}${p.allowed?'，采用前请确认。':''}</p>`:''}${equipment?`<p>${esc(equipment)}${answerLine?'；'+esc(answerLine):''}</p>`:''}${r?.cost?`<dl class="chat-costs"><div><dt>硬件采购</dt><dd>${esc(money(r.cost.capex))}</dd></div><div><dt>API / 月</dt><dd>${esc(money(r.cost.apiMonthly))}</dd></div><div><dt>本地 / 月（含摊销）</dt><dd>${esc(money(r.cost.localMonthly))}</dd></div></dl><p class="chat-small">API 按每天12小时持续满并发预算${r.cost.comparable?'':'，暂不作同模型回本结论'}。${r.cost.comparable?'规划结果仍需部署压测。':''}</p>`:''}${p.allowed?`<button type="button" class="primary" data-chat-apply="${index}" ${current?'':'disabled'}>${entry.applied?'已采用':'采用此方案'}</button><span class="chat-small">${entry.applied?'':current?'规划估算，部署前需压测。':'需求已变，请重新计算。'}</span>`:''}`;
 }
 function render(){
  const log=$('#advisor-messages');
  log.innerHTML=entries.length?entries.map((entry,i)=>{
   const current=entry.revision===revision&&!controller;
   const content=entry.kind==='confirmation'?`<p>我理解的需求是：</p><p>${esc(entry.summary)}</p><button type="button" class="primary" data-chat-calculate="${i}" ${current&&!entry.calculated?'':'disabled'}>${entry.calculated?'已计算':'确认并计算'}</button>`:entry.kind==='calculation'?resultHtml(entry,i):entry.kind==='condition'?`<p>${esc(entry.text)}</p><button type="button" data-chat-withdraw="${i}" ${current?'':'disabled'}>撤回此要求</button>`:entry.kind==='change'?`<p>${esc(entry.text)}</p><button type="button" data-chat-change="${i}" ${current?'':'disabled'}>确认修改</button>`:`<p>${esc(entry.text)}</p>`;
   return `<article class="chat-message ${entry.role==='user'?'user':'assistant'}"><small>${entry.role==='user'?'你':'助手'}</small>${content}</article>`;
  }).join(''):'<div class="chat-empty"><h2>说说你的需求</h2><p>模型、精度、芯片、并发、生成速度、输入和输出长度，都可以直接说。</p></div>';
  log.querySelectorAll('[data-chat-calculate]').forEach(b=>b.onclick=()=>calculate(Number(b.dataset.chatCalculate)));
  log.querySelectorAll('[data-chat-plan]').forEach(b=>b.onclick=()=>{const [i,n]=b.dataset.chatPlan.split(':').map(Number),entry=entries[i];if(entry.revision!==revision||controller)return;entry.selected=n;render();});
  log.querySelectorAll('[data-chat-apply]').forEach(b=>b.onclick=()=>apply(Number(b.dataset.chatApply)));
  log.querySelectorAll('[data-chat-withdraw]').forEach(b=>b.onclick=()=>withdraw(Number(b.dataset.chatWithdraw)));
  log.querySelectorAll('[data-chat-change]').forEach(b=>b.onclick=()=>acceptChange(Number(b.dataset.chatChange)));
  log.scrollTop=log.scrollHeight;
 }
 function addText(role,text){entries.push({kind:'text',role,text});}
 function invalidate(){revision++;plans=[];confirmed=false;window.dispatchEvent(new Event('advisor-requirements-change'));}
 function nextStep(){
  const unsupported=C.unsupportedRequirements(requirements);
  if(unsupported.length){const item=unsupported[0];entries.push({kind:'condition',role:'assistant',revision,text:wording(item.message),keys:item.keys});return;}
  if(ready()){
   const note=Object.keys(suggestions).length?'\n建议试算项：'+Object.keys(suggestions).map(k=>labels[k]||k).join('、')+'。确认后才按这些建议计算。':'';
   entries.push({kind:'confirmation',role:'assistant',revision,summary:summary(proposedRequirements())+note});
  }
 }
 function calculate(index){
  if(controller||index!==undefined&&(entries[index]?.revision!==revision||entries[index]?.calculated))return;
  if(!ready()){addText('assistant',shortQuestion(pending()[0]||'请先说明你的需求。'));render();return;}
  // Only this explicit confirmation accepts proposed assumptions.
  const accepted=proposedRequirements();
  const output=C.evaluateProposals(base(),accepted,locks,recommendations,D,E);
  if(output.issues.length){addText('assistant',shortQuestion(output.issues[0]));render();return;}
  requirements=accepted;suggestions={};flexibleFields=[];confirmed=true;plans=output.plans;
  if(index!==undefined)entries[index].calculated=true;
  entries.push({kind:'calculation',role:'assistant',revision,requirements:clone(requirements),plans:clone(plans),selected:Math.max(0,plans.findIndex(p=>p.allowed))});render();
 }
 function apply(index){
  const entry=entries[index],p=entry?.plans?.[entry.selected];
  if(controller||entry?.revision!==revision||entry.applied||!confirmed||!p?.allowed)return;
  const check=C.evaluateProposals(base(),requirements,locks,[p],D,E).plans.find(item=>item.model===p.model&&item.card===p.card&&item.precision===p.precision&&JSON.stringify(item.adjustments)===JSON.stringify(p.adjustments));
  if(!check?.allowed||JSON.stringify(check.state)!==JSON.stringify(p.state)){addText('assistant','需求或目录已变化，请重新计算。');render();return;}
  try{P.commit(check.state);entry.applied=true;invalidate();addText('assistant','已采用。你可以到“推演”查看计算过程。');render();}catch(error){addText('assistant',wording(error.message));render();}
 }
 function withdraw(index){
  const entry=entries[index];if(controller||entry?.revision!==revision)return;
  entry.keys.forEach(k=>{delete requirements[k];locks.delete(k);});
  const text='撤回这项要求：'+entry.text;messages.push({role:'user',content:text});addText('user',text);
  recommendations=[];invalidate();addText('assistant',shortQuestion(pending()[0]||'已撤回，请继续描述需求。'));nextStep();render();
 }
 function acceptChange(index){
  const entry=entries[index];if(controller||entry?.revision!==revision)return;
  const update={};for(const change of entry.changes){if(requirements[change.field]!==change.from)return;const valid=C.requirements({[change.field]:change.to},D,E);if(!Object.hasOwn(valid,change.field))return;update[change.field]=valid[change.field];}
  requirements={...requirements,...update};unresolved=unresolved.filter(q=>!entry.changes.some(change=>q.includes('锁定条件 '+change.field+' ')));
  if(flow)flow.ready=!unresolved.length&&!pending().length;
  const text='确认修改：'+entry.text;messages.push({role:'user',content:text});addText('user',text);invalidate();
  addText('assistant',ready()?'已修改，请核对后计算。':shortQuestion(pending()[0]));nextStep();render();
 }
 function setBusy(value){$('#scenario').disabled=value;$('#advisor-form button[type="submit"]').disabled=value;$('#advisor-new').disabled=value;$('#advisor-cancel').hidden=!value;render();}
 function resizeInput(){const input=$('#scenario');input.style.height='auto';input.style.height=Math.min(136,Math.max(46,input.scrollHeight))+'px';}
 function responseText(answer){
  const model=D.models[requirements.model];
  if(model?.catalogOnly)return model.name+' 暂无可核验的本地部署数据，不能估算配卡。要换一个已有部署数据的模型试算吗？';
  // One field-selected question replaces model prose, rather than appending it.
  if(flow?.question)return wording(flow.question);
  if(answer.questions[0])return shortQuestion(answer.questions[0]);
  if(!ready())return shortQuestion(pending()[0]||'还有哪些需求需要补充？');
  return '需求已整理，请核对后计算。';
 }
 async function send(event){
  event?.preventDefault();if(controller)return;
  const input=$('#scenario'),text=input.value.trim();if(!text)return;
  if(/\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)){$('#advisor-status').textContent='请移除密钥后再发送。';return;}
  if(messages.length>=24){$('#advisor-status').textContent='对话已较长，请新建对话继续。';return;}
  if(ready()&&/^(?:确认(?:需求)?(?:并(?:计算|试算))?|开始(?:计算|试算)|就按这些算)[。！!]*$/.test(text)){
   input.value='';resizeInput();addText('user',text);calculate();return;
  }
  const sent={scenario_text:text,messages:clone(messages),requirements:C.requirements(requirements,D,E),flexible_fields:clone(flexibleFields),suggested_requirements:C.requirements(suggestions,D,E),hard_constraints:[...locks],catalog:C.catalog(D,E)};
  const pendingUser={kind:'text',role:'user',text};entries.push(pendingUser);controller=new AbortController();const signal=controller.signal;
  input.value='';resizeInput();
  const timer=setTimeout(()=>controller?.abort(),65000);setBusy(true);$('#advisor-status').textContent='正在理解你的需求…';
  try{
   const intakeController=new AbortController(),abort=()=>intakeController.abort();signal.addEventListener('abort',abort,{once:true});
   const intakeTimer=setTimeout(()=>intakeController.abort(),6500);let interpretation=null;
   try{
    const response=await fetch('/api/advisor/interpret',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario_text:text,messages:sent.messages,requirements:sent.requirements,hard_constraints:sent.hard_constraints}),signal:intakeController.signal});
    const raw=await response.json();if(response.status===400)throw Object.assign(Error('输入内容无法处理，请调整后再试。'),{invalidInput:true});
    if(response.ok)interpretation=raw.interpretation;
   }catch(error){if(signal.aborted||error.invalidInput)throw error;}
   finally{clearTimeout(intakeTimer);signal.removeEventListener('abort',abort);}
   if(signal.aborted)throw new DOMException('Aborted','AbortError');
   window.dispatchEvent(new CustomEvent('advisor-jev-intake',{detail:interpretation||{status:'unavailable'}}));
   // Jev classifies ambiguity; every turn then reaches full extraction. Only
   // the shared field schema decides what still needs a question.
   if(interpretation?.status==='completed')sent.interpretation=interpretation;
   $('#advisor-status').textContent='正在回复…';
   const response=await fetch('/api/advisor/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(sent),signal});
   const raw=await response.json().catch(()=>({}));if(!response.ok)throw Error(raw.error||(response.status===503?'问答服务暂未连接，请稍后再试。':'这次回复没有完成，请再试一次。'));
   const answer=C.normalize(raw,D,E);
   requirements={...requirements,...answer.requirements};questions=answer.questions;unresolved=answer.unresolved;recommendations=answer.recommendations;lastReview=raw.review||null;
   suggestions=C.requirements(raw.suggested_requirements||{},D,E);flexibleFields=raw.flexible_fields||[];flow=raw.flow||null;
   for(const key of raw.hard_constraints||[])if(C.requirementKeys.includes(key))locks.add(key);
   invalidate();
   const content=responseText(answer);
   messages.push({role:'user',content:text},{role:'assistant',content});addText('assistant',content);
   const changes=(raw.pending_changes||[]).filter(change=>C.requirementKeys.includes(change.field)&&Object.hasOwn(C.requirements({[change.field]:change.to},D,E),change.field));
   if(changes.length)entries.push({kind:'change',role:'assistant',revision,changes,text:changes.map(x=>(labels[x.field]||x.field)+'：'+displayValue(x.field,x.from)+' → '+displayValue(x.field,x.to)).join('；')});
   else nextStep();
   input.value='';resizeInput();$('#advisor-status').textContent='';
  }catch(error){
   entries=entries.filter(entry=>entry!==pendingUser);
   input.value=text;resizeInput();
   $('#advisor-status').textContent=error.name==='AbortError'?'已停止，输入已保留。':error.message;
  }finally{clearTimeout(timer);controller=null;setBusy(false);input.focus({preventScroll:true});}
 }
 $('#advisor-form').onsubmit=send;$('#advisor-cancel').onclick=()=>controller?.abort();
 $('#scenario').oninput=()=>{resizeInput();$('#advisor-status').textContent='';};
 $('#scenario').onkeydown=event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&event.keyCode!==229){event.preventDefault();$('#advisor-form').requestSubmit();}};
 $('#advisor-new').onclick=()=>{if(controller)return;if(entries.length&&!confirm('开始新对话？'))return;requirements={};suggestions={};flexibleFields=[];flow=null;locks.clear();messages=[];entries=[];questions=[];unresolved=[];recommendations=[];lastReview=null;invalidate();$('#scenario').value='';$('#advisor-status').textContent='';resizeInput();render();$('#scenario').focus({preventScroll:true});};
 Object.assign(window.PanelHarness,{getRequirements:()=>clone(requirements),getPlans:()=>clone(plans),getScenario:()=>({requirements:C.requirements(requirements,D,E),messages:clone(messages),hard_constraints:[...locks]}),getReview:()=>clone(lastReview)});
 function fit(){if($('#advisor').hidden)return;const shell=$('.chat-shell'),height=window.visualViewport?.height||innerHeight;shell.style.height=Math.max(160,height-shell.getBoundingClientRect().top-20)+'px';}
 window.addEventListener('resize',fit);window.visualViewport?.addEventListener('resize',fit);window.addEventListener('hashchange',()=>requestAnimationFrame(fit));
 new ResizeObserver(fit).observe($('.topbar'));document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>requestAnimationFrame(fit)));
 render();resizeInput();requestAnimationFrame(fit);
})();
