'use strict';
// 中文测试
(() => {
  const D=window.AppData, Engine=window.CostEngine, Lineage=window.CalculationLineage, $=id=>document.getElementById(id);
  const modelText={
    dsr1:{openWeights:'是',source:'DeepSeek-R1 官方模型卡与配置',note:'满血推理模型；总参数用于权重显存。'},
    dsv32:{openWeights:'是',source:'DeepSeek-V3.2-Exp 官方仓库与配置',note:'实验版本；上线前需确认推理框架兼容性。'},
    kimik2:{openWeights:'是',source:'Moonshot AI Kimi-K2 官方模型卡与配置',note:'1T 总参数，完整权重部署对显存要求很高。'},
    qwen235:{openWeights:'是',source:'Qwen3 官方模型卡与 config.json',note:'通用 MoE 主力模型。'},
    qwencoder:{openWeights:'是',source:'Qwen3-Coder 官方模型卡；配置字段需按具体版本复核',note:'面向代码与 Agent，长上下文会显著增加 KV 显存。'},
    qwennext:{openWeights:'是',source:'Qwen3-Next 官方模型卡；混合注意力按近似 GQA 估算 KV',note:'轻激活参数模型，适合高吞吐场景评估。'},
    glm45:{openWeights:'是',source:'GLM-4.5 官方模型卡；KV 结构需以实际 config 为准',note:'面向推理、代码和 Agent 的开源权重模型。'},
    llama4m:{openWeights:'是（受许可约束）',source:'Meta Llama 4 官方模型卡',note:'1M 上下文是能力上限，不应默认全部驻留。'},
    gptoss120:{openWeights:'是',source:'OpenAI gpt-oss 官方模型卡与配置',note:'原生 MoE 权重格式与普通 INT4 不完全等价。'},
    gptoss20:{openWeights:'是',source:'OpenAI gpt-oss 官方模型卡与配置',note:'适合单机或少卡部署评估。'},
    mistral31:{openWeights:'是',source:'Mistral Small 3.1 官方模型卡',note:'小型高质量模型，适合成本敏感的本地部署。'}
  };
  Object.entries(modelText).forEach(([id,text])=>Object.assign(D.models[id],text));
  D.cards.a910c.note='不提供 FP8；优先评估 W8A8（INT8 权重 + INT8 激活），模型或框架未适配时回退 BF16。';

  const roleOrder=['code','product','office','agent'];
  let cloudMode='actual', pricingMode='components', calculatorMode='forward', reverseTarget='ttft', reverseConcurrencyMode='active', toastTimer=null, advisorDraft=null, lastAdvisorSnapshot=null, advisorHistory=[], advisorTurnCount=0, precisionCardId=null, selectedLineageInput=null;
  const precisionBytes={fp16:2,bf16:2,fp8:1,int8:1,int8wo:1,fp4:.5,int4:.5,mxfp4:.5};
  // 算力档位：W8A8 权重与激活都走 INT8 管线（通常为 FP16 档的 2 倍）；
  // 仅权重 INT8（W8A16）只是把权重压到 1 byte，矩阵乘仍走 FP16 管线，算力不翻倍。
  const precisionCompute={fp16:'fp16',bf16:'fp16',fp8:'fp8',int8:'int8',int8wo:'fp16',fp4:'fp8',int4:'fp16',mxfp4:'fp8'};
  const number=(id,fallback=0)=>{const v=Number($(id)?.value);return Number.isFinite(v)?v:fallback;};
  const fmt=(v,d=0)=>Number(v||0).toLocaleString('zh-CN',{maximumFractionDigits:d});
  const fmtPrice=v=>Number(v||0).toLocaleString('zh-CN',{minimumFractionDigits:Math.abs(v)<1?3:2,maximumFractionDigits:4});
  const money=v=>{const n=Number(v||0);if(n>=1e8)return `¥${(n/1e8).toFixed(2)} 亿`;if(n>=1e4)return `¥${(n/1e4).toFixed(n>=1e6?1:2)} 万`;return `¥${fmt(n)}`;};
  const gradeClass=g=>g==='A'?'grade-a':g==='B'?'grade-b':'grade-c';

  function renderRoleInputs(){
    $('roleStack').innerHTML=roleOrder.map((key,index)=>{
      const r=D.roleDefaults[key];
      return `<details class="role-card" data-role="${key}" ${index===0?'open':''}><summary><span class="role-title"><span class="role-index">0${index+1}</span><span><strong>${r.name}</strong><small>并行 ${r.parallelTasks} · 前缀复用 ${Math.round(r.prefixReuse*100)}%</small></span></span><span class="role-summary-value" id="${key}RoleSummary">${r.users} 人</span></summary><div class="role-fields"><label>人数<input id="${key}Users" type="number" value="${r.users}" min="0"><small>计划开放用户</small></label><label>峰值活跃率<input id="${key}ActivePct" type="number" value="${r.activePct}" min="0" max="100"><small>%</small></label><label>Prefill 输入<input id="${key}PrefillK" type="number" value="${r.prefillK}" min="0" step="0.1"><small>K / 请求 · 新增部分</small></label><label>Decode 输出<input id="${key}DecodeK" type="number" value="${r.decodeK}" min="0" step="0.1"><small>K Token / 请求</small></label><label>会话上下文<input id="${key}SessionContextK" type="number" value="${r.sessionContextK}" min="0" step="0.1"><small>K · 决定 KV 占用</small></label><label>每日请求<input id="${key}Requests" type="number" value="${r.requests}" min="0" step="0.1"><small>次 / 人·天</small></label></div></details>`;
    }).join('');
  }

  function populateSelectors(){
    const grouped=(items,selected)=>{const groups={};Object.values(items).forEach(x=>(groups[x.vendor]||=[]).push(x));return Object.entries(groups).map(([v,xs])=>`<optgroup label="${v}">${xs.map(x=>`<option value="${x.id}" ${x.id===selected?'selected':''}>${x.name}</option>`).join('')}</optgroup>`).join('');};
    $('modelSelect').innerHTML=grouped(D.models,'qwen235');
    $('cardSelect').innerHTML=grouped(D.cards,'h20');
    $('apiPriceProfile').innerHTML=Object.values(D.apiPrices).map(x=>`<option value="${x.id}" ${x.id==='dsPro'?'selected':''}>${x.name}</option>`).join('');
    $('reverseCardSelect').innerHTML=grouped(D.cards,'a910c');
    $('reverseModelSelect').insertAdjacentHTML('beforeend',Object.values(D.models).map(x=>`<option value="${x.id}">${x.name}</option>`).join(''));
    $('reverseModelSelect').value='qwen235';
  }

  function precisionSupport(item){
    const text=(item.precisions||item.supportedPrecisions||[]).join(' ').toUpperCase(),set=new Set();
    if(/BF16|FP16/.test(text))set.add('fp16');
    if(/FP8/.test(text))set.add('fp8');
    if(/INT8/.test(text))set.add('int8');
    if(/MXFP4/.test(text))set.add('mxfp4');
    if(/(?:^|[^A-Z])FP4/.test(text))set.add('fp4');
    if(/INT4/.test(text))set.add('int4');
    return set;
  }
  function precisionLabel(id){return ({fp16:'BF16 / FP16 · 2 byte',fp8:'FP8 · 1 byte',int8:'W8A8（权重+激活 INT8）· 1 byte',int8wo:'INT8 仅权重（W8A16）· 1 byte',fp4:'FP4 · 0.5 byte',int4:'INT4 · 0.5 byte',mxfp4:'MXFP4 · 0.5 byte'})[id]||id;}
  // 仅权重 INT8 的可用条件：卡与模型都支持 INT8 权重；
  // W8A8 还要求卡具备 INT8 算力管线（card.w8a8，由 computeTflops.int8 是否存在推导）
  function supportsWeightOnlyInt8(model,card){return precisionSupport(model).has('int8')&&precisionSupport(card).has('int8');}
  function supportsW8A8(model,card){return supportsWeightOnlyInt8(model,card)&&card.w8a8===true;}
  function updatePrecisionOptions(){
    const model=D.models[$('modelSelect').value],card=D.cards[$('cardSelect').value];if(!model||!card)return;
    const ms=precisionSupport(model),cs=precisionSupport(card),previousWeight=$('weightPrecision').value,previousKv=$('kvPrecision').value;
    const weightOrder=['fp8','int8','int8wo','mxfp4','fp4','int4','fp16'];
    let weights=weightOrder.filter(p=>p==='int8wo'?supportsWeightOnlyInt8(model,card):p==='int8'?supportsW8A8(model,card):(ms.has(p)&&cs.has(p)));
    if(!weights.length&&ms.has('fp16')&&cs.has('fp16'))weights=['fp16'];
    if(!weights.length)weights=['fp16'];
    $('weightPrecision').innerHTML=weights.map(p=>`<option value="${p}">${precisionLabel(p)}</option>`).join('');
    const cardChanged=precisionCardId!==card.id,recommended=card.recommendedPrecision;
    $('weightPrecision').value=card.id==='a910c'&&weights.includes('int8')?'int8':cardChanged&&weights.includes(recommended)?recommended:(weights.includes(previousWeight)?previousWeight:weights[0]);
    precisionCardId=card.id;
    const kv=[];if(cs.has('fp16'))kv.push('fp16');if(cs.has('fp8'))kv.push('fp8');if(cs.has('int8'))kv.push('int8');
    const kvOptions=kv.length?kv:['fp16'];
    $('kvPrecision').innerHTML=kvOptions.map(p=>`<option value="${p}">${precisionLabel(p).replace(/ · .*$/,'')}</option>`).join('');
    $('kvPrecision').value=kvOptions.includes(previousKv)?previousKv:kvOptions[0];
    const blocked=[];if(!cs.has('fp8'))blocked.push('FP8');if(!cs.has('fp4')&&!cs.has('int4'))blocked.push('4-bit');
    let note=blocked.length?`${card.name} 未标称支持 ${blocked.join(' / ')}；已从选择器移除，仅保留与 ${model.name} 共同兼容的精度。`:`当前只显示 ${card.name} 与 ${model.name} 的共同兼容精度。`;
    if(card.id==='a910c'){
      note=weights.includes('int8')
        ?`${card.name} 不提供 FP8；当前组合优先采用 W8A8（INT8 权重 + INT8 激活，算力档 ${card.computeTflops.int8}）。若只量化权重、激活仍走 FP16（仅权重 INT8），算力档为 ${card.computeTflops.fp16}，Prefill 慢一半但精度更稳。KV Cache 精度独立选择。`
        :`${card.name} 不提供 FP8，且 ${model.name} 目录未标注 W8A8 适配；当前回退 BF16。KV Cache 精度独立选择。`;
    }
    $('precisionMicrocopy').textContent=note;$('precisionMicrocopy').classList.toggle('is-warning',blocked.length>0);
  }

  function updateReversePrecisionOptions(){
    const card=D.cards[$('reverseCardSelect').value],modelId=$('reverseModelSelect').value;
    const cs=precisionSupport(card),ms=modelId==='auto'?null:precisionSupport(D.models[modelId]);
    const allowed=p=>cs.has(p)&&(!ms||ms.has(p));
    const previous=$('reverseWeightPrecision').value;
    const modelSel=D.models[modelId];
    let weights=['int8','int8wo','fp8','mxfp4','fp4','int4','fp16'].filter(p=>{
      if(p==='int8wo')return !modelSel?cs.has('int8'):supportsWeightOnlyInt8(modelSel,card);
      if(p==='int8')return !modelSel?cs.has('int8')&&card.w8a8===true:supportsW8A8(modelSel,card);
      return allowed(p);
    });
    if(!weights.length)weights=['fp16'];
    $('reverseWeightPrecision').innerHTML=weights.map(p=>`<option value="${p}">${precisionLabel(p)}</option>`).join('');
    const preferred=card.id==='a910c'&&weights.includes('int8')?'int8':weights.includes(card.recommendedPrecision)?card.recommendedPrecision:weights[0];
    $('reverseWeightPrecision').value=weights.includes(previous)?previous:preferred;
    const kv=['fp16','fp8','int8'].filter(p=>cs.has(p));
    $('reverseKvPrecision').innerHTML=(kv.length?kv:['fp16']).map(p=>`<option value="${p}">${precisionLabel(p).replace(/ · .*$/,'')}</option>`).join('');
    $('reversePrecisionNote').textContent=card.id==='a910c'
      ?(modelId!=='auto'&&!weights.includes('int8')?'910C 不支持 FP8；当前模型未标注 W8A8 适配，已回退 BF16。':'910C 不支持 FP8；自动筛选优先 W8A8，未适配模型会排除。')
      :'只显示当前卡与所选模型共同支持的精度。';
    $('reverseCardNote').textContent=`${card.memoryGB}GB / 卡 · ${card.interconnect}；吞吐为当前工程档案，不代表理论算力。`;
  }

  function setCalculatorMode(mode,draw=true){
    calculatorMode=mode==='reverse'?'reverse':'forward';
    $('calculatorPage').classList.toggle('reverse-mode',calculatorMode==='reverse');
    $('forwardMode').classList.toggle('is-active',calculatorMode==='forward');$('reverseMode').classList.toggle('is-active',calculatorMode==='reverse');
    $('forwardMode').setAttribute('aria-pressed',calculatorMode==='forward');$('reverseMode').setAttribute('aria-pressed',calculatorMode==='reverse');
    $('forwardCalculator').hidden=calculatorMode!=='forward';$('reverseCalculator').hidden=calculatorMode!=='reverse';
    const url=new URL(location.href);
    if(calculatorMode==='reverse')url.searchParams.set('mode','reverse');else url.searchParams.delete('mode');
    if(calculatorMode==='reverse')url.searchParams.set('target',reverseTarget);else url.searchParams.delete('target');
    if(calculatorMode==='reverse'&&reverseTarget==='concurrency')url.searchParams.set('concurrencyMode',reverseConcurrencyMode);else url.searchParams.delete('concurrencyMode');
    history.replaceState(null,'',url);
    $('navCalc').querySelector('span').textContent=calculatorMode==='reverse'?'能力':'测算';
    $('navCalc').querySelector('small').textContent=calculatorMode==='reverse'?'CAPABILITY':'CALCULATE';
    if(draw)render();
    requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'smooth'}));
  }

  function setCloudMode(mode,draw=true){
    cloudMode=mode==='continuous'?'continuous':'actual';
    $('cloudActual').classList.toggle('is-active',cloudMode==='actual');$('cloudContinuous').classList.toggle('is-active',cloudMode==='continuous');
    $('cloudActual').setAttribute('aria-pressed',cloudMode==='actual');$('cloudContinuous').setAttribute('aria-pressed',cloudMode==='continuous');
    $('actualCloudPanel').hidden=cloudMode!=='actual';$('continuousCloudPanel').hidden=cloudMode!=='continuous';if(draw)render();
  }
  function setPricingMode(mode,draw=true){
    pricingMode=mode==='nodeQuote'?'nodeQuote':'components';
    $('pricingComponents').classList.toggle('is-active',pricingMode==='components');$('pricingQuote').classList.toggle('is-active',pricingMode==='nodeQuote');
    $('componentPricingPanel').hidden=pricingMode!=='components';$('quotePricingPanel').hidden=pricingMode!=='nodeQuote';if(draw)render();
  }
  function applyApiPreset(){const p=D.apiPrices[$('apiPriceProfile').value];$('apiHitPrice').value=p.hit;$('apiMissPrice').value=p.miss;$('apiOutPrice').value=p.out;$('peakShareRow').hidden=!p.peakPricing;}
  function refreshCardMeta(){const c=D.cards[$('cardSelect').value];$('cardMicrocopy').textContent=`${c.memoryGB}GB · ${c.bandwidthGBs?fmt(c.bandwidthGBs,1)+'GB/s':'带宽待确认'} · ${c.tdpW}W；${c.note}`;updatePrecisionOptions();}
  function applyCardPreset(){const c=D.cards[$('cardSelect').value],b=D.benchmarkProfiles[c.id];$('cardPriceWan').value=c.cardPriceWan;$('platformPriceWan').value=c.platformPriceWan;$('decodePerCard').value=b.decode;$('prefillPerCard').value=b.prefill;refreshCardMeta();}

  function readState(){
    const roles=roleOrder.map(k=>({...D.roleDefaults[k],users:number(`${k}Users`),prefillK:number(`${k}PrefillK`),decodeK:number(`${k}DecodeK`),sessionContextK:number(`${k}SessionContextK`),requests:number(`${k}Requests`),activePct:number(`${k}ActivePct`)}));
    const apiPrice=D.apiPrices[$('apiPriceProfile').value],card=D.cards[$('cardSelect').value];
    const weightPrecision=$('weightPrecision').value||'fp16',kvPrecision=$('kvPrecision').value||'fp16';
    return {cloudMode,pricingMode,roles,streamSpeed:number('streamSpeed',50),actualDailyCost:number('actualDailyCost'),workdays:number('workdays',250),apiPrice,cacheRate:number('cacheRate',80)/100,peakShare:number('peakShare',75)/100,apiHitPrice:number('apiHitPrice',apiPrice.hit),apiMissPrice:number('apiMissPrice',apiPrice.miss),apiOutPrice:number('apiOutPrice',apiPrice.out),model:D.models[$('modelSelect').value],weightPrecision,weightPrecisionLabel:precisionLabel(weightPrecision),weightBytes:precisionBytes[weightPrecision]||2,computeKey:precisionCompute[weightPrecision]||'fp16',kvPrecision,kvPrecisionLabel:precisionLabel(kvPrecision),kvBytes:precisionBytes[kvPrecision]||2,card,benchmark:D.benchmarkProfiles[card.id],nodeCardCapacity:number('nodeCardCapacity',8),cardPriceWan:number('cardPriceWan'),platformPriceWan:number('platformPriceWan'),integrationPct:number('integrationPct',15)/100,nodeQuoteWan:number('nodeQuoteWan'),decodePerCard:number('decodePerCard'),prefillPerCard:number('prefillPerCard'),capacityBuffer:number('capacityBuffer',1.2),mfu:number('mfu',45)/100,bandwidthEff:number('bandwidthEff',70)/100,ttftSlo:number('ttftSlo',10),ttftBurstShare:number('ttftBurstShare',25)/100,memoryUtilization:number('memoryUtilization',85)/100,runtimeReserve:number('runtimeReserve',12)/100,platformPowerKw:number('platformPowerKw',.6),idlePowerRatio:number('idlePowerRatio',25)/100,pue:number('pue',1.3),electricityRate:number('electricityRate',.7),maintenancePct:number('maintenancePct',5)/100,softwareOnceWan:number('softwareOnceWan'),softwareYearWan:number('softwareYearWan'),opsMonthlyWan:number('opsMonthlyWan')};
  }

  function readReverseState(){
    const card=D.cards[$('reverseCardSelect').value],modelId=$('reverseModelSelect').value;
    const weightPrecision=$('reverseWeightPrecision').value||'fp16';
    // int8wo（仅权重 INT8）与 int8（W8A8）共用模型的 INT8 支持标记
    const modelSupportKey=weightPrecision==='int8wo'?'int8':weightPrecision;
    let models=modelId==='auto'?Object.values(D.models):[D.models[modelId]];
    models=models.filter(Boolean).filter(model=>precisionSupport(model).has(modelSupportKey));
    const typicalInputK=number('reverseInputK',128),decodeOutputK=number('reverseOutputK',1);
    return {card,benchmark:D.benchmarkProfiles[card.id],models,deviceCount:number('reverseDeviceCount',1),cardsPerDevice:number('reverseCardsPerDevice',8),weightBytes:precisionBytes[weightPrecision]||2,computeKey:precisionCompute[weightPrecision]||'fp16',kvBytes:precisionBytes[$('reverseKvPrecision').value]||2,maxContextK:Math.max(1,number('reverseMaxContextK',128),typicalInputK+decodeOutputK),typicalInputK,decodeOutputK,targetUserSpeed:number('reverseTargetSpeed',30),memoryUtilization:number('reverseMemoryUtil',85)/100,runtimeReserve:number('reverseRuntimeReserve',12)/100,plannedConcurrency:number('reversePlannedConcurrency',20),requestRate:number('reverseRequestRate',.2),userRequestsPerHour:number('reverseUserRatePerHour',2),prefixCache:number('reversePrefixCache',0)/100,mfu:number('mfu',45)/100,bandwidthEff:number('bandwidthEff',70)/100,ttftSlo:number('reverseTtftSlo',10),responseSlo:number('reverseResponseSlo',60),weightPrecision,modelId};
  }

  function render(){const s=readState(),r=Engine.compute(s);renderRoleSummaries(r);renderSummary(s,r);renderDerivation(s,r);renderChart(r);renderReverse();renderLineage();}
  function renderRoleSummaries(r){
    r.workload.roles.forEach(x=>{const t=$(`${x.key}RoleSummary`);if(t)t.textContent=`${fmt(x.users)} 人 · ${fmt(x.concurrency,1)} 路`;});
    $('peopleCount').textContent=`${fmt(r.workload.roles.reduce((n,x)=>n+x.users,0))} 人`;
  }
  function renderSummary(s,r){
    const {workload:w,cloud:c,capacity:k,local:l}=r,has=Number.isFinite(r.breakevenDays),days=has?Math.ceil(r.breakevenDays):null,winner=r.winner3==='local'?'本地部署':'云端 API';
    $('headerStatus').textContent=`${w.sourceLabel} · ${k.cards} 卡 / ${k.nodes} 台`;
    $('heroBreakeven').textContent=has?`第 ${fmt(days)} 天`:'暂无回本点';
    $('heroSummary').textContent=has?`达到临界点后，本地累计成本开始低于云端。三年口径当前更偏向${winner}。`:'云端年化成本尚未覆盖本地运行成本，当前场景不建议仅为省钱而自建。';
    $('heroBadge').textContent=cloudMode==='continuous'?'12 小时持续负载':'实际日账单 + 同一组织画像';
    $('breakevenValue').textContent=has?`${fmt(days)} 天`:'不存在';
    $('breakevenCaption').textContent=has?`约 ${(days/365).toFixed(1)} 年；三年 TCO：云端 ${money(r.cloudTco3)}，本地 ${money(r.localTco3)}`:`云端年化日均 ${money(c.averageDayCost)} ≤ 本地日均 OpEx ${money(l.averageDayOpex)}`;
    $('cloudDailyValue').textContent=money(c.usageDayCost);$('cloudAnnualValue').textContent=`年成本 ${money(c.annualCost)} · ${c.workdays} 个使用日`;
    $('capexValue').textContent=money(l.capex);$('hardwareValue').textContent=`硬件 ${money(l.hardwareCapex)} · 软件一次性 ${money(l.capex-l.hardwareCapex)}`;
    $('opexValue').textContent=money(l.annualOpex);$('powerValue').textContent=`年电费 ${money(l.annualElectricity)} · 活跃功耗 ${l.activePowerKw.toFixed(1)}kW`;
    $('capacityValue').textContent=`${k.cards} 卡 / ${k.nodes} 台`;$('bottleneckValue').textContent=`${k.cardsPerReplica} 卡/同模型部署组 · ${k.bottleneck}`;
    $('localConfigChip').textContent=`${k.cards} 卡 · ${k.nodes} 台`;
    $('resultConfidence').textContent=`卡 ${s.card.confidence} · 模型 ${s.model.confidence} · 吞吐 C`;
    $('continuousFormula').innerHTML=`规划并发 <b>${w.scenarioConcurrency} 路</b> × ${w.streamSpeed} tok/s × 12h → 输出 <b>${fmt(w.outputM,1)}M</b>；沿用画像输入/输出比 ${w.inputOutputRatio.toFixed(1)} : 1 → 输入 <b>${fmt(w.inputM,1)}M Token</b>。`;
    $('cacheRateOut').textContent=`${$('cacheRate').value}%`;$('peakShareOut').textContent=`${$('peakShare').value}%`;
  }

  function renderReverse(){
    if(!$('reverseCardSelect')||!$('reverseWeightPrecision').options.length)return;
    const s=readReverseState(),r=Engine.computeReverseCapacity(s),available=r.results.filter(x=>x.deployable);
    const selected=r.results[0];
    $('reverseHardwareChip').textContent=`总计 ${fmt(r.totalCards)} 卡 · ${fmt(r.totalCards*r.card.memoryGB)}GB`;
    $('reverseAssumptionText').textContent=`按 ${fmt(s.typicalInputK,1)}K 输入、${fmt(s.decodeOutputK,1)}K 输出、${fmt(s.plannedConcurrency)} 位在线用户、${fmt(s.targetUserSpeed)} tok/s、人均 ${fmt(s.userRequestsPerHour,1)} 次/小时与 ${Math.round(s.prefixCache*100)}% 前缀缓存计算；结果为工程估算 C。`;
    $('reverseCandidateCount').textContent=`${available.length} 个可部署`;
    $('headerStatus').textContent=calculatorMode==='reverse'?`${r.card.name} · ${fmt(r.totalCards)} 卡反向推演`:$('headerStatus').textContent;
    const concurrencyIsOnline=reverseConcurrencyMode==='online';
    const targetMeta={
      concurrency:{label:'最大并发',title:concurrencyIsOnline?'计算可持续在线用户所需条件':'计算同时请求上限所需条件',needed:concurrencyIsOnline?['input','output','speed','userRate']:['input','output','speed','ttftSlo']},
      speed:{label:'单路速度',title:'计算单路速度所需条件',needed:['input','concurrency','arrival','cache']},
      ttft:{label:'首Token延迟',title:'计算首Token延迟所需条件',needed:['input','concurrency','arrival','cache']},
      input:{label:'最大输入',title:'计算最大输入所需条件',needed:['output','concurrency','ttftSlo','arrival','cache']},
      output:{label:'最大输出',title:'计算最大输出所需条件',needed:['input','concurrency','speed','responseSlo']}
    };
    const meta=targetMeta[reverseTarget];
    document.querySelectorAll('[data-reverse-target]').forEach(button=>{const active=button.dataset.reverseTarget===reverseTarget;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',active);});
    $('reverseConcurrencyMode').hidden=reverseTarget!=='concurrency';
    document.querySelectorAll('[data-concurrency-mode]').forEach(button=>{const active=button.dataset.concurrencyMode===reverseConcurrencyMode;button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',active);});
    $('reverseConcurrencyModeNote').textContent=concurrencyIsOnline?'按人均请求频率折算长期在线用户':'同时到达，并满足首 Token 目标的请求数';
    document.querySelectorAll('.reverse-condition-row').forEach(row=>row.hidden=!meta.needed.includes(row.dataset.condition));
    $('reverseConditionTitle').textContent=meta.title;
    if(!selected){
      $('reverseModelFit').textContent='当前精度没有匹配模型';$('reverseAnswerLabel').textContent=meta.label;$('reverseAnswerValue').textContent='无法计算';$('reverseAnswerBreakdown').innerHTML='';$('reverseAnswerNote').textContent='请更换模型或精度。';$('reverseTrace').innerHTML='';return;
    }
    $('reverseModelFit').textContent=selected.deployable?`每组 ${selected.cardsPerGroup} 卡 · 可部署 ${selected.groupCount} 个同模型部署组`:`当前设备不满足：${selected.bottleneck}`;
    const planned=Math.max(1,s.plannedConcurrency),groupDecode=selected.groupCount?selected.totalDecode/selected.groupCount:0;
    const uncappedStreamSpeed=Math.min(groupDecode,selected.totalDecode/Math.max(planned,1));
    const actualSpeed=reverseTarget==='speed'?uncappedStreamSpeed:Math.min(s.targetUserSpeed,uncappedStreamSpeed);
    const effectiveInputTokens=s.typicalInputK*1000*(1-s.prefixCache);
    const decodeLoad=planned*s.targetUserSpeed/Math.max(selected.totalDecode,1);
    // TTFT = 排队等待 + 自身预填 + 调度通信。排队按「B 路请求同时到达、依次预填」建模：
    // 平均等待 (B−1)/2 份预填时间（首个不用等，最后一个等 B−1 份）。
    // B = 每组同时请求数 = 规划并发 ÷ 部署组数；预填能力 = 整机 Prefill 吞吐 ÷ 组数。
    const groupCount=Math.max(1,selected.groupCount||1);
    const prefillPerGroup=Math.max(selected.totalPrefill/Math.max(groupCount,1),1);
    const streamsPerGroup=planned/Math.max(groupCount,1);
    const prefillSeconds=effectiveInputTokens/prefillPerGroup;
    const queueSeconds=Math.max(.2,Math.max(0,streamsPerGroup-1)/2*prefillSeconds);
    const interconnect=(s.card&&s.card.interconnect)||'';
    const overheadSeconds=selected.cardsPerGroup>1?(/HCCS/i.test(interconnect)?0.6:/NVLink/i.test(interconnect)?0.4:1):0.55;
    const ttftLow=Math.max(.5,queueSeconds*.7+prefillSeconds*.9+overheadSeconds*.7);
    const ttftHigh=Math.max(ttftLow+.5,queueSeconds*1.35+prefillSeconds*1.2+overheadSeconds*1.3);
    const ttftMid=(ttftLow+ttftHigh)/2;
    const modelContextK=selected.contextCapacityK||selected.model.contextK||s.maxContextK;
    const kvPerKGB=selected.perTokenKB/1024;
    const kvContextPerSessionK=selected.totalKvBudgetGB/Math.max(planned,1)/Math.max(kvPerKGB,.00001);
    const ttftInputK=prefillPerGroup*Math.max(0,s.ttftSlo-overheadSeconds-queueSeconds)/1000/Math.max((1-s.prefixCache),.05);
    const maxInputK=Math.max(0,Math.min(modelContextK-s.decodeOutputK,kvContextPerSessionK-s.decodeOutputK,ttftInputK));
    const maxOutputK=Math.max(0,Math.min(modelContextK-s.typicalInputK,kvContextPerSessionK-s.typicalInputK,actualSpeed*s.responseSlo/1000));
    const fullLow=ttftLow+s.decodeOutputK*1000/Math.max(actualSpeed,1),fullHigh=ttftHigh+s.decodeOutputK*1000/Math.max(actualSpeed,1);
    const activeConcurrency=selected.deployable?selected.activeConcurrency:0,onlineConcurrency=selected.deployable?selected.onlineConcurrency:0;
    const maxConcurrency=concurrencyIsOnline?onlineConcurrency:activeConcurrency;
    const kvInputLimit=kvContextPerSessionK-s.decodeOutputK,kvOutputLimit=kvContextPerSessionK-s.typicalInputK;
    const limitText=value=>value<0?`超限 ${fmt(Math.abs(value),1)}K`:`${fmt(value,1)}K`;

    const resultByTarget={
      concurrency:concurrencyIsOnline
        ?{label:'预计可持续在线用户',value:`${fmt(onlineConcurrency)} 人`,breakdown:[['KV会话',`${fmt(selected.memoryConcurrency)}人`],['Decode持续负载',`${fmt(selected.decodeConcurrency)}人`],['Prefill持续负载',`${fmt(selected.prefillConcurrency)}人`]],operators:['取小','取小'],note:`按人均 ${fmt(s.userRequestsPerHour,1)} 次/小时折算长期在线用户；这不是同时请求数。同时请求上限为 ${fmt(activeConcurrency)} 路。`}
        :{label:'预计同时请求上限',value:`${fmt(activeConcurrency)} 路`,breakdown:[['KV显存',`${fmt(selected.memoryConcurrency)}路`],['Decode生成',`${fmt(selected.instantDecodeConcurrency)}路`],['Prefill / TTFT',`${fmt(selected.prefillTtftConcurrency)}路`]],operators:['取小','取小'],note:`按 ${fmt(s.ttftSlo,1)} 秒首 Token 目标计算同时请求；128K 等长输入通常首先受 Prefill 限制。长期在线用户请切换口径。`},
      speed:{label:'预计单路速度',value:`${fmt(actualSpeed,1)} tok/s/路`,breakdown:[['系统Decode',`${fmt(selected.totalDecode)} tok/s`],['同时生成',`${fmt(planned)}路`],['单路估算',`${fmt(actualSpeed,1)} tok/s`]],operators:['÷','＝'],note:'这是当前并行请求下的工程吞吐估算；输入 Prefill 压力过高时会进一步拖慢 Decode，采购前需压测混合负载。'},
      ttft:{label:'预计首Token延迟',value:`${ttftLow.toFixed(1)}–${ttftHigh.toFixed(1)} 秒`,breakdown:[['排队等待',`约${queueSeconds.toFixed(1)}秒`],['Prefill计算',`约${prefillSeconds.toFixed(1)}秒`],['调度通信',`约${overheadSeconds.toFixed(1)}秒`]],operators:['+','+'],note:`TTFT = 排队 + Prefill + 调度通信；区间是工程估算，不是目标环境实测承诺。`},
      input:{label:'预计最大输入',value:`${fmt(maxInputK,1)}K`,breakdown:[['模型上下文',`${fmt(modelContextK-s.decodeOutputK,1)}K`],['KV显存',limitText(kvInputLimit)],['TTFT目标',`${fmt(ttftInputK,1)}K`]],operators:['取小','取小'],note:`取模型上下文、KV显存和${fmt(s.ttftSlo)}秒首Token目标三项边界中的最小值；前缀缓存会改变有效 Prefill 输入。`},
      output:{label:'预计最大输出',value:`${fmt(maxOutputK,1)}K`,breakdown:[['上下文剩余',`${fmt(modelContextK-s.typicalInputK,1)}K`],['KV显存',limitText(kvOutputLimit)],['回答时限',`${fmt(actualSpeed*s.responseSlo/1000,1)}K`]],operators:['取小','取小'],note:`取上下文、KV显存和${fmt(s.responseSlo)}秒回答时限三项边界的最小值；输出越长，占用GPU和KV的时间越久。`}
    };
    const answer=resultByTarget[reverseTarget];
    const capacityWarning=reverseTarget==='concurrency'
      ?(concurrencyIsOnline?planned>onlineConcurrency:planned>activeConcurrency)
      :(planned>selected.memoryConcurrency||planned>selected.instantDecodeConcurrency||streamsPerGroup>1&&queueSeconds>=s.ttftSlo);
    if(capacityWarning&&reverseTarget!=='concurrency')answer.note=`当前条件已超过${streamsPerGroup>1&&queueSeconds>=s.ttftSlo?'排队等待已吃掉首字预算':'GPU容量'}，以下结果是理论估算，不能作为SLO承诺。${answer.note}`;
    if(decodeLoad>1&&reverseTarget!=='concurrency')answer.note=`Decode 需求为装机容量的 ${decodeLoad.toFixed(1)} 倍，稳态单路速度约 ${(selected.totalDecode/planned).toFixed(1)} tok/s。${answer.note}`;
    document.querySelector('.reverse-answer-panel')?.classList.toggle('has-warning',capacityWarning);
    $('reverseAnswerLabel').textContent=answer.label;$('reverseAnswerValue').textContent=answer.value;
    $('reverseAnswerBreakdown').innerHTML=answer.breakdown.map((x,i)=>`<div><span>${x[0]}</span><strong>${x[1]}</strong></div>${i<answer.breakdown.length-1?`<b>${answer.operators?.[i]||'+'}</b>`:''}`).join('');
    $('reverseAnswerNote').textContent=answer.note;
    $('reverseBoundaryConcurrency').textContent=`${fmt(activeConcurrency)} 路`;$('reverseBoundarySpeed').textContent=`${fmt(actualSpeed,1)} tok/s`;$('reverseBoundaryInput').textContent=`${fmt(maxInputK,1)}K`;$('reverseBoundaryOutput').textContent=`${fmt(maxOutputK,1)}K`;$('reverseBoundaryFullTime').textContent=`${fullLow.toFixed(0)}–${fullHigh.toFixed(0)}秒`;
    $('reverseBoundaryConcurrencyNote').textContent=`同时请求 · TTFT ${fmt(s.ttftSlo,1)}秒`;$('reverseBoundaryInputNote').textContent=`按TTFT ${fmt(s.ttftSlo,1)}秒`;$('reverseBoundaryOutputNote').textContent=`按回答时限 ${fmt(s.responseSlo)}秒`;
    $('reverseResultTitle').textContent=selected.model.name;
    $('reverseFinalConcurrency').textContent=selected.deployable?`${fmt(activeConcurrency)} 路`:'无法部署';
    $('reverseFinalCaption').textContent=answer.note;
    $('reverseGroupCount').textContent=selected.deployable?`${selected.groupCount} 组`:'0 组';
    $('reverseGroupDetail').textContent=`每组 ${selected.cardsPerGroup} 卡 · 使用 ${selected.usedCards}/${selected.totalCards} 卡${selected.spareCards?` · 空余 ${selected.spareCards} 卡`:''}`;
    $('reverseMemoryConcurrency').textContent=`${fmt(selected.memoryConcurrency)} 路`;
    $('reverseMemoryDetail').textContent=`每路按 ${fmt(selected.maxContextK)}K 上下文占 ${fmt(selected.sessionKvGB,1)}GB KV`;
    $('reverseDecodeTotal').textContent=`${fmt(selected.totalDecode)} tok/s`;
    $('reverseDecodeDetail').textContent=`瞬时 ${fmt(selected.instantDecodeConcurrency)} 路；按 ${fmt(s.decodeOutputK,1)}K 输出 × 人均 ${fmt(s.userRequestsPerHour,1)} 次/小时 → ${fmt(selected.decodeConcurrency)} 人`;
    $('reversePrefillTotal').textContent=`${fmt(selected.totalPrefill)} tok/s`;
    $('reversePrefillDetail').textContent=`典型 ${fmt(s.typicalInputK,1)}K 输入 → ${selected.requestThroughput.toFixed(2)} 请求/s；TTFT 需压测`;
    $('reversePlannedConcurrencyOut').textContent=`${fmt(planned)} 路`;$('reverseUserSpeed').textContent=`${fmt(actualSpeed,1)} tok/s`;
    $('reverseConcurrencyStatus').textContent=planned<=maxConcurrency?'规划范围内':'超过规划上限';$('reverseSpeedNote').textContent=answer.note;

    const runtime=selected.runtimeGB,requestSeconds=selected.decodeOutputK*1000/selected.targetUserSpeed;
    const concurrencyTrace=concurrencyIsOnline
      ?`<details class="trace-accordion tone-throughput"><summary><span class="trace-index">04</span><span class="trace-copy"><strong>可持续在线用户受长期 Token 负载限制</strong><small>单次输入输出 × 人均请求频率</small></span><span class="trace-value">${fmt(selected.onlineConcurrency)} 人</span><span class="trace-toggle"><i class="when-closed">查看怎么算</i><i class="when-open">收起</i></span></summary><div class="trace-formula"><div class="formula-flow compact-flow"><div class="formula-step"><small>Decode 在线用户</small><code>${fmt(selected.totalDecode)} ÷ (${fmt(selected.decodeOutputK)}K × ${fmt(selected.userRequestsPerHour,1)}次/小时 ÷ 3600)</code><strong class="formula-decode">${fmt(selected.decodeConcurrency)} 人</strong></div><div class="formula-step"><small>Prefill 在线用户</small><code>${fmt(selected.totalPrefill)} ÷ (${fmt(selected.typicalInputK)}K × ${fmt(selected.userRequestsPerHour,1)}次/小时 ÷ 3600)</code><strong>${fmt(selected.prefillConcurrency)} 人</strong></div><div class="formula-step"><small>最终在线用户</small><code>MIN(KV, Decode, Prefill)</code><strong>${fmt(selected.onlineConcurrency)} 人</strong></div></div></div></details>`
      :`<details class="trace-accordion tone-throughput"><summary><span class="trace-index">04</span><span class="trace-copy"><strong>同时请求受 Decode 与 Prefill / TTFT 限制</strong><small>128K 长输入通常首先卡在首 Token 目标</small></span><span class="trace-value">${fmt(selected.activeConcurrency)} 路</span><span class="trace-toggle"><i class="when-closed">查看怎么算</i><i class="when-open">收起</i></span></summary><div class="trace-formula"><div class="formula-flow compact-flow"><div class="formula-step"><small>Decode 瞬时路数</small><code>${fmt(selected.totalDecode)} tok/s ÷ ${fmt(selected.targetUserSpeed)} tok/s/路</code><strong class="formula-decode">${fmt(selected.instantDecodeConcurrency)} 路</strong></div><div class="formula-step"><small>Prefill / TTFT 路数</small><code>${fmt(selected.totalPrefill)} × ${fmt(selected.ttftComputeBudgetSeconds,1)}秒 ÷ ${fmt(selected.typicalInputK)}K</code><strong>${fmt(selected.prefillTtftConcurrency)} 路</strong></div><div class="formula-step"><small>最终同时请求</small><code>MIN(KV, Decode, Prefill/TTFT)</code><strong>${fmt(selected.activeConcurrency)} 路</strong></div></div></div></details>`;
    $('reverseTrace').innerHTML=`
      <div class="trace-simple"><span class="trace-index">01</span><div class="trace-copy"><strong>现有设备换算成总卡数</strong><p>${fmt(r.deviceCount)} 台 × ${fmt(r.cardsPerDevice)} 卡/台</p></div><span class="trace-value">${fmt(r.totalCards)} 卡</span></div>
      <details class="trace-accordion tone-kv"><summary><span class="trace-index">02</span><span class="trace-copy"><strong>先装下一套完整模型</strong><small>权重 + 运行时 + 一路最大上下文 KV</small></span><span class="trace-value">${selected.cardsPerGroup} 卡 / 组</span><span class="trace-toggle"><i class="when-closed">查看怎么算</i><i class="when-open">收起</i></span></summary><div class="trace-formula"><div class="formula-flow compact-flow"><div class="formula-step"><small>权重</small><code>${fmt(selected.model.totalParamsB,1)}B × ${s.weightBytes} Byte</code><strong>${fmt(selected.weightsGB,1)} GB</strong></div><div class="formula-step"><small>运行时余量</small><code>${fmt(selected.weightsGB,1)} × ${Math.round(s.runtimeReserve*100)}%</code><strong>${fmt(runtime,1)} GB</strong></div><div class="formula-step"><small>卡数并按拓扑取整</small><code>⌈(权重 + 余量 + 单路KV) ÷ ${fmt(selected.usableCardGB,1)}GB⌉</code><strong>${selected.rawCardsPerGroup} → ${selected.cardsPerGroup} 卡</strong></div></div></div></details>
      <details class="trace-accordion tone-kv"><summary><span class="trace-index">03</span><span class="trace-copy"><strong>显存允许多少路并发</strong><small>全部部署组 KV 预算 ÷ 单会话 KV</small></span><span class="trace-value">${fmt(selected.memoryConcurrency)} 路</span><span class="trace-toggle"><i class="when-closed">查看怎么算</i><i class="when-open">收起</i></span></summary><div class="trace-formula"><div class="formula-flow compact-flow"><div class="formula-step"><small>单路 KV</small><code>${selected.perTokenKB.toFixed(2)}KB/Token × ${fmt(selected.maxContextK)}K</code><strong class="formula-kv">${fmt(selected.sessionKvGB,1)} GB</strong></div><div class="formula-step"><small>全部 KV 预算</small><code>${fmt(selected.kvBudgetPerGroupGB,1)}GB/组 × ${selected.groupCount}组</code><strong class="formula-kv">${fmt(selected.totalKvBudgetGB,1)} GB</strong></div><div class="formula-step"><small>显存并发上限</small><code>⌊${fmt(selected.totalKvBudgetGB,1)} ÷ ${fmt(selected.sessionKvGB,1)}⌋</code><strong class="formula-kv">${fmt(selected.memoryConcurrency)} 路</strong></div></div></div></details>
      ${concurrencyTrace}
      <div class="trace-conclusion"><span class="trace-index">05</span><div class="trace-copy"><strong>本次求解：${answer.label}</strong><p>${answer.note}</p></div><span class="trace-value conclusion-value">${answer.value}<small>工程估算 C · 待压测</small></span></div>`;
  }

  function renderDerivation(s,r){
    const {workload:w,cloud:c,capacity:k,local:l}=r;
    const cf=cloudMode==='actual'?`直接记录 ${money(c.usageDayCost)} / 使用日；容量仍由组织画像计算。`:`输入 ${fmt(w.inputM,1)}M（命中 ${fmt(c.hitM,1)}M）+ 输出 ${fmt(w.outputM,1)}M，峰谷系数 ${c.peakFactor.toFixed(2)}。`;
    const pf=pricingMode==='components'?`${k.cards} 卡 × ${s.cardPriceWan}万 + ${k.nodes} 台 × ${s.platformPriceWan}万，再加 ${Math.round(s.integrationPct*100)}% 集成。`:`${k.nodes} 台 × ${s.nodeQuoteWan} 万 / 台。`;
    const runtimeGB=k.weightsGB*s.runtimeReserve;
    const rawGroupCards=k.rawCardsPerReplica;
    const groupCount=k.replicas;
    const kvGroups=Number.isFinite(k.replicasKv)?k.replicasKv:'∞';
    const totalContextM=w.totalContextK/1000;
    const bottlenecks=[];
    if(k.replicasKv===groupCount)bottlenecks.push('KV Cache');
    if(k.replicasDecode===groupCount)bottlenecks.push('Decode');
    if(k.replicasPrefill===groupCount)bottlenecks.push('Prefill');
    if(groupCount===1)bottlenecks.push('完整权重');
    const bottleneck=bottlenecks.join(' / ')||'容量约束';
    const openIds=new Set([...document.querySelectorAll('#derivationList details[open]')].map(node=>node.dataset.traceId));
    if(!$('derivationList').dataset.ready)openIds.add('kv');
    const simple=(step,title,copy,value)=>`<div class="trace-simple"><span class="trace-index">${step}</span><div class="trace-copy"><strong>${title}</strong><p>${copy}</p></div><span class="trace-value">${value}</span></div>`;
    const accordion=(step,id,title,copy,value,tone,body)=>`<details class="trace-accordion tone-${tone}" data-trace-id="${id}" ${openIds.has(id)?'open':''}><summary><span class="trace-index">${step}</span><span class="trace-copy"><strong>${title}</strong><small>${copy}</small></span><span class="trace-value">${value}</span><span class="trace-toggle"><i class="when-closed">查看怎么算</i><i class="when-open">收起</i></span></summary><div class="trace-formula">${body}</div></details>`;
    const formulaStep=(label,formula,result,tone='memory',note='')=>`<div class="formula-step"><small>${label}</small><code>${formula}</code><strong class="formula-${tone}">${result}</strong>${note?`<span class="formula-note">${note}</span>`:''}</div>`;
    const weightBody=`<p class="trace-explainer">所有部署组均运行当前所选的同一个模型；每组内由 ${k.cardsPerReplica} 张卡共同承载一套完整权重，不是每张卡各装一份。</p><div class="formula-flow">${formulaStep('模型权重',`${fmt(s.model.totalParamsB,1)}B × ${s.weightBytes} Byte`,`${fmt(k.weightsGB,1)} GB`)}${formulaStep('运行时余量',`${fmt(k.weightsGB,1)} × ${Math.round(s.runtimeReserve*100)}%`,`${fmt(runtimeGB,1)} GB`)}${formulaStep('单卡可用显存',`${fmt(s.card.memoryGB,1)} × ${Math.round(s.memoryUtilization*100)}%`,`${fmt(k.usableCardGB,1)} GB`)}</div>`;
    const kvFormulaText=/^DSA/.test(s.model.attentionType)?`${s.model.layers}层 × 576 × ${s.kvBytes}byte × 0.1 稀疏压缩`:/^MLA/.test(s.model.attentionType)?`${s.model.layers}层 × 576 × ${s.kvBytes}byte 隐向量`:`2 × ${s.model.layers}层 × ${s.model.kvHeads}KV头 × ${s.model.headDim}维 × ${s.kvBytes}byte`;
    const roleParts=w.roles.filter(r=>r.concurrency>0);
    const concParts=roleParts.map(r=>`${r.name} ${fmt(r.users)}人×${Math.round(r.activePct)}%×${r.parallelTasks}`).join('；');
    const contextParts=roleParts.map(r=>`${r.concurrency.toFixed(r.concurrency%1?2:0)}路×${r.contextK.toFixed(2)}K`).join(' + ')||'0';
    const kvBody=`<p class="trace-explainer is-key">读法：模型像同时开着的聊天窗口——此刻接着 ${w.scenarioConcurrency} 路对话，每路的聊天记录都要全程驻留显存，否则接不上话。先算此刻窗口里的记录总字数（库存，不是全天用量），再乘每字占用，最后除以一组卡留给 KV 的显存。人数、活跃率、会话上下文均来自左侧使用画像的角色卡。</p><div class="formula-flow">${formulaStep('每个 Token 占用',kvFormulaText,`${k.perTokenKB.toFixed(2)} KB / Token`,'kv',`${s.model.attentionType} · ${s.kvPrecisionLabel}；前四项模型结构定死，只有精度字节随选择变`)}${formulaStep('高峰同时开着的对话',concParts,`≈ ${w.scenarioConcurrency} 路`,'kv','人数 × 高峰活跃率 × 每人并行任务；不是全员同时在线')}${formulaStep('此刻驻留的记录总字数',contextParts,`${fmt(totalContextM,2)}M Token`,'kv','路数 × 每路会话上下文；这是「此刻库存」，不是全天用量')}${formulaStep('所有并发会话共需 KV',`${k.perTokenKB.toFixed(2)}KB × ${fmt(totalContextM,2)}M Token`,`${fmt(k.totalKvGB,1)} GB`,'kv','总字数 × 每字占用；模型每回一个字都要重读全部历史，这就是 KV Cache')}${formulaStep('一组可留给 KV 的显存',`${k.cardsPerReplica}卡 × ${fmt(k.usableCardGB,1)} − 权重${fmt(k.weightsGB,1)} − 余量${fmt(runtimeGB,1)}`,`${fmt(k.kvBudgetPerReplica,1)} GB`,'kv','先扣除同一个模型的权重和运行时余量')}${formulaStep('KV 需要部署多少组',`⌈KV需求 ${fmt(k.totalKvGB,1)} ÷ 单组容量 ${fmt(k.kvBudgetPerReplica,1)}⌉`,`${kvGroups} 组`,'kv',`${fmt(k.totalKvGB,1)} / ${fmt(k.kvBudgetPerReplica,1)} 小于1时也要向上取整为1组`)}</div>`;
    const maxRole=w.roles.find(role=>role.contextK===w.maxContextK);
    const maxRoleName=maxRole?maxRole.name:'当前角色';
    const groupBody=`<p class="trace-explainer">先算装下一套完整模型至少需要几张卡，再按服务器支持的 1 / 2 / 4 / 8 卡拓扑取整。</p><div class="formula-flow compact-flow">${formulaStep('权重',`${fmt(s.model.totalParamsB,1)}B 参数 × ${s.weightBytes} byte`,`${fmt(k.weightsGB,1)} GB`,'memory','参数量 × 权重精度字节')}${formulaStep('运行时余量',`${fmt(k.weightsGB,1)} × ${Math.round(s.runtimeReserve*100)}%`,`${fmt(runtimeGB,1)} GB`,'memory','激活值、显存碎片、框架开销')}${formulaStep(`单路 KV · 按${maxRoleName} ${fmt(w.maxContextK,1)}K 最坏值`,`${k.perTokenKB.toFixed(2)} KB × ${fmt(w.maxContextK,1)}K ÷ 1024`,`${fmt(k.sessionKvGB,1)} GB`,'kv','取所有角色里最长的会话上下文，装不下则该路请求直接失败')}${formulaStep('显存原始卡数',`⌈(${fmt(k.weightsGB,1)} + ${fmt(runtimeGB,1)} + ${fmt(k.sessionKvGB,1)}) ÷ ${fmt(k.usableCardGB,1)}⌉`,`${rawGroupCards} 卡`)}${formulaStep('拓扑取整',`${rawGroupCards} → 1 / 2 / 4 / 8`,`每组 ${k.cardsPerReplica} 卡`)}</div>`;
    const decodeConcurrencyNeed=w.scenarioConcurrency*w.streamSpeed;
    const inputSum=w.roles.filter(r=>r.inputM>0).map(r=>Math.round(r.inputM)).join('+');
    const outputSum=w.roles.filter(r=>r.outputM>0).map(r=>Math.round(r.outputM)).join('+');
    const prefillBaseNeed=w.effectivePrefillM*1e6/w.activeSeconds;
    const ttftAvgInputK=w.scenarioConcurrency>0?w.ttftPrefillNeed*w.ttftBudget/w.scenarioConcurrency/1000:0;
    const precisionNote=k.precisionScale&&k.precisionScale!==1?` × 精度倍率${k.precisionScale.toFixed(2)}`:'';
    const th=k.theory||{};
    const thDecode=th.decodeSizing||{};
    const thSloMet=th.decodeSloMet!==false;
    const sloWarning=thSloMet?'':`<p class="trace-explainer is-warning">⚠ 单路速度目标 ${fmt(w.streamSpeed)} tok/s 达不到：本卡跑本模型的理论上限约 ${fmt(thDecode.maxPerStreamSpeed,1)} tok/s（权重读取本身就超过时间预算）。此时 Decode 不参与定规模，卡数由显存与 Prefill 决定；需换更大带宽的卡、加大 TP 分片或放宽速度目标。</p>`;
    const decodeTheorySteps=th.decodeByFormula?`${formulaStep('① 每步读取权重',`P_act ${fmt(th.activeParamsB,1)}B × ${s.weightBytes} byte`,`${fmt(th.weightsActiveGB,1)} GB`,'decode','激活参数 × 权重精度字节；MoE 只算激活部分')}${formulaStep('② 单卡有效带宽',`BW ${fmt(th.bandwidthGBs)} GB/s × β ${Math.round(th.bandwidthEff*100)}%`,`${fmt(th.bandwidthGBs*th.bandwidthEff)} GB/s`,'decode','β 为带宽效率系数，可在假设区调整')}${formulaStep('③ 单组每步读取',`（权重 ${fmt(th.weightsActiveGB,1)} + B ${fmt(th.streamsPerGroup,1)}路 × KV ${fmt(th.kvSeqGB,2)}）÷ ${k.cardsPerReplica}卡`,`${fmt(th.bytesPerStep,2)} GB`,'decode','一个 step 读一次权重 + B 路各自 KV；组内 TP 分片')}${formulaStep('④ 单步耗时 → 单组吞吐',`${fmt(th.bytesPerStep,2)} ÷ ${fmt(th.bandwidthGBs*th.bandwidthEff)} → ${fmt(th.streamsPerGroup,1)} token ÷ ${fmt(th.stepSeconds*1000,1)} ms`,`${fmt(k.replicaDecode)} tok/s`,'decode','B 路同时出字，batch 越大权重摊得越薄')}${formulaStep('⑤ 单组能承载几路',`B ≤ (${k.cardsPerReplica}卡 × ${fmt(th.bandwidthGBs*th.bandwidthEff)} ÷ ${fmt(w.streamSpeed)} − ${fmt(th.weightsActiveGB,1)}) ÷ ${fmt(th.kvSeqGB,2)}`,`${thSloMet?fmt(thDecode.streamsPerGroup,1)+' 路':'0 路（不达标）'}`,'decode',`保住每路 ${fmt(w.streamSpeed)} tok/s 的最大 batch；单路上限 ${fmt(thDecode.maxPerStreamSpeed,1)} tok/s`)}${formulaStep('⑥ Decode 所需组数',`⌈并发 ${w.scenarioConcurrency} ÷ 单组 ${thSloMet?fmt(thDecode.streamsPerGroup,1):'—'}⌉`,`${k.replicasDecode} 组`,'decode',thSloMet?'':'SLO 不可达，本项不参与定规模')}`:`${formulaStep('单卡能力（工程基线）',`${fmt(s.decodePerCard)} tok/s/卡 × ${k.cardsPerReplica}卡 × ${Math.round(k.efficiency*100)}%${precisionNote}`,`${fmt(k.replicaDecode)} tok/s`,'decode','该卡缺算力/带宽或模型缺激活参数，回退工程基线')}`;
    const prefillTheorySteps=th.prefillByFormula?`${formulaStep('① 每 Token 算力',`2 × P_act ${fmt(th.activeParamsB,1)}B`,`${fmt(th.flopsPerToken/1e9)} GFLOP`,'kv','每个参数一次乘加；MoE 只算激活部分')}${formulaStep('② 单卡有效算力',`F ${fmt(th.computeTFLOPS)} TFLOPS × μ ${Math.round(th.mfu*100)}%`,`${fmt(th.computeTFLOPS*th.mfu)} TFLOPS`,'kv','F 取该精度档位算力，μ 为算力利用率')}${formulaStep('③ 单卡 Prefill 吞吐',`${fmt(th.computeTFLOPS)}e12 × ${th.mfu} ÷ ${fmt(th.flopsPerToken/1e9)}e9`,`${fmt(th.prefillPerCard)} tok/s`,'kv','算力瓶颈，与 batch 无关')}${formulaStep('④ 单组能力',`${fmt(th.prefillPerCard)} × ${k.cardsPerReplica}卡 × ${Math.round(k.efficiency*100)}%`,`${fmt(k.replicaPrefill)} tok/s`,'kv','TP 并行效率折损')}${formulaStep('⑤ Prefill 所需组数',`⌈需求 ${fmt(w.prefillNeed)} ÷ 单组 ${fmt(k.replicaPrefill)}⌉`,`${k.replicasPrefill} 组`,'kv',`取${w.prefillNeedSource}口径`)}`:`${formulaStep('单卡能力（工程基线）',`${fmt(s.prefillPerCard)} tok/s/卡 × ${k.cardsPerReplica}卡 × ${Math.round(k.efficiency*100)}%${precisionNote}`,`${fmt(k.replicaPrefill)} tok/s`,'kv','回退工程基线')}`;
    const throughputBody=`${sloWarning}<p class="trace-explainer is-key">读法：需求来自人数、并发和 Token 业务量；「单卡能力」由公式推导——Prefill 用算力、Decode 用带宽，参数全部取自所选模型与所选卡。</p><div class="throughput-grid"><section><h4>Decode 持续生成 <small>带宽瓶颈 · 决定出字多快</small></h4><div class="formula-flow throughput-flow">${formulaStep('① 日用量换算成每秒压力',`${fmt(w.outputM,1)}M Token ÷ ${fmt(w.activeSeconds)}秒`,`${fmt(w.volumeDecodeNeed)} tok/s`,'decode',`日输出 = Σ 人数×每日请求×输出K = ${outputSum} M；${fmt(w.activeSeconds)}秒 = ${w.activeHours}小时 × 3,600`)}${formulaStep('② 峰值并发压力',`${w.scenarioConcurrency}路 × ${fmt(w.streamSpeed)} tok/s/路`,`${fmt(decodeConcurrencyNeed)} tok/s`,'decode','同时生成的路数 × 每路目标输出速度')}${formulaStep('③ 规划 Decode 需求',`MAX(${fmt(w.volumeDecodeNeed)}, ${fmt(decodeConcurrencyNeed)}) × ${w.capacityBuffer.toFixed(1)}`,`${fmt(w.decodeNeed)} tok/s`,'decode','日均压力和峰值压力取较大者，再留容量余量')}${decodeTheorySteps}</div></section><section><h4>Prefill 输入处理 <small>决定模型读完输入、开始首 Token 前的计算压力</small></h4><div class="formula-flow throughput-flow">${formulaStep('① 前缀复用后的有效输入',`${fmt(w.inputM,1)}M × (1 − ${Math.round(w.weightedReuse*100)}%)`,`${fmt(w.effectivePrefillM,1)}M Token / 日`,'kv',`日输入 = Σ 人数×每日请求×输入K = ${inputSum} M；重复前缀命中后无需再次完整计算`)}${formulaStep('② 日输入量换算成每秒压力',`${fmt(w.effectivePrefillM,1)}M ÷ ${fmt(w.activeSeconds)}秒`,`${fmt(prefillBaseNeed)} tok/s`,'kv',`${fmt(w.activeSeconds)}秒 = ${w.activeHours}小时 × 3,600`)}${formulaStep('③ 峰值 TTFT 需求',`${w.scenarioConcurrency}路 × ${Math.round(w.ttftBurstShare*100)}%同时 × ≈${fmt(ttftAvgInputK/Math.max(w.ttftBurstShare,0.01),1)}K有效输入 ÷ ${fmt(w.ttftBudget,1)}秒`,`${fmt(w.ttftPrefillNeed)} tok/s`,'kv',`首字目标 ${fmt(w.ttftSlo)}秒 − 调度通信 ${fmt(w.ttftOverhead,1)}秒；有效输入已扣前缀复用`)}${formulaStep('④ 规划 Prefill 需求',`MAX(${fmt(prefillBaseNeed)}, ${fmt(w.ttftPrefillNeed)}) × ${w.capacityBuffer.toFixed(1)}`,`${fmt(w.prefillNeed)} tok/s`,'kv',`取${w.prefillNeedSource}口径，再留容量余量`)}${prefillTheorySteps}</div></section></div>`;
    $('derivationList').innerHTML=
      simple('01','同一工作负载',`${w.sourceLabel}：日输入 ${fmt(w.inputM,1)}M（Σ 人数×每日请求×输入K）、日输出 ${fmt(w.outputM,1)}M（Σ 人数×每日请求×输出K）；规划并发 ${w.scenarioConcurrency} 路。`,'12 小时 / 使用日')+
      simple('02','云端使用日成本',cf,money(c.usageDayCost))+
      accordion('03','weight','模型权重与部署底座',`当前模型 ${s.model.name}；先核算权重、运行时余量和单卡可用显存。`,`${fmt(k.weightsGB)} GB 权重`,'memory',weightBody)+
      accordion('04','kv','KV Cache 容量',`高峰 ${w.scenarioConcurrency} 路对话的聊天记录此刻驻留显存，决定 KV 总量与部署组数。`,`${kvGroups} 个同模型部署组`,'kv',kvBody)+
      accordion('05','group','单组模型部署',`${k.cardsPerReplica} 张卡共同部署一套完整的 ${s.model.name}。`,`${k.cardsPerReplica} 卡 / 组`,'memory',groupBody)+
      accordion('06','throughput','Prefill 与 Decode 容量',`分别核算首 Token 前的输入处理能力和持续生成能力。`,`D ${k.replicasDecode} / P ${k.replicasPrefill} 组`,'throughput',throughputBody)+
      `<div class="trace-conclusion"><span class="trace-index">07</span><div class="trace-copy"><strong>容量结论</strong><p>MAX（权重 1，KV ${kvGroups}，Decode ${k.replicasDecode}，Prefill ${k.replicasPrefill}）× ${k.cardsPerReplica} 卡/组 = ${k.cards} 卡；${groupCount} 组均部署当前所选的同一个模型。</p></div><span class="trace-value conclusion-value">${k.cards} 卡 / ${k.nodes} 台<small>瓶颈：${bottleneck} · ${groupCount} 组</small></span></div>`+
      simple('08','一次性投入',`${pf} 维保仅按硬件价计提，不含一次性软件费。`,money(l.capex))+
      simple('09','年运行成本',`12h 活跃 + 12h 空闲；非使用日按 ${Math.round(l.idleRatio*100)}% 空闲功耗。含电费、维保、订阅和运维人力。`,money(l.annualOpex))+
      simple('10','临界点',r.breakevenDays?'CapEx ÷（云端年化日均 − 本地 OpEx 日均）。':'云端年化日均没有高于本地日运行成本，分母非正。',r.breakevenDays?`第 ${fmt(Math.ceil(r.breakevenDays))} 天`:'不存在');
    $('derivationList').dataset.ready='true';
  }

  function renderChart(r){
    const svg=$('costChart'),ns='http://www.w3.org/2000/svg',make=(tag,a={},text='')=>{const n=document.createElementNS(ns,tag);Object.entries(a).forEach(([k,v])=>n.setAttribute(k,v));if(text)n.textContent=text;return n;};
    svg.innerHTML='';const W=860,H=360,L=66,R=22,T=20,B=42,days=1095,cloudEnd=r.cloud.averageDayCost*days,localEnd=r.local.capex+r.local.averageDayOpex*days,maxY=Math.max(cloudEnd,localEnd,1)*1.12;
    const X=d=>L+d/days*(W-L-R),Y=v=>T+(H-T-B)*(1-v/maxY);
    for(let i=0;i<=4;i++){const v=maxY*i/4,y=Y(v);svg.appendChild(make('line',{x1:L,y1:y,x2:W-R,y2:y,stroke:'rgba(64,103,91,.10)'}));svg.appendChild(make('text',{x:L-9,y:y+4,'text-anchor':'end',fill:'#71867f','font-size':10},`${fmt(v/10000)}万`));}
    [0,1,2,3].forEach(year=>{const x=X(year*365);svg.appendChild(make('line',{x1:x,y1:T,x2:x,y2:H-B,stroke:'rgba(64,103,91,.07)'}));svg.appendChild(make('text',{x,y:H-14,'text-anchor':year===0?'start':year===3?'end':'middle',fill:'#71867f','font-size':10},year===0?'现在':`第 ${year} 年`));});
    svg.appendChild(make('path',{d:`M ${X(0)} ${Y(0)} L ${X(days)} ${Y(cloudEnd)}`,fill:'none',stroke:'#78a9b2','stroke-width':3,'stroke-linecap':'round'}));
    svg.appendChild(make('path',{d:`M ${X(0)} ${Y(r.local.capex)} L ${X(days)} ${Y(localEnd)}`,fill:'none',stroke:'#4e8f72','stroke-width':3,'stroke-linecap':'round'}));
    if(r.breakevenDays&&r.breakevenDays<=days){const x=X(r.breakevenDays),y=Y(r.cloud.averageDayCost*r.breakevenDays),anchor=x>W*.7?'end':'start';svg.appendChild(make('line',{x1:x,y1:T,x2:x,y2:H-B,stroke:'#3e826f','stroke-dasharray':'5 5'}));svg.appendChild(make('circle',{cx:x,cy:y,r:6,fill:'#f8faf5',stroke:'#3e826f','stroke-width':2}));svg.appendChild(make('text',{x:x+(anchor==='end'?-10:10),y:y-12,'text-anchor':anchor,fill:'#173b34','font-size':11,'font-weight':600},`第 ${fmt(Math.ceil(r.breakevenDays))} 天`));}
    $('chartFoot').textContent=`三年累计：云端 ${money(r.cloudTco3)} · 本地 ${money(r.localTco3)}。曲线使用同一计算引擎。`;
  }

  function renderCardTable(query=''){
    const q=query.trim().toLowerCase(),cards=Object.values(D.cards).filter(c=>`${c.vendor} ${c.name} ${c.family}`.toLowerCase().includes(q));
    $('cardTableBody').innerHTML=cards.length?cards.map(c=>{
      const compute=Object.entries(c.compute).map(([k,v])=>`<span class="subline">${k.toUpperCase()} · ${v}</span>`).join('');
      return `<tr><td class="name-cell"><strong>${c.name}</strong><small>${c.vendor} · ${c.positioning}</small><span class="subline">${c.note}</span></td><td>${c.memoryGB}GB ${c.memoryType}<span class="subline">${c.bandwidthGBs?fmt(c.bandwidthGBs,1)+' GB/s':'带宽待确认'}</span></td><td><div class="precision-list">${c.precisions.map(p=>`<span>${p}</span>`).join('')}</div></td><td>${compute}</td><td>${fmt(c.tdpW)}W</td><td>${c.interconnect}<span class="subline">${c.formFactor}</span></td><td><span class="grade ${gradeClass(c.confidence)}">${c.confidence}</span><span class="subline">${c.source}</span></td></tr>`;
    }).join(''):'<tr><td colspan="7" class="empty-row">没有匹配的算力卡</td></tr>';
  }

  function renderModelTable(query=''){
    const q=query.trim().toLowerCase(),models=Object.values(D.models).filter(m=>`${m.vendor} ${m.name}`.toLowerCase().includes(q));
    $('modelTableBody').innerHTML=models.length?models.map(m=>`<tr><td class="name-cell"><strong>${m.name}</strong><small>${m.vendor} · ${m.license}</small><span class="subline">${m.note}</span></td><td>${m.releaseDate}</td><td>总 ${fmt(m.totalParamsB,1)}B<span class="subline">激活 ${m.activeParamsB==null?'待确认':fmt(m.activeParamsB,1)+'B'}</span></td><td>${m.layers} 层 · ${m.architecture}<span class="subline">${m.attentionType}</span></td><td>${m.contextK?fmt(m.contextK)+'K':'待确认'}</td><td><div class="precision-list">${m.supportedPrecisions.map(p=>`<span>${p}</span>`).join('')}</div><span class="subline">建议：${m.recommendedPrecisions.join(' / ')}</span></td><td>${m.openWeights}</td><td><span class="grade ${gradeClass(m.confidence)}">${m.confidence}</span><span class="subline">${m.source}</span></td></tr>`).join(''):'<tr><td colspan="8" class="empty-row">没有匹配的模型</td></tr>';
  }
  function renderDataTables(cq='',mq=''){
    renderCardTable(cq);renderModelTable(mq);
    $('apiTableBody').innerHTML=Object.values(D.apiPrices).map(p=>`<tr><td class="name-cell"><strong>${p.name}</strong>${p.effectiveAt?`<span class="subline">生效：${p.effectiveAt}</span>`:''}</td><td>${fmtPrice(p.hit)}</td><td>${fmtPrice(p.miss)}</td><td>${fmtPrice(p.out)}</td><td>${p.peakPricing?'谷时基价 · 峰时 × 2':'否'}</td><td><span class="grade ${gradeClass(p.confidence)}">${p.confidence}</span><span class="subline">${p.source}${p.updatedAt?` · 核验 ${p.updatedAt}`:''}</span></td></tr>`).join('');
    $('cardCount').textContent=Object.keys(D.cards).length;$('modelCount').textContent=Object.keys(D.models).length;
  }

  function lineageValue(input){
    if(input.id==='cloudMode')return cloudMode==='continuous'?'12 小时持续使用':'实际日账单';
    if(input.id==='pricingMode')return pricingMode==='nodeQuote'?'按单台报价':'按卡与平台件';
    const el=$(input.id);if(!el)return '—';
    const value=el.tagName==='SELECT'?(el.options[el.selectedIndex]?.textContent||el.value):el.value;
    return `${value}${input.unit?` ${input.unit}`:''}`;
  }
  function findLineageInput(id){for(const group of Lineage.groups){const found=group.inputs.find(x=>x.id===id);if(found)return found;}return null;}
  function renderLineage(){
    if(!Lineage||!$('lineageInputs'))return;
    const total=Lineage.groups.reduce((sum,g)=>sum+g.inputs.length,0);
    $('lineageInputCount').textContent=total;$('lineageStageCount').textContent=Lineage.stages.length;
    $('lineageInputs').innerHTML=Lineage.groups.map(group=>`<section class="lineage-group"><h3>${group.label}</h3><div class="lineage-variable-grid">${group.inputs.map(input=>`<button class="lineage-variable ${selectedLineageInput===input.id?'is-selected':''}" type="button" data-lineage-input="${input.id}"><span>${input.label}</span><strong>${lineageValue(input)}</strong></button>`).join('')}</div></section>`).join('');
    const selected=findLineageInput(selectedLineageInput),affected=new Set(selected?.affects||[]),lanes=[];
    Lineage.stages.forEach(stage=>{let lane=lanes.find(x=>x.name===stage.lane);if(!lane){lane={name:stage.lane,stages:[]};lanes.push(lane);}lane.stages.push(stage);});
    $('lineageStages').classList.toggle('show-all',!selected);
    $('lineageStages').innerHTML=lanes.map(lane=>`<section class="lineage-lane"><h3>${lane.name}</h3><div class="lineage-stage-list">${lane.stages.map(stage=>`<article class="lineage-stage ${affected.has(stage.id)?'is-affected':''}" data-lineage-stage="${stage.id}"><strong>${stage.label}</strong><small>${stage.formula}</small></article>`).join('')}</div></section>`).join('');
    $('lineageDetail').innerHTML=selected?`<h3>${selected.label} <span class="section-chip">当前 ${lineageValue(selected)}</span></h3><p>${selected.impact}</p><code>${selected.formula}</code>`:`<h3>全链路总览</h3><p>左侧包含页面中全部可填写数字与选择项。点任意变量后，只保留它真实影响的下游节点高亮。</p><code>工作负载 → 云端成本 / 本地容量 → 本地成本 → 临界点与三年 TCO</code>`;
    document.querySelectorAll('[data-lineage-input]').forEach(button=>button.onclick=()=>{selectedLineageInput=button.dataset.lineageInput;renderLineage();});
  }

  function pickDeployment(prefs){
    const needCtx=prefs.contextK||0;
    let cands=Object.values(D.models).filter(m=>!needCtx||(m.contextK||0)>=needCtx);
    if(!cands.length)cands=Object.values(D.models);
    const domesticList=['Huawei','Alibaba Cloud','DeepSeek','Z.ai','Hygon'];
    const pool=prefs.domestic?cands.filter(m=>domesticList.includes(m.vendor)):cands;
    const base=pool.length?pool:cands;
    let sel=base;
    if(prefs.task==='code'){const c=base.filter(m=>/coder|DeepSeek|GLM|Qwen|Kimi/i.test(m.name));if(c.length)sel=c;}
    else if(prefs.task==='knowledge'){const c=base.filter(m=>(m.activeParamsB||m.totalParamsB)<=50);if(c.length)sel=c;}
    sel=sel.slice().sort((a,b)=>(a.activeParamsB||a.totalParamsB||0)-(b.activeParamsB||b.totalParamsB||0));
    const model=sel[0]||Object.values(D.models)[0];
    return {modelId:model.id,cardId:prefs.domestic?'a910c':'h20'};
  }
  const advisorProfiles={
    '代码与 Agent':{role:'code',users:100,concurrencyRatio:.2,contextK:128,inputTokens:152000,outputTokens:4560},
    '知识库 / 办公问答':{role:'office',users:100,concurrencyRatio:.1,contextK:128,inputTokens:22400,outputTokens:1120},
    '通用推理':{role:'office',users:100,concurrencyRatio:.12,contextK:128,inputTokens:32000,outputTokens:1500}
  };
  const sourceText={customer:'客户提供',assumption:'系统假设',derived:'系统推导',benchmark:'待压测'};
  function detectTask(text){
    if(/研发|代码|编程|coder|agent|智能体/i.test(text))return '代码与 Agent';
    if(/知识库|客服|问答|办公/.test(text))return '知识库 / 办公问答';
    return '通用推理';
  }
  function detectCardId(text){
    if(/910\s*c|昇腾\s*910c/i.test(text))return 'a910c';
    if(/海光|k100/i.test(text))return 'k100';
    if(/h200/i.test(text))return 'h200';
    if(/h20/i.test(text))return 'h20';
    if(/b300/i.test(text))return 'b300';
    return null;
  }
  function detectReverseIntent(text){return /(?:我有|已有|现有|给定|手上有).{0,24}(?:台|张|卡|设备)|(?:\d+\s*台|\d+\s*张).{0,24}(?:能(?:部|布)署|能跑|吞吐|并发)|(?:910\s*c|h20|h200|b300|k100|昇腾卡|英伟达卡).{0,20}(?:能(?:部|布)署|能跑)|按设备看能力|反向测算/i.test(text);}
  function routeReverseFromAdvisor(text){
    const cardId=detectCardId(text),devices=text.match(/(\d+)\s*台/),cards=text.match(/每台\s*(\d+)\s*(?:张|卡)|(?:单台|一台)\s*(\d+)\s*(?:张|卡)/),ctx=text.match(/(?:上下文|context)[^\d]*(\d+(?:\.\d+)?)\s*(m|k)?/i),input=text.match(/(?:输入|prefill)[^\d]*(\d+(?:\.\d+)?)\s*(m|k)?/i),output=text.match(/(?:输出|decode)[^\d]*(\d+(?:\.\d+)?)\s*(m|k)?/i),speed=text.match(/(?:单路|速度)[^\d]*(\d+(?:\.\d+)?)\s*(?:tok\/s|token)/i);
    if(cardId)$('reverseCardSelect').value=cardId;
    if(devices)$('reverseDeviceCount').value=devices[1];
    if(cards){const n=Number(cards[1]||cards[2]);$('reverseCardsPerDevice').value=[1,2,4,8].includes(n)?String(n):'8';}
    const toK=match=>{if(!match)return null;return Number(match[1])*((match[2]||'k').toLowerCase()==='m'?1000:1);};
    if(ctx)$('reverseMaxContextK').value=toK(ctx);if(input)$('reverseInputK').value=toK(input);if(output)$('reverseOutputK').value=toK(output);if(speed)$('reverseTargetSpeed').value=Number(speed[1]);
    updateReversePrecisionOptions();showPage('calculator');setCalculatorMode('reverse');showToast('已识别为“按设备看能力”，未说明条件已作为可见假设展示');
  }
  function tokenValue(match){
    if(!match)return null;
    const value=Number(match[1]),unit=(match[2]||'').toLowerCase();
    return Math.round(value*(unit==='m'?1e6:unit==='k'?1e3:unit==='万'?1e4:1));
  }
  function detectProvidedFields(text){
    const fields=new Set();
    if(/\d+\s*(?:名|人)(?!\s*(?:并发|同时))/.test(text))fields.add('users');
    if(/(?:峰值)?\s*\d+\s*(?:人|路)?\s*并发|并发\s*\d+/i.test(text))fields.add('concurrency');
    if(/每天|每日|小时\s*\/\s*天/.test(text))fields.add('activeHours');
    if(/上下文|context/i.test(text))fields.add('contextK');
    if(/(?:输入|prefill)[^\d]*\d/i.test(text))fields.add('inputTokens');
    if(/(?:输出|decode)[^\d]*\d/i.test(text))fields.add('outputTokens');
    if(/预算/.test(text))fields.add('budgetWan');
    if(/国产|信创|华为|昇腾|910\s*c|海光|沐曦|英伟达|nvidia|h20|h200|b300/i.test(text))fields.add('domestic');
    if(/不能出域|不出域|敏感|涉密|私有|允许出域|可以上云|云端/i.test(text))fields.add('sensitive');
    if(/研发|代码|编程|coder|agent|智能体|知识库|客服|问答|办公/i.test(text))fields.add('task');
    return fields;
  }
  function advisorPrecision(draft){
    const card=D.cards[draft.cardId],model=D.models[draft.modelId];
    const canInt8=precisionSupport(card).has('int8')&&precisionSupport(model).has('int8');
    if(card.id==='a910c'&&canInt8)return {id:'int8',label:'W8A8（INT8）',basis:'910C 不提供 FP8；当前模型目录标注支持 INT8，优先采用 W8A8。'};
    if(card.id==='a910c')return {id:'fp16',label:'BF16',basis:`910C 不提供 FP8；${model.name} 未标注 W8A8 适配，暂时回退 BF16。`};
    const id=precisionSupport(card).has('fp8')&&precisionSupport(model).has('fp8')?'fp8':'fp16';
    return {id,label:id==='fp8'?'FP8':'BF16',basis:'根据当前模型与算力卡共同支持范围推导，吞吐仍需按目标组合压测。'};
  }
  function completeAdvisorDraft(base,provided=new Set(),previous=null){
    const task=base.task||previous?.task||'通用推理',profile=advisorProfiles[task]||advisorProfiles['通用推理'];
    const sources={...(previous?.sources||{})},basis={...(previous?.basis||{})};
    const mark=(field,hasValue,assumptionBasis,derived=false)=>{
      if(provided.has(field)){sources[field]='customer';basis[field]='来自客户本轮或此前明确描述。';return;}
      if(sources[field]==='customer')return;
      sources[field]=derived?'derived':'assumption';basis[field]=assumptionBasis;
    };
    const users=base.users??previous?.users??base.concurrency??previous?.concurrency??profile.users;
    const concurrency=base.concurrency??previous?.concurrency??Math.max(1,Math.round(users*profile.concurrencyRatio));
    const contextK=base.contextK??previous?.contextK??profile.contextK;
    const assumedInputTokens=Math.min(profile.inputTokens,Math.max(1000,contextK*500));
    const draft={
      text:base.text||previous?.text||'',task,users,concurrency,
      activeHours:base.activeHours??previous?.activeHours??12,
      contextK,
      inputTokens:base.inputTokens??previous?.inputTokens??assumedInputTokens,
      outputTokens:base.outputTokens??previous?.outputTokens??profile.outputTokens,
      budgetWan:base.budgetWan??previous?.budgetWan??null,
      domestic:base.domestic??previous?.domestic??false,
      sensitive:base.sensitive??previous?.sensitive??false,
      source:base.source||previous?.source||'local',sources,basis
    };
    mark('task',base.task!=null,'未说明具体任务，暂按通用推理画像。');
    mark('users',base.users!=null,base.concurrency!=null?'未提供开放用户，暂按峰值并发人数作为用户下限。':'采用当前工作负载模板的开放用户数。');
    mark('concurrency',base.concurrency!=null,`未提供直接并发，按开放用户和${Math.round(profile.concurrencyRatio*100)}%场景比例推导。`,base.users!=null);
    mark('activeHours',base.activeHours!=null,'未说明每天使用时长，暂按每天 12 小时。');
    mark('contextK',base.contextK!=null,'未说明最大上下文，暂按 128K 能力要求。');
    mark('inputTokens',base.inputTokens!=null,`未说明典型输入，采用${task}模板值，并限制在最大上下文的 50% 以内。`);
    mark('outputTokens',base.outputTokens!=null,`未说明典型输出，采用${task}模板值。`);
    mark('budgetWan',base.budgetWan!=null,'预算未提供，不作为当前方案的硬性筛选条件。');
    mark('domestic',base.domestic!=null,'未说明国产化要求，暂按硬件品牌不限。');
    mark('sensitive',base.sensitive!=null,'未说明数据出域要求，暂按允许比较云端方案。');
    const pick=pickDeployment({domestic:draft.domestic,contextK:draft.contextK,task:task==='代码与 Agent'?'code':task==='知识库 / 办公问答'?'knowledge':'general'});
    draft.modelId=base.modelId||previous?.modelId||pick.modelId;draft.cardId=base.cardId||previous?.cardId||pick.cardId;
    draft.precision=advisorPrecision(draft);draft.sources.precision='benchmark';draft.basis.precision=draft.precision.basis;
    return draft;
  }
  function parseAdvisorScenario(text,previous=null){
    const provided=detectProvidedFields(text);
    const um=text.match(/(\d+)\s*(?:名|人)(?!\s*(?:并发|同时))/),cm=text.match(/(?:峰值)?\s*(\d+)\s*(?:人|路)?\s*并发|并发\s*(\d+)/i),bm=text.match(/预算[^\d]*(\d+(?:\.\d+)?)\s*万/);
    const hm=text.match(/(?:每天|每日)[^\d]*(\d+(?:\.\d+)?)\s*小时|(?:每天|每日)\s*(\d+(?:\.\d+)?)\s*h/i);
    const context=text.match(/(?:上下文|context)[^\d]*(\d+(?:\.\d+)?)\s*(m|k)?/i)||text.match(/(\d+(?:\.\d+)?)\s*(m|k)\s*(?:上下文|context)/i);
    const input=text.match(/(?:输入|prefill)[^\d]*(\d+(?:\.\d+)?)\s*(m|k|万)?/i),output=text.match(/(?:输出|decode)[^\d]*(\d+(?:\.\d+)?)\s*(m|k|万)?/i);
    const task=provided.has('task')?detectTask(text):null;
    let domestic=null;if(/国产|信创|华为|昇腾|910\s*c|海光|沐曦/i.test(text))domestic=true;else if(/不限国产|硬件不限|英伟达|nvidia|h20|h200|b300/i.test(text))domestic=false;
    let sensitive=null;if(/不能出域|不出域|敏感|涉密|私有/.test(text))sensitive=true;else if(/允许出域|可以上云|允许云端|云端API/i.test(text))sensitive=false;
    let contextK=null;if(context){const unit=(context[2]||'k').toLowerCase();contextK=Number(context[1])*(unit==='m'?1000:1);}
    const base={text,users:um?Number(um[1]):null,concurrency:cm?Number(cm[1]||cm[2]):null,budgetWan:bm?Number(bm[1]):null,activeHours:hm?Number(hm[1]||hm[2]):null,contextK,inputTokens:tokenValue(input),outputTokens:tokenValue(output),task,domestic,sensitive,cardId:detectCardId(text),source:'local'};
    return completeAdvisorDraft(base,provided,previous);
  }
  function draftFromCloud(text,ext,previous=null){
    const provided=new Set([...(ext.provided_fields||[]),...detectProvidedFields(text)]),wt=ext.workload_type||[];
    const task=wt.includes('coding')||wt.includes('agent')?'代码与 Agent':wt.includes('office')||wt.includes('product')?'知识库 / 办公问答':null;
    const base={text,users:ext.users??null,concurrency:ext.peak_concurrency??null,budgetWan:ext.budget_wan??null,activeHours:ext.active_hours??null,contextK:ext.context_k??null,inputTokens:ext.input_tokens??null,outputTokens:ext.output_tokens??null,task,domestic:ext.domestic_preference??null,sensitive:ext.data_residency==null?null:ext.data_residency==='on_prem_only',cardId:detectCardId(text),source:'cloud'};
    return completeAdvisorDraft(base,provided,previous);
  }
  function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
  function typeInto(el,text,speed=16){
    return new Promise(res=>{let i=0;el.textContent='';const t=setInterval(()=>{i++;el.textContent=text.slice(0,i);if(i>=text.length){clearInterval(t);res();}},speed);});
  }
  function conditionRow(field,label,value,unit='',options=null){
    const source=advisorDraft.sources[field]||'assumption',basis=advisorDraft.basis[field]||'',display=value==null?'':value;
    const control=options
      ?`<select data-advisor-field="${field}">${options.map(([v,t])=>`<option value="${v}" ${String(value)===String(v)?'selected':''}>${t}</option>`).join('')}</select>`
      :field==='precision'
        ?`<strong class="condition-readonly">${escapeHtml(value)}</strong>`
        :`<div class="condition-input"><input data-advisor-field="${field}" type="number" min="0" value="${display}" ${field==='budgetWan'?'placeholder="未设上限"':''}><span>${unit}</span></div>`;
    return `<article class="condition-row source-${source}"><div class="condition-copy"><span>${label}</span><small>${escapeHtml(basis)}</small></div><div class="condition-value">${control}<em>${sourceText[source]}</em></div></article>`;
  }
  function renderAdvisorConditions(){
    const d=advisorDraft;
    $('advisorConditionList').innerHTML=[
      conditionRow('users','开放用户',d.users,'人'),
      conditionRow('concurrency','峰值并发',d.concurrency,'路'),
      conditionRow('activeHours','每日使用时长',d.activeHours,'小时'),
      conditionRow('contextK','模型最大上下文',d.contextK,'K'),
      conditionRow('inputTokens','典型 Prefill 输入',d.inputTokens,'Token'),
      conditionRow('outputTokens','典型 Decode 输出',d.outputTokens,'Token'),
      conditionRow('task','工作负载',d.task,'',Object.keys(advisorProfiles).map(x=>[x,x])),
      conditionRow('budgetWan','预算上限',d.budgetWan,'万元'),
      conditionRow('domestic','国产化要求',String(d.domestic),'',[[true,'国产化优先'],[false,'硬件品牌不限']]),
      conditionRow('sensitive','数据出域',String(d.sensitive),'',[[true,'数据不能出域'],[false,'允许比较云端方案']]),
      conditionRow('precision','计算精度',d.precision.label)
    ].join('');
    const assumptionCount=Object.values(d.sources).filter(x=>x==='assumption'||x==='derived').length;
    $('advisorAssumptionCount').textContent=`${assumptionCount} 项假设 / 推导`;
  }
  function updateAdvisorCondition(target){
    if(!advisorDraft||!target.dataset.advisorField)return;
    const field=target.dataset.advisorField;
    let value=target.value;
    if(['users','concurrency','activeHours','contextK','inputTokens','outputTokens','budgetWan'].includes(field))value=value===''?null:Number(value);
    if(['domestic','sensitive'].includes(field))value=value==='true';
    advisorDraft[field]=value;advisorDraft.sources[field]='customer';advisorDraft.basis[field]='客户在确认区中修改。';
    if(['task','domestic','contextK'].includes(field)){
      const pick=pickDeployment({domestic:advisorDraft.domestic,contextK:advisorDraft.contextK,task:advisorDraft.task==='代码与 Agent'?'code':advisorDraft.task==='知识库 / 办公问答'?'knowledge':'general'});
      advisorDraft.modelId=pick.modelId;advisorDraft.cardId=pick.cardId;
    }
    advisorDraft.precision=advisorPrecision(advisorDraft);advisorDraft.basis.precision=advisorDraft.precision.basis;
    renderAdvisorDraft(advisorDraft.source==='cloud',null,[]);
  }
  function renderAdvisorDraft(cloud,ext,missing){
    const pills=[`${advisorDraft.users} 人`,`${advisorDraft.concurrency} 路峰值并发`,`${advisorDraft.activeHours} 小时 / 天`,advisorDraft.task,advisorDraft.sensitive?'数据不出域':'允许云端 API',advisorDraft.domestic?'国产化优先':'硬件不限',advisorDraft.budgetWan?`预算 ${advisorDraft.budgetWan} 万`:'预算未设上限'];
    if(advisorDraft.contextK!=null)pills.push(`上下文 ${advisorDraft.contextK}k`);
    if(advisorDraft.inputTokens!=null||advisorDraft.outputTokens!=null)pills.push(`输入 ${advisorDraft.inputTokens||'?'} / 输出 ${advisorDraft.outputTokens||'?'} tok`);
    $('scenarioPills').innerHTML=pills.map(x=>`<span>${x}</span>`).join('');
    renderAdvisorConditions();
    let questions=(cloud&&missing&&missing.length)?missing.slice(0,3):[];
    if(!questions.length&&advisorTurnCount===1){
      if(advisorDraft.sources.inputTokens==='assumption')questions.push('典型请求大约输入多少 Token？');
      if(advisorDraft.sources.outputTokens==='assumption')questions.push('每次回答通常生成多少 Token？');
      if(advisorDraft.sources.task==='assumption')questions.push('主要用于代码、办公问答还是多模态任务？');
    }
    if(advisorTurnCount>=2)questions=[];
    $('advisorMissingTitle').textContent=questions.length?'可补充的关键信息':'剩余内容已采用可见假设';
    $('advisorMissing').textContent=questions.length?`${questions.join('；')} 也可以直接采用下方橙色假设。`:'系统不再继续追问。所有未说明条件已经列出，可直接修改后测算。';
    const m=D.models[advisorDraft.modelId],c=D.cards[advisorDraft.cardId];
    $('advisorPlanA').textContent=`${m.name} + ${c.name}`;$('advisorPlanADetail').textContent=`按 ${advisorDraft.concurrency} 路并发、${advisorDraft.contextK}K 最大上下文和 ${advisorDraft.precision.label} 写入测算。${advisorDraft.precision.basis}`;
    $('advisorPlanB').textContent='小模型本地 + 高难任务 API';$('advisorPlanBDetail').textContent=advisorDraft.sensitive?'敏感数据留在本地，仅允许脱敏后的高难任务进入专有云；需要额外的数据分级规则。':'日常请求由本地 gpt-oss-20b 承接，高难或峰值请求切到 API，降低一次性投入。';
    $('advisorCitations').textContent=`${m.name}（模型可信度 ${m.confidence}）、${c.name}（卡可信度 ${c.confidence}）及当前工程吞吐档案（可信度 C）。`;
    $('advisorDraftStatus').textContent=`待确认 · ${Math.min(advisorTurnCount,2)}/2 轮`;$('advisorEmpty').hidden=true;$('advisorDraft').hidden=false;$('advisorReset').textContent='重新描述';$('advisorApply').textContent='按以上条件开始测算';
  }
  async function previewAdvisor(){
    const text=$('advisorInput').value.trim();if(!text){$('advisorInput').focus();return;}
    if(detectReverseIntent(text)){routeReverseFromAdvisor(text);return;}
    const list=$('advisorMessages');
    list.insertAdjacentHTML('beforeend',`<article class="message client-message"><div class="msg-avatar client-avatar">客</div><div class="msg-body"><div class="message-role">客户场景</div><p>${escapeHtml(text)}</p></div></article>`);
    const id='amsg'+Date.now();
    list.insertAdjacentHTML('beforeend',`<article class="message assistant-message" id="${id}"><div class="msg-avatar assistant-avatar">✦</div><div class="msg-body"><div class="message-role">部署顾问</div><p class="typing"><span class="typing-dots"><i></i><i></i><i></i></span></p></div></article>`);
    list.scrollTop=list.scrollHeight;
    const sendBtn=$('advisorSend');if(sendBtn)sendBtn.classList.add('loading');advisorTurnCount+=1;
    let cloud=true,ext=null,missing=[],assistantMessage='';
    try{
      const res=await fetch('/api/advisor/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({scenario_text:text, messages:advisorHistory})});
      if(!res.ok)throw new Error('http '+res.status);
      const data=await res.json();ext=data.extracted_scenario||{};missing=data.missing_questions||[];assistantMessage=data.assistant_message||'';
      const prev=advisorDraft;
      const merged={
        users: ext.users!=null?ext.users:(prev&&prev.users),
        peak_concurrency: ext.peak_concurrency!=null?ext.peak_concurrency:(prev&&prev.concurrency),
        active_hours: ext.active_hours!=null?ext.active_hours:(prev&&prev.activeHours),
        budget_wan: ext.budget_wan!=null?ext.budget_wan:(prev&&prev.budgetWan),
        data_residency: ext.data_residency!=null?ext.data_residency:(prev&&(prev.sensitive?'on_prem_only':'cloud_ok')),
        domestic_preference: ext.domestic_preference!=null?ext.domestic_preference:(prev&&prev.domestic),
        workload_type: (ext.workload_type&&ext.workload_type.length)?ext.workload_type:(prev&&(prev.task==='代码与 Agent'?['coding','agent']:prev.task==='知识库 / 办公问答'?['office','product']:['office'])),
        input_tokens: ext.input_tokens!=null?ext.input_tokens:(prev&&prev.inputTokens),
        output_tokens: ext.output_tokens!=null?ext.output_tokens:(prev&&prev.outputTokens),
        context_k: ext.context_k!=null?ext.context_k:(prev&&prev.contextK),
        provided_fields: ext.provided_fields||data.provided_fields||[]
      };
      advisorDraft=draftFromCloud(text,merged,prev);
    }catch(e){cloud=false;advisorDraft=parseAdvisorScenario(text,advisorDraft);}
    if(sendBtn)sendBtn.classList.remove('loading');
    const head=advisorTurnCount===1
      ?(cloud?(assistantMessage||'我识别到以下场景。橙色内容是系统假设，可以补充，也可以直接修改。'):'已用本地规则整理场景。橙色内容是系统假设，可以补充，也可以直接修改。')
      :'已合并你的补充。仍未说明的内容已采用可见假设，不会继续反复追问。';
    if(cloud){advisorHistory.push({role:'user',content:text});advisorHistory.push({role:'assistant',content:head});if(advisorHistory.length>24)advisorHistory=advisorHistory.slice(-24);}
    const pEl=list.querySelector('#'+id+' p');
    await typeInto(pEl,head);
    renderAdvisorDraft(cloud,ext,missing);
    $('advisorInput').value='';$('advisorInput').placeholder=advisorTurnCount<2?'可以继续补充上方问题，也可以直接采用假设':'还可以直接补充或修改任何条件';$('advisorSend').textContent='补充并更新';
  }

  function showToast(text){$('toast').textContent=text;$('toast').classList.add('is-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('is-visible'),1800);}
  function resetAdvisor(){
    if(lastAdvisorSnapshot){Object.entries(lastAdvisorSnapshot.values).forEach(([id,v])=>{if($(id))$(id).value=v;});setCloudMode(lastAdvisorSnapshot.cloudMode,false);setPricingMode(lastAdvisorSnapshot.pricingMode,false);lastAdvisorSnapshot=null;$('advisorReset').textContent='重新描述';render();showToast('已撤销顾问上次应用');return;}
    advisorDraft=null;advisorHistory=[];advisorTurnCount=0;$('advisorInput').value='';$('advisorInput').placeholder='例如：80名研发，20路并发，数据不能出域，预算300万，希望国产化。';$('advisorSend').textContent='分析场景';$('advisorEmpty').hidden=false;$('advisorDraft').hidden=true;$('advisorDraftStatus').textContent='等待描述';document.querySelectorAll('#advisorMessages .client-message,#advisorMessages [id^="amsg"]').forEach(n=>n.remove());$('advisorInput').focus();
  }
  function applyAdvisorDraft(){
    if(!advisorDraft)return;lastAdvisorSnapshot=createSharePayload();
    const roleKey=advisorProfiles[advisorDraft.task]?.role||'office';
    roleOrder.forEach(key=>{$(`${key}Users`).value=key===roleKey?advisorDraft.users:0;});
    const role=D.roleDefaults[roleKey],activePct=Math.min(100,Math.max(1,advisorDraft.concurrency/Math.max(advisorDraft.users*role.parallelTasks,1)*100));
    $(`${roleKey}ActivePct`).value=activePct.toFixed(1);
    if(advisorDraft.inputTokens!=null&&advisorDraft.inputTokens>0)$(`${roleKey}PrefillK`).value=advisorDraft.inputTokens/1000;
    if(advisorDraft.outputTokens!=null&&advisorDraft.outputTokens>0)$(`${roleKey}DecodeK`).value=advisorDraft.outputTokens/1000;
    $('modelSelect').value=advisorDraft.modelId;$('cardSelect').value=advisorDraft.cardId;setCloudMode('continuous',false);applyCardPreset();render();
    $('advisorDraftStatus').textContent='已应用';$('advisorReset').textContent='撤销上次应用';showToast('已应用到测算，可继续微调');showPage('calculator');
  }
  function showPage(page){
    const target=['calculator','advisor','data','lineage'].includes(page)?page:'calculator';
    $('calculatorPage').hidden=target!=='calculator';$('advisorPage').hidden=target!=='advisor';$('dataPage').hidden=target!=='data';$('lineagePage').hidden=target!=='lineage';
    $('navCalc').classList.toggle('is-active',target==='calculator');$('navData').classList.toggle('is-active',target==='data');$('navAdvisor').classList.toggle('is-active',target==='advisor');$('navLineage').classList.toggle('is-active',target==='lineage');
    ['navCalc','navData','navAdvisor','navLineage'].forEach(id=>$(id).removeAttribute('aria-current'));$(target==='data'?'navData':target==='advisor'?'navAdvisor':target==='lineage'?'navLineage':'navCalc').setAttribute('aria-current','page');
    if(target==='lineage')renderLineage();
    window.scrollTo({top:0,behavior:'smooth'});
  }

  function createSharePayload(){const values={};document.querySelectorAll('input[id]:not([type="search"]),select[id]').forEach(x=>values[x.id]=x.value);return {version:2,cloudMode,pricingMode,reverseConcurrencyMode,values};}
  function loadSharePayload(){
    if(!location.hash.startsWith('#s='))return;try{const p=JSON.parse(decodeURIComponent(location.hash.slice(3)));Object.entries(p.values||{}).forEach(([id,v])=>{if($(id))$(id).value=v;});if(['active','online'].includes(p.reverseConcurrencyMode))reverseConcurrencyMode=p.reverseConcurrencyMode;setCloudMode(p.cloudMode,false);setPricingMode(p.pricingMode,false);}catch(e){console.warn('无法读取分享场景',e);}
  }
  async function saveScenario(){
    location.hash=`s=${encodeURIComponent(JSON.stringify(createSharePayload()))}`;
    try{localStorage.setItem('deployment-capacity-scenario',JSON.stringify({savedAt:new Date().toISOString(),mode:calculatorMode,target:reverseTarget,payload:createSharePayload()}));}catch(e){console.warn('无法写入本地场景',e);}
    try{await navigator.clipboard.writeText(location.href);}catch(e){const t=document.createElement('textarea');t.value=location.href;t.style.cssText='position:fixed;opacity:0';document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();}
    const button=calculatorMode==='reverse'?$('reverseSave'):$('saveScenarioButton');
    if(button){const old=button.textContent;button.textContent='已保存';setTimeout(()=>button.textContent=old,1400);}
    showToast('场景已保存，链接已复制');
  }
  function escapeReport(value){return String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
  function exportReverseReport(){
    renderReverse();
    const s=readReverseState(),targetButton=document.querySelector(`[data-reverse-target="${reverseTarget}"]`);
    const conditions=[...document.querySelectorAll('.reverse-condition-row:not([hidden])')].map(row=>({label:row.querySelector(':scope > span').textContent.trim(),value:`${row.querySelector('input').value} ${row.querySelector('b').textContent.trim()}`,source:row.querySelector('em').textContent.trim()}));
    const boundaries=[...document.querySelectorAll('.reverse-boundary-grid article')].map(card=>({label:card.querySelector('span').textContent.trim(),value:card.querySelector('strong').textContent.trim(),note:card.querySelector('small').textContent.trim()}));
    const rows=conditions.map(x=>`<tr><td>${escapeReport(x.label)}</td><td>${escapeReport(x.value)}</td><td>${escapeReport(x.source)}</td></tr>`).join('');
    const boundaryCards=boundaries.map(x=>`<article><span>${escapeReport(x.label)}</span><strong>${escapeReport(x.value)}</strong><small>${escapeReport(x.note)}</small></article>`).join('');
    const html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>设备能力推演报告</title><style>body{max-width:980px;margin:48px auto;padding:0 28px;color:#173b34;font:15px/1.65 "Microsoft YaHei",sans-serif}h1{font-size:30px}h2{margin-top:34px;font-size:19px}header{border-bottom:2px solid #367d67;padding-bottom:22px}.answer{margin:24px 0;padding:24px;border-radius:18px;background:#eef7f2}.answer strong{display:block;font-size:38px;color:#15523f}table{width:100%;border-collapse:collapse}th,td{padding:12px;border-bottom:1px solid #d8e2dc;text-align:left}.grid{display:grid;grid-template-columns:repeat(5,1fr);gap:10px}.grid article{padding:14px;border:1px solid #d8e2dc;border-radius:12px}.grid span,.grid small{display:block;color:#71867f}.grid strong{display:block;margin:8px 0;font-size:19px}footer{margin-top:36px;color:#71867f;font-size:12px}@media print{body{margin:0}.grid{grid-template-columns:repeat(3,1fr)}}</style></head><body><header><small>CAPABILITY WORKBENCH</small><h1>按设备看能力 · 推演报告</h1><p>${escapeReport(s.card.name)} · ${escapeReport(s.deviceCount)} 台 · ${escapeReport(s.cardsPerDevice)} 卡/台 · ${escapeReport($('reverseModelSelect').selectedOptions[0]?.textContent)}</p></header><section class="answer"><span>${escapeReport(targetButton?.textContent.trim()||reverseTarget)}</span><strong>${escapeReport($('reverseAnswerValue').textContent)}</strong><p>${escapeReport($('reverseAnswerNote').textContent)}</p></section><h2>本次采用条件</h2><table><thead><tr><th>条件</th><th>数值</th><th>来源</th></tr></thead><tbody>${rows}</tbody></table><h2>能力边界</h2><div class="grid">${boundaryCards}</div><h2>结论口径</h2><p>结果为工程估算 C。首 Token 延迟由排队、Prefill 与调度通信构成，不代表目标环境实测承诺；采购前需使用目标模型、精度、框架、上下文和并发组合压测。</p><footer>导出时间：${escapeReport(new Date().toLocaleString('zh-CN'))}</footer></body></html>`;
    const blob=new Blob(['\ufeff',html],{type:'text/html;charset=utf-8'}),href=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=href;a.download=`设备能力推演-${reverseTarget}-${new Date().toISOString().slice(0,10)}.html`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1000);
    const old=$('reverseExport').textContent;$('reverseExport').textContent='已导出';setTimeout(()=>$('reverseExport').textContent=old,1400);showToast('报告已导出，可直接打开或打印为 PDF');
  }
  function bindEvents(){
    $('forwardMode').onclick=()=>setCalculatorMode('forward');$('reverseMode').onclick=()=>setCalculatorMode('reverse');
    $('reverseBack').onclick=()=>setCalculatorMode('forward');$('reverseSave').onclick=saveScenario;$('reverseExport').onclick=exportReverseReport;
    document.querySelectorAll('[data-reverse-target]').forEach(button=>button.onclick=()=>{reverseTarget=button.dataset.reverseTarget;const url=new URL(location.href);url.searchParams.set('mode','reverse');url.searchParams.set('target',reverseTarget);if(reverseTarget==='concurrency')url.searchParams.set('concurrencyMode',reverseConcurrencyMode);else url.searchParams.delete('concurrencyMode');history.replaceState(null,'',url);render();showToast(`已切换：${button.textContent.trim()}`);});
    document.querySelectorAll('[data-concurrency-mode]').forEach(button=>button.onclick=()=>{reverseConcurrencyMode=button.dataset.concurrencyMode;const url=new URL(location.href);url.searchParams.set('mode','reverse');url.searchParams.set('target','concurrency');url.searchParams.set('concurrencyMode',reverseConcurrencyMode);history.replaceState(null,'',url);render();showToast(reverseConcurrencyMode==='active'?'已切换：同时请求':'已切换：在线用户');});
    $('reverseUseAssumptions').onclick=()=>{$('reverseRequestRate').value=.2;$('reverseUserRatePerHour').value=2;$('reversePrefixCache').value=0;$('reverseTtftSlo').value=10;$('reverseResponseSlo').value=60;document.querySelectorAll('.reverse-condition-row em').forEach(tag=>{if(['arrival','userRate','cache','ttftSlo','responseSlo'].includes(tag.closest('.reverse-condition-row').dataset.condition)){tag.className='source-assumption';tag.textContent='系统假设';}});render();showToast('已采用建议假设，可继续修改');};
    $('reverseConditionList').addEventListener('change',e=>{const row=e.target.closest('.reverse-condition-row');if(!row)return;const tag=row.querySelector('em');tag.className='source-customer';tag.textContent='客户修改';});
    $('cloudActual').onclick=()=>setCloudMode('actual');$('cloudContinuous').onclick=()=>setCloudMode('continuous');
    $('pricingComponents').onclick=()=>setPricingMode('components');$('pricingQuote').onclick=()=>setPricingMode('nodeQuote');
    $('apiPriceProfile').onchange=()=>{applyApiPreset();render();};$('cardSelect').onchange=()=>{applyCardPreset();render();};$('modelSelect').onchange=()=>{updatePrecisionOptions();render();};
    $('reverseCardSelect').onchange=()=>{updateReversePrecisionOptions();render();};$('reverseModelSelect').onchange=()=>{updateReversePrecisionOptions();render();};
    document.querySelectorAll('input:not([type="search"]),select').forEach(x=>x.addEventListener('input',render));
    $('cardSearch').oninput=()=>renderDataTables($('cardSearch').value,$('modelSearch').value);$('modelSearch').oninput=()=>renderDataTables($('cardSearch').value,$('modelSearch').value);
    $('navCalc').onclick=()=>showPage('calculator');$('navAdvisor').onclick=()=>showPage('advisor');$('navData').onclick=()=>showPage('data');$('navLineage').onclick=()=>showPage('lineage');
    $('lineageReset').onclick=()=>{selectedLineageInput=null;renderLineage();};
    $('navSave').onclick=saveScenario;$('saveScenarioButton').onclick=saveScenario;
    $('derivationList').addEventListener('click',e=>{
      const summary=e.target.closest('.trace-accordion > summary');
      if(!summary)return;
      const current=summary.parentElement;
      if(!current.open)document.querySelectorAll('#derivationList .trace-accordion[open]').forEach(item=>{if(item!==current)item.open=false;});
    });
    document.querySelectorAll('[data-advisor-prompt]').forEach(b=>b.onclick=()=>{$('advisorInput').value=b.dataset.advisorPrompt;previewAdvisor();});
    $('advisorSend').onclick=previewAdvisor;$('advisorApply').onclick=applyAdvisorDraft;$('advisorReset').onclick=resetAdvisor;
    $('advisorConditionList').addEventListener('change',e=>updateAdvisorCondition(e.target));
    $('advisorInput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();previewAdvisor();}});
    document.querySelector('.brand').onclick=e=>{e.preventDefault();showPage('calculator');};
  }
  function renderAdvisorMarkup(){
    $('navAdvisor').innerHTML='<strong>智能顾问</strong><small>DESIGN PREVIEW</small>';$('saveScenarioButton').textContent='保存场景';
    $('advisorPage').innerHTML=`<div class="advisor-hero glass-card"><div><p class="eyebrow">AI DEPLOYMENT ADVISOR</p><h1 id="advisorTitle">先听场景，<br>再谈配置。</h1><p>把客户描述变成可确认的测算条件。顾问负责理解，计算引擎负责卡数与成本。</p></div><div class="advisor-status-card"><span class="status-label">当前状态</span><strong>交互设计预览</strong><p>尚未连接云端模型，不会发送客户数据。服务器接入后沿用同一确认流程。</p><span class="section-chip">BACKEND READY</span></div></div>
    <div class="advisor-grid"><section class="glass-card conversation-card"><div class="conversation-head"><div><p class="eyebrow">SCENARIO INTAKE</p><h2>部署顾问</h2></div><span class="advisor-online"><i></i>设计预览</span></div><div class="message-list" id="advisorMessages" aria-live="polite"><article class="message assistant-message"><div class="msg-avatar assistant-avatar">✦</div><div class="msg-body"><span class="message-role">部署顾问</span><p>可以告诉我业务需求，也可以直接说已有多少台设备。我会识别测算方向，把未说明条件作为可见假设展示。</p></div></article></div><div class="prompt-suggestions"><button type="button" data-advisor-prompt="80名研发，20路并发，每天连续使用12小时，代码和Agent为主，数据不能出域，预算300万元，希望国产化。">研发与 Agent</button><button type="button" data-advisor-prompt="200人办公问答，峰值30并发，每天12小时，预算150万元，可以使用云端API，希望比较混合部署。">企业办公问答</button><button type="button" data-advisor-prompt="我有1台8卡昇腾910C，最大上下文128K，典型输入32K、输出1K，能部署什么模型和支持多少并发？">已有设备看能力</button></div><div class="advisor-composer"><textarea id="advisorInput" rows="4" placeholder="例如：80名研发，20路并发；或我有1台8卡910C，能部署什么？"></textarea><div class="composer-foot"><span>先识别方向；所有默认条件都会展示</span><button id="advisorSend" type="button">分析场景</button></div></div></section>
    <aside class="advisor-side"><section class="glass-card scenario-card"><div class="section-heading"><div><p class="eyebrow">EXTRACTED SCENARIO</p><h2>待确认条件</h2></div><span class="section-chip" id="advisorDraftStatus">等待描述</span></div><div class="scenario-empty" id="advisorEmpty">输入客户场景后，这里会展示客户提供、系统假设和待压测条件。</div><div id="advisorDraft" hidden><div class="scenario-pills" id="scenarioPills"></div><div class="missing-card"><span id="advisorMissingTitle">可补充的关键信息</span><p id="advisorMissing">默认只追问一轮，其余内容采用可见假设。</p></div><section class="condition-panel"><div class="condition-heading"><div><strong>本次测算采用的条件</strong><small>橙色为系统假设，所有数值都可以修改</small></div><span id="advisorAssumptionCount">0 项假设</span></div><div class="condition-legend"><span class="legend-customer">客户提供</span><span class="legend-assumption">系统假设</span><span class="legend-benchmark">待压测</span></div><div class="condition-list" id="advisorConditionList"></div></section><div class="recommendation-list"><article class="recommendation-card primary-recommendation"><span>方案 A · 本地优先</span><strong id="advisorPlanA">—</strong><p id="advisorPlanADetail">—</p></article><article class="recommendation-card"><span>方案 B · 混合部署</span><strong id="advisorPlanB">—</strong><p id="advisorPlanBDetail">—</p></article></div><div class="advisor-citations"><span>回答依据</span><p id="advisorCitations">—</p></div><div class="advisor-actions"><button class="secondary-action" id="advisorReset" type="button">重新描述</button><button class="primary-action" id="advisorApply" type="button">按以上条件开始测算</button></div></div></section><section class="glass-card guardrail-card"><p class="eyebrow">GUARDRAILS</p><h2>先识别方向，再追问。</h2><p>业务需求进入“按业务找配置”；已有设备进入“按设备看能力”。未说明内容会采用可见假设，吞吐只显示为工程估算，采购前必须压测。</p></section></aside></div>`;
  }

  function init(){
    $('appBootReload').onclick=()=>{const url=new URL(location.href);url.searchParams.set('build',Date.now().toString());location.replace(url);};
    renderAdvisorMarkup();
    renderRoleInputs();populateSelectors();applyApiPreset();applyCardPreset();updateReversePrecisionOptions();loadSharePayload();refreshCardMeta();updateReversePrecisionOptions();bindEvents();renderDataTables();render();
    const params=new URLSearchParams(location.search),page=params.get('page');if(['data','advisor','lineage'].includes(page))showPage(page);
    if(['concurrency','speed','ttft','input','output'].includes(params.get('target')))reverseTarget=params.get('target');
    if(['active','online'].includes(params.get('concurrencyMode')))reverseConcurrencyMode=params.get('concurrencyMode');
    if(params.get('mode')==='reverse'){showPage('calculator');setCalculatorMode('reverse');}
    if(page==='data'&&params.get('section')==='api')requestAnimationFrame(()=>$('apiPricingSection').scrollIntoView({block:'start'}));
    document.documentElement.dataset.appReady=window.__DEPLOYMENT_APP_BUILD__||'ready';
    $('appBootError').hidden=true;
  }
  try{init();}catch(error){
    console.error('应用启动失败',error);
    window.__DEPLOYMENT_BOOT_ERROR__=error?.message||String(error);
    const panel=$('appBootError');if(panel){panel.hidden=false;panel.querySelector('span').textContent=window.__DEPLOYMENT_BOOT_ERROR__;}
  }
})();
