'use strict';
// Jev gives bounded semantic feedback. It cannot apply or rewrite a scenario.
(() => {
 const $=s=>document.querySelector(s),button=$('#jev-review-button'),box=$('#jev-review');
 if(!button||!box)return;
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let controller=null,version=0,review=null;
 const intake=document.createElement('section');intake.id='jev-intake';intake.className='jev-intake';intake.hidden=true;intake.setAttribute('aria-live','polite');$('#advisor-connections').before(intake);
 let intakeResult=null;
 function showIntake(result){
  intakeResult=result;
  const completed=result?.status==='completed',items=Array.isArray(result?.items)?result.items:[];
  intake.innerHTML=`<div class="jev-heading"><h3>客户的话，对应哪些需求</h3><span>${completed?'Jev 已初步定位':result?.status==='running'?'Jev 正在定位':result?.status==='stale'?'需重新定位':'本轮定位未完成'}</span></div>${completed?(items.length?`<div class="jev-intake-mappings">${items.map(item=>`<div><span>${esc(item.label)}</span><span class="jev-intake-arrow" aria-hidden="true">→</span><strong>${esc(item.meaning)}</strong></div>`).join('')}</div>`:'<p>本轮没有定位到明确的计算指标，需要继续描述业务需求。</p>')+(!result.finished&&result.questions?.length?`<p class="jev-intake-question">先确认：${result.questions.map(esc).join('；')}</p>`:''):`<p>${esc(result?.status==='running'?'先区分并发、首 Token、生成速度、吞吐与输入输出…':result?.note||'继续根据客户原话整理需求，含糊的地方会追问。')}</p>`}${completed?`<small>${result.clarifying?'请回答对话中的口径问题，再整理具体参数。':result.finished?'具体参数见右侧需求摘要，仍需核对确认。':'已定位的含义仍待确认，正在继续整理具体数值与追问。'}</small>`:''}`;
  intake.hidden=false;
 }
 window.addEventListener('advisor-jev-intake',event=>showIntake(event.detail));
 window.addEventListener('advisor-jev-intake-clear',()=>{intakeResult=null;intake.hidden=true;intake.innerHTML='';});
 window.addEventListener('advisor-jev-intake-stop',()=>{if(intakeResult?.status==='running')showIntake({status:'unavailable',note:'本轮定位已停止，输入仍保留。'});});
 const staleIntake=()=>{if(intakeResult)showIntake({status:'stale',note:'场景或参数已修改，请按最新客户表述重新定位。'});};
 window.addEventListener('advisor-requirements-change',staleIntake);
 $('#scenario').addEventListener('input',staleIntake);
 function show(result){
  review=result;
  const complete=result?.status==='completed',findings=Array.isArray(result?.findings)?result.findings:[];
  box.innerHTML=`<div class="jev-heading"><h3>业务与需求复核</h3><span>${complete?'Jev 已复核':({not_configured:'Jev 待连接',disabled:'Jev 已关闭',unavailable:'本次未完成',stale:'需求已变化',running:'正在复核'})[result?.status]||'Jev'}</span></div>${complete?findings.length?`<p>这些地方需要向客户确认：</p><ul>${findings.map(f=>`<li>${esc(f.message)}</li>`).join('')}</ul>`:'<p>本轮未识别出明显的语义疑点，参数可行性仍由计算器核验。</p>':`<p>${esc(result?.note||'复核当前场景中业务、并发、上下文和预算的表述。')}</p>`}<small>复核只提出疑点；不改需求，不代替性能计算或业务样本验证。</small>`;
  box.hidden=false;
 }
 function invalidate(){
  version++;controller?.abort();controller=null;button.disabled=false;
  if(review)show({status:'stale',note:'场景文字或需求已修改，请按最新内容重新复核。'});
 }
 window.addEventListener('advisor-requirements-change',invalidate);
 $('#scenario').addEventListener('input',invalidate);
 window.addEventListener('advisor-jev-review',event=>{if(event.detail)show(event.detail);});
 button.onclick=async()=>{
  if(controller)return;
  const scenario=window.PanelHarness.getScenario();
  const text=$('#scenario').value.trim()||[...scenario.messages].reverse().find(m=>m.role==='user')?.content||scenario.requirements.task||'';
  if(!text){show({status:'unavailable',note:'先描述客户业务，或在右侧填写业务用途和需求，再进行复核。'});$('#scenario').focus();return;}
  const current=++version;
  const requestController=new AbortController();controller=requestController;button.disabled=true;
  const timeout=setTimeout(()=>requestController.abort(),25000);
  show({status:'running',note:'正在核对业务场景与需求表述…'});
  try{
   const response=await fetch('/api/advisor/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario_text:text,...scenario}),signal:requestController.signal});
   const result=await response.json();if(current!==version)return;
   if(!response.ok)throw Error(result.error||'业务复核暂不可用');
   if(!result.review||!['completed','not_configured','disabled','unavailable'].includes(result.review.status))throw Error('业务复核返回不完整');
   show(result.review);
  }catch(error){if(current===version)show({status:'unavailable',note:error.name==='AbortError'?'复核超时，请稍后重试。':error.message});}
  finally{clearTimeout(timeout);if(current===version){controller=null;button.disabled=false;}}
 };
 fetch('/api/advisor/status').then(r=>r.ok?r.json():null).then(status=>{
  if(!status)return;
  const el=$('#advisor-connections');
  el.textContent=`Jev需求定位与业务复核：${status.jev?.ready?'已配置':status.jev?.configured?'已配置，暂不可用':'待配置'} · DeepSeek需求整理：${status.configured?'已配置':'待配置'}。`;
  if(!status.configured)el.textContent+=' 可先手动填写右侧需求；Jev用于判断疑点，自由对话需要另接聊天服务。';
 }).catch(()=>{});
})();
