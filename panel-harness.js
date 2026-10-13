'use strict';
(() => {
 const D=window.AppData,L=window.ImpactLab;
 const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const names={concurrency:'并发',inputK:'输入长度',outputK:'输出长度',speed:'单路吞吐',ttft:'首 Token 迟延'};
 const units={concurrency:'路',inputK:'K Token',outputK:'K Token',speed:'Token/s',ttft:'秒'};
 const keys=L.variables;
 // Slider position always increases left to right; latency seconds decrease.
 const stops=L.latencyStops;
 const sliderValue=(key,value)=>key==='ttft'?stops.indexOf(value):value;
 const actualValue=(key,value)=>key==='ttft'?stops[value]:value;
 const fmt=n=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:3}).format(n);
 const label=(k,v)=>['inputK','outputK'].includes(k)&&v>=1000?fmt(v/1000)+'M Token':fmt(v)+' '+units[k];
 const experiment=L.experiment(D),{reference,baseline}=experiment,values=Object.fromEntries(keys.map(k=>[k,reference[k]])),results={};
 const pending=new Set();let frame=0;
 function drawResult(key){
  const r=results[key]=experiment.estimate(key,values[key]),box=$(`[data-row-result="${key}"]`);
  box.innerHTML=`<div><span>预计采购费用</span><strong>${r.cost===null?'—':fmt(r.cost/10000)} <small>万元</small></strong></div><div><span>设备</span><strong>${r.cards===null?'—':fmt(r.cards)} <small>张卡</small><em> / ${r.servers===null?'—':fmt(r.servers)} 台</em></strong></div>${r.message?`<p class="sensitivity-message">${esc(r.message)}</p>`:''}`;
 }
 function schedule(key){pending.add(key);if(frame)return;frame=requestAnimationFrame(()=>{frame=0;for(const k of pending)drawResult(k);pending.clear();});}
 function specs(){
  const m=D.models.dsv4f,c=D.cards.h200;
  return `<section class="panel sensitivity-specs"><div class="sensitivity-spec-grid"><div><h2>${esc(m.name)} <small>FP8</small></h2><p>总参数 ${fmt(m.totalParamsB)}B · 激活 ${fmt(m.activeParamsB)}B · 原生上下文 ${fmt(m.nativeContextTokens)} Token</p><a href="https://huggingface.co/deepseek-ai/DeepSeek-V4-Flash" target="_blank" rel="noreferrer">模型参数 ↗</a></div><div><h2>${esc(c.name)}</h2><p>显存 ${fmt(c.memoryGB)} GB · 显存带宽 ${fmt(c.bandwidthGBs/1000)} TB/s · FP8 稠密算力 ${fmt(c.computeTflops.fp8)} TFLOP/s</p><a href="https://www.nvidia.com/en-us/data-center/h200/" target="_blank" rel="noreferrer">硬件参数 ↗</a></div></div><p class="sensitivity-reference">基准需求：并发 ${reference.concurrency} 路 · 输入 ${label('inputK',reference.inputK)} · 输出 ${label('outputK',reference.outputK)} · 单路 ${label('speed',reference.speed)} · 首 Token ≤ ${label('ttft',reference.ttft)}。</p><div class="sensitivity-baseline" data-baseline><span>基准方案</span><strong>${baseline.servers===null?'—':fmt(baseline.servers)} <small>台</small> · ${baseline.cards===null?'—':fmt(baseline.cards)} <small>张 H200</small></strong><strong>${baseline.cost===null?'—':fmt(baseline.cost/10000)} <small>万元</small></strong></div><p class="sensitivity-instruction">下面每行仅改变这一项，其余四项始终采用上述基准值。</p><p class="sensitivity-pricing">每台 ${reference.slots} 卡；每卡 ${fmt(reference.cardWan)} 万元，服务器另计 ${fmt(reference.platformWan)} 万元/台。采用目录规划报价，不含交换机与布线；性能参考同型号公开测试修正，仍为估算。<a href="https://github.com/sgl-project/sglang/blob/5b5d72123935dc2a3fb341790796ec1a987d31ce/docs/src/snippets/configs/deepseek-ai/deepseek-v4-benchmarks.jsx" target="_blank" rel="noreferrer">测试来源 ↗</a> 按整机采购，未增加台数时费用不变。</p></section>`;
 }
 function renderTrace(){
  cancelAnimationFrame(frame);frame=0;pending.clear();
  $('#trace-content').innerHTML=specs()+`<section class="panel sensitivity-rows" aria-label="五个变量分别试算">${keys.map(key=>{
   const b=L.bounds(reference,key,D),latency=key==='ttft';
   const number=latency?`<select id="sensitivity-value-${key}" data-value="${key}" aria-label="${names[key]}，单位秒">${stops.map(v=>`<option value="${v}" ${v===values[key]?'selected':''}>${v}</option>`).join('')}</select>`:`<input id="sensitivity-value-${key}" data-value="${key}" type="number" min="${b.min}" max="${b.max}" step="${b.step}" value="${values[key]}" aria-label="${names[key]}，单位${units[key]}">`;
   const scale=latency?`<div class="sensitivity-scale-stops" aria-hidden="true">${stops.map((v,i)=>`<span style="left:${i/(stops.length-1)*100}%">${v}</span>`).join('')}</div>`:`<div><span>${label(key,b.min)}</span><span>${label(key,b.max)}</span></div>`;
   return `<article class="sensitivity-row" data-sensitivity-row="${key}"><div class="sensitivity-control"><label for="sensitivity-value-${key}">${names[key]}</label><div class="sensitivity-number">${number}<span>${units[key]}</span></div><div class="sensitivity-slider"><input data-slider="${key}" dir="ltr" type="range" min="${latency?0:b.min}" max="${latency?stops.length-1:b.max}" step="${latency?1:b.step}" value="${sliderValue(key,values[key])}" aria-valuetext="${label(key,values[key])}" aria-label="拖动改变${names[key]}">${scale}</div></div><div class="sensitivity-result" data-row-result="${key}" aria-live="polite" aria-atomic="true"></div></article>`;
  }).join('')}</section>`;
  function update(e){
   const el=e.target,key=el.dataset.value||el.dataset.slider;if(!el.checkValidity())return;
   values[key]=Number((el.dataset.slider?actualValue(key,Number(el.value)):Number(el.value)).toFixed(3));
   const slider=$(`[data-slider="${key}"]`);slider.value=sliderValue(key,values[key]);slider.setAttribute('aria-valuetext',label(key,values[key]));
   if(el.dataset.slider)$(`[data-value="${key}"]`).value=values[key];
   schedule(key);
  }
  document.querySelectorAll('[data-value],[data-slider]').forEach(el=>{el.oninput=update;el.onchange=e=>{if(!el.checkValidity()){el.reportValidity();return;}update(e);};});
  keys.forEach(drawResult);
 }
 window.PanelHarness={renderTrace,getRows:()=>structuredClone(results),getBaseline:()=>structuredClone(baseline)};
 if(location.hash==='#trace')renderTrace();
})();
