'use strict';
(function(){
 let running=false,timer=null;
 const node=()=>document.getElementById('catalog-sync-message');
 const say=text=>{if(node())node().textContent=text;};
 async function poll(){
  try{
   const response=await fetch('/api/catalog/sync/status');if(!response.ok)throw Error('status');
   const data=await response.json(),job=data.job;
   if(job.state==='running'){say('正在扫描近60天的新模型与芯片…');timer=setTimeout(poll,3000);return;}
   running=false;const button=document.getElementById('catalog-sync-start');if(button)button.disabled=false;
   if(job.state==='done'){
    say('扫描完成，刷新后查看更新和待核验记录。');
    const reload=document.getElementById('catalog-sync-reload');if(reload)reload.hidden=false;
   }else if(job.state==='failed'){say('扫描未完成，已保留原数据。请稍后重试。');}
  }catch{running=false;say('暂时无法读取扫描状态，请稍后重试。');const b=document.getElementById('catalog-sync-start');if(b)b.disabled=false;}
 }
 document.addEventListener('click',async event=>{
  if(event.target.closest('#catalog-sync-reload')){location.reload();return;}
  if(!event.target.closest('#catalog-sync-start')||running)return;
  running=true;event.target.closest('button').disabled=true;say('正在启动扫描…');
  try{
   const response=await fetch('/api/catalog/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days:60})});
   if(!response.ok){const data=await response.json();throw Error(data.error||'扫描启动失败');}
   await poll();
  }catch(error){running=false;say(error.message==='Failed to fetch'?'无法连接更新服务，请稍后重试。':error.message);const b=document.getElementById('catalog-sync-start');if(b)b.disabled=false;}
 });
 document.addEventListener('click',event=>{if(event.target.closest('[data-page="data"]')){if(running)say('扫描仍在后台运行…');}});
 window.addEventListener('pagehide',()=>clearTimeout(timer));
})();
