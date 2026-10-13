'use strict';
(() => {
  const E=window.PlanningEngine,D=window.AppData,$=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const displayFormat=new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2});
  const f=n=>Number.isFinite(n)?displayFormat.format(n):'未知 / 不适用', money=n=>'¥ '+f(n);
  function nodeValue(n){if(n.value===null)return n.id==='payback'?'不可比较 / 无有限回本期':'未知 / 不适用';if(typeof n.value!=='number')return String(n.value);if(n.unit.startsWith('FLOP')&&n.value>=1e12)return f(n.value/1e12)+' T'+n.unit;if(n.unit.startsWith('FLOP')&&n.value>=1e9)return f(n.value/1e9)+' G'+n.unit;if(n.unit==='bytes'&&n.value>=1e6)return f(n.value/1e9)+' GB';return f(n.value)+' '+n.unit;}
  const initial=()=>({...E.defaults(D),reverseTarget:'concurrency',responseSlo:60});
  let state=initial(), result, page='workbench', undo=[],dataTab='models',focusInput='inputK',toastTimer;
  const storageKey='deployment-planning-v5';
  // Single registry drives controls, lineage input labels, export and safe imports.
  const fields={
    throughput:['总吞吐目标','依所选口径',0,1e9,1,'0表示不限制；与单路Decode速度分开。'],apiFx:['美元预算汇率','CNY/USD',.001,100,.01],usageHours:['每日业务使用时长','h',.001,24,.5],dutyCycle:['闭环占空比','%',.001,1,.01,'并发不是全天满负载；可按实测请求数预算。',100],requestsPerDay:['每日请求量','次',0,1e9,1],cacheWriteShare:['缓存写入占输入比例','%',0,1,.01,'根据服务规则计写入与未命中。',100],cacheStorageMTokHours:['每日缓存存储','百万Token·小时',0,1e9,.1],minInputK:['允许优化的输入下限','K Token',.001,10000,.001],minOutputK:['允许优化的输出下限','K Token',.001,10000,.001],maxOutputK:['允许优化的输出上限','K Token',.001,10000,.001],
    inputK:['最大输入','K Token',.001,10000,.001,'本次请求送入模型的全部输入，已含携带的历史。'],outputK:['最大输出','K Token',.001,10000,.001,'本次请求最多生成多少；输入与输出相加才是上下文。'],responseSlo:['完整响应限时','s',.001,360000,1,'含 Prefill、传输与全部输出；不是仅 Decode 时间。'],concurrency:['同时并发','路',1,100000,1,'不是在线总人数；每一路都是同时在处理的请求。'],ttft:['首 Token 目标','s',.001,36000,.1],speed:['单路 Decode 目标','Token/s',.001,100000,1],servers:['已有服务器','台',1,10000,1],maxTP:['每实例物理卡数上限','卡/组',1,128,1],
    totalB:['完整参数量','B',.001,10000,.1],activeB:['每 Token 激活参数','B',.001,10000,.1],layers:['层数','层',1,1000,1],qHeads:['Q 头数（参考假设）','个',1,1000,1,'Q 头用于 Attention FLOPs，不是 KV 头。'],qkDim:['QK 头维度','维',1,4096,1],vDim:['V 头维度','维',1,4096,1],kvWidth:['每层 KV 总宽度','元素/Token',1,1000000,1,'GQA：2×KV头×headDim；MLA：参考 576。未知稀疏结构需核实。'],attentionFraction:['Attention 运算保留比例','%',.0001,1,.01,'默认完整注意力参考情景；不能作为稀疏加速承诺。',100],
    memoryGB:['单卡显存','GB',.001,10000,1],bandwidth:['单卡显存带宽','GB/s',.001,100000,1],matrixTF:['所选精度矩阵峰值','TFLOP/s 或 TOP/s',.001,100000,1,'只可填对应精度的非稀疏峰值；未知时停止计算。'],attentionTF:['FP16/BF16 峰值','TFLOP/s',.001,100000,1,'Attention 独立使用半精度算力，不沿用量化峰值。'],mfu:['矩阵计算利用率','%',.001,1,.01,'规划假设，需目标模型压测校准。',100],attentionMfu:['Attention 利用率','%',.001,1,.01,'长上下文算子单独校准。',100],bwEff:['有效带宽比例','%',.001,1,.01,'实际带宽 / 标称带宽。',100],parallelLoss:['TP 每翻倍效率损失','%',0,.4,.01,'η=(1−损失)^log₂(TP)；不是实测通信曲线。',100],reserve:['每卡显存预留','%',0,.9,.01,'框架与碎片等预留；另扣 workspace。',100],scratchGB:['每卡 workspace','GB',0,10000,.1],weightOverhead:['权重与量化元数据系数','倍',1,3,.01],kvBytes:['KV 元素字节数','bytes',.5,4,.5,'独立于权重精度；默认 2 bytes。'],kvReplication:['KV 存储/读写复制系数','倍',1,128,1,'需结合 TP 与 KV 分片方式确认。'],kvTraffic:['Prefill KV 读写系数','倍',1,1000,.1,'KV 写入与 Attention 分块重读的工程近似。'],unionGrowth:['批内专家并集增长','%',0,1,.05,'0 表示完全重用激活权重；1 表示逐路不重合直到全模型。Dense 无影响。',100],stepMs:['每阶段/Decode 步附加','ms',0,10000,.1,'用于未显式建模的调度、内核等固定开销，不含客户端渲染。'],transportMs:['一次请求额外传输时间','ms',0,100000,1],
    cardWan:['单卡报价','万元',.0001,10000,.1,'目录价格仅作占位；0 表示未知，需补齐。'],platformWan:['每台平台报价（不含卡）','万元',0,100000,.1],tdpW:['单卡规划功率','W',0,100000,1],hostW:['每台主机额外功率','W',0,100000,1],pue:['PUE','倍',1,5,.05],electricity:['电价','元/kWh',0,100,.01],powerHours:['本地每日计电时长','h',0,24,1],days:['每月计费天数','天',1,31,1],years:['摊销/对比年限','年',.01,100,.5],maintenance:['年维护准备金比例','%',0,1,.01,'按硬件采购额计算。',100],manualDaily:['手动每日 API 账单','元/日',0,1e10,1],apiHit:['输入 · 缓存命中','元/百万 Token',0,1e7,.0001],apiMiss:['输入 · 缓存未命中','元/百万 Token',0,1e7,.0001],apiOut:['输出','元/百万 Token',0,1e7,.0001],apiCache:['云端缓存命中比例','%',0,1,.01,'仅影响 API 输入费用，不减少本地首次 Prefill。',100],peakShare:['峰时用量占比','%',0,1,.01,'目录设置峰价为低谷基价 2 倍；请核实后使用。',100]
  };
  const labels={reverseTarget:'反向求解目标',...Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,v[0]])),topologyMode:'实例部署方式',contextMode:'原生/扩展上下文',throughputMetric:'总吞吐口径',workloadMode:'每日工作量方式',apiContextBand:'API短/长档情景',apiUseCatalog:'自动目录价格',cacheTTL:'缓存写入TTL',optimizeContext:'允许上下文优化',model:'部署模型',card:'芯片',precision:'权重/矩阵精度',mode:'正向/反向模式',slots:'每台卡位',multiNode:'允许跨节点 TP',costMode:'API 费用方式',api:'API 价格目录'};
  function field(k){const [label,unit,min,max,step,help='',scale=1]=fields[k];return `<div class="field"><label for="f-${k}">${esc(label)}<span class="muted">${esc(unit)}</span></label><input id="f-${k}" data-key="${k}" type="number" value="${Number.isFinite(state[k])?state[k]*scale:''}" min="${min*scale}" max="${max*scale}" step="${step*scale}" ${help?`aria-describedby="help-${k}"`:''}>${help?`<small id="help-${k}">${esc(help)}</small>`:''}</div>`;}
  function select(k,label,options){return `<div class="field"><label for="f-${k}">${esc(label)}</label><select id="f-${k}" data-key="${k}">${options.map(([value,name])=>`<option value="${esc(value)}" ${String(state[k])===String(value)?'selected':''}>${esc(name)}</option>`).join('')}</select></div>`;}
  const pair=(a,b)=>`<div class="field-pair">${field(a)}${field(b)}</div>`;
  function detail(id,title,html){return `<details id="${id}" class="control-details"><summary>${title}</summary>${html}</details>`;}
  function toast(s){clearTimeout(toastTimer);$('#toast').textContent=s;$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,4000);}
  function snapshot(){undo.push(structuredClone(state));if(undo.length>30)undo.shift();$('#undo').disabled=false;}
  const W=window.WorkbenchUI;
  function context(){return {s:state,result,E,D,field,pair,select,labels,fields,candidateTable,nodeValue};}
  function controls(){
    const opened=$$('#controls details[open]').map(x=>x.id);
    $('#controls').innerHTML=W.controls(context());
    opened.forEach(id=>{const el=document.getElementById(id);if(el)el.open=true;});
  }
  function applyChange(k,value){snapshot();
    state=window.AdvisorCore.patchState(state,{[k]:value},D,E);
    if(k==='api'){const a=D.apiPrices[value]||{};Object.assign(state,{apiHit:a.hit??null,apiMiss:a.miss??null,apiOut:a.out??null,apiUseCatalog:true});}
    refresh();
  }
  function constraint(title,ratio,text){return `<div class="constraint ${ratio>1?'bad':''}"><span>${title}</span><div class="bar"><i style="width:${Math.min(100,Math.max(0,ratio*100))}%"></i></div><span>${text}</span></div>`;}
  function candidateTable(){
    const proofHTML=(result.candidates||[]).map(q=>`<details class="table-details"><summary>TP ${q.tp}：容量边界的代入检查</summary><div class="table-wrap"><table><thead><tr><th>约束</th><th>最大整数批量</th><th>该批量的值</th><th>目标界限</th><th>再多一路</th></tr></thead><tbody>${Object.entries(q.proof).map(([kind,p])=>`<tr><td>${({kv:'显存 GB',ttft:'TTFT s',decode:'Decode Token/s/路'})[kind]}</td><td>${p.inactive?'不限制':p.cap+(p.capped?'（搜索上限）':'')}</td><td>${p.inactive?'—':p.at===null?'无可行批量':f(p.at)}</td><td>${p.inactive?'未设目标':(kind==='decode'?'≥':'≤')+' '+f(p.limit)}</td><td>${p.inactive?'—':p.next===null?'未继续搜索':f(p.next)+'，不满足'}</td></tr>`).join('')}</tbody></table></div><p class="muted">该候选真实工作点：B=${q.B}；η=${f(q.w.eta)}；有效矩阵=${f(q.w.matrix/1e12)} TFLOP/s；Attention=${f(q.w.attention/1e12)} TFLOP/s；有效带宽=${f(q.w.bw/1e9)} GB/s；权重并集=${f(q.w.union)} GB。计算和访存均按相同 work(TP,B) 方程求得。</p></details>`).join('');
    return `<details class="table-details"><summary>查看全部 TP 候选与卡数选择</summary><p class="muted">逐个搜索整数批量。正向优先最少整机卡位，其次最少运行卡；反向按所选目标优选并发、速度或首 Token 延迟。每实例搜索上限：${state.mode==='forward'?state.concurrency:'100,000'} 路。下方可继续展开每个边界的证据。TP按物理卡枚举，910C另计每模组2个逻辑设备；Q/KV头分片和复制按逻辑TP校验，专用框架路线待确认。</p><div class="table-wrap"><table><thead><tr><th>物理卡/实例（近似）</th><th>显存容量</th><th>TTFT 容量</th><th>Decode 容量</th><th>实例</th><th>实际批量</th><th>服务器</th><th>逐项检查</th></tr></thead><tbody>${(result.candidates||[]).map(q=>`<tr class="${q===result.chosen?'chosen':''}"><td>${q.tp}</td><td>${q.kvCap}</td><td>${q.proof.ttft.inactive?'未设目标':q.ttftCap}</td><td>${q.proof.decode.inactive?'未设目标':q.decodeCap}</td><td>${q.groups}</td><td>${q.groups?q.B:'—'}</td><td>${q.servers||'—'}</td><td>${q.valid?'参考约束通过':[!q.single.fits?'权重/一路 KV 装不下':'',!q.w.fits&&q.single.fits?'实际批量 KV 超限':'',!q.w.ttftOK?'首 Token 超时':'',!q.w.speedOK?'末端速度不足':'',!q.responseOK?'完整响应超时':'',!q.throughputOK?'总吞吐不足':''].filter(Boolean).join('；')}</td></tr>`).join('')}</tbody></table></div>${proofHTML}</details>`;
  }
  function inputValue(k){const actual=result?.effectiveState||state;if(k==='reverseTarget')return window.ReverseSolver.targets[state.reverseTarget]?.name||state.reverseTarget;if(k==='model')return D.models[state.model].name;if(k==='card')return D.cards[state.card].name;if(k==='precision')return E.precision[state.precision]?.name||state.precision;if(k==='api')return D.apiPrices[state.api]?.name||String(state.api);if(state.mode==='reverse'&&result?.solve?.meta.solved===k)return `求解后：${f(result.solve.answer)} ${result.solve.meta.unit}`;if(state.mode==='reverse'&&result?.solvedInputs?.includes(k))return `求解工作点：${f(actual[k])}`;if(state.mode==='reverse'&&['speed','ttft'].includes(k)&&result?.options?.ignoreTargets?.includes(k))return '未设目标，不参与约束';const def=fields[k];return def?`${f(actual[k]*(def[6]||1))} ${def[1]}`:String(state[k]);}
  function renderTrace(){if(window.PanelHarness)return window.PanelHarness.renderTrace();$('#trace-content').textContent='正在加载变化对比…';}
  function renderData(){$('#data-content').innerHTML=window.CatalogUI.render(D,dataTab);}
  function showPage(p){const switched=page!==p;if(!['workbench','trace','data','advisor'].includes(p))p='workbench';page=p;$$('.page').forEach(x=>x.hidden=x.id!==p);$$('[data-page]').forEach(x=>{x.classList.toggle('selected',x.dataset.page===p);x.setAttribute('aria-current',x.dataset.page===p?'page':'false');});if(p==='trace')renderTrace();if(p==='data')renderData();if(location.hash!=='#'+p)history.replaceState(null,'','#'+p);if(switched)window.scrollTo({top:0,behavior:'instant'});}
  function jump(id){const el=document.getElementById('overview-'+id)||document.getElementById('calc-'+id);if(!el){toast('该步骤在当前分支中未执行。');return;}showPage('workbench');if(el.tagName==='DETAILS')el.open=true;for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;el.scrollIntoView({behavior:'auto',block:'center'});el.focus({preventScroll:true});}
  function focusField(id){showPage('workbench');const el=document.getElementById('f-'+id);if(!el){toast('该值在当前模式下不是可填写条件，可在变量关系中查看。');return;}for(let p=el.parentElement;p;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;el.scrollIntoView({block:'center'});el.focus({preventScroll:true});}
  function normalizeState(s){return {...s,contextMode:'native',throughput:0,throughputMetric:'sustained-output',optimizeContext:false,workloadMode:'closed-loop',usageHours:12,dutyCycle:1,days:30,years:3,reverseTarget:s.reverseTarget==='throughput'?'concurrency':s.reverseTarget};}
  function evaluateState(source){const s=normalizeState(source);return s.mode==='reverse'?window.ReverseSolver.solve(s,D,s.reverseTarget):E.calculate(s,D);}
  function refresh(){
    window.CostChart?.dispose();
    state=normalizeState(state);
    const opened=$$('.calc-section[open]').map(x=>x.dataset.calcGroup);
    const proofOpen=$('#full-calculation-proof')?.open||false;
    if(state.mode==='forward'&&state.apiUseCatalog){const quote=window.ApiPricing.quote(state,D,Math.round(state.inputK*1000),Math.round(state.outputK*1000));if(quote.prices)Object.assign(state,{apiHit:quote.prices.hit,apiMiss:quote.prices.miss,apiOut:quote.prices.out});}
    result=evaluateState(state);controls();const reverse=state.mode==='reverse';
    $('#workbench').classList.toggle('reverse-mode',reverse);
    $('#workbench-title').textContent=reverse?'已有硬件验证':'按需求选配卡';
    $('#workbench-subtitle').textContent=reverse?'先选设备和模型，再选择要解出的能力边界。':'填写需求，比较 API 月费与本地配置。';
    $$('[data-mode]').forEach(el=>{el.classList.toggle('selected',el.dataset.mode===state.mode);el.setAttribute('aria-pressed',el.dataset.mode===state.mode);});
    $('#results').hidden=reverse;$('#reverse-workspace').hidden=!reverse;
    $('#results').innerHTML=reverse?'':W.forward(context());
    $('#reverse-targets').innerHTML=reverse?W.reverseTargets(state):'';
    $('#reverse-conditions').innerHTML=reverse?W.reverseControls(context()):'';
    $('#reverse-result').innerHTML=reverse?W.reverse(context()):'';
    $('#inline-calculations').innerHTML=window.WorkbenchSummary.calculations(context())+`<details id="full-calculation-proof" ${proofOpen?'open':''}><summary>来源、运行假设与选型候选</summary>${W.calculations(context(),opened)}${reverse?'':candidateTable()}${result.warnings.length?`<details class="estimate-notes"><summary>估算边界与待核验项</summary><ul class="list-clean">${result.warnings.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`:''}</details>`;
    window.CalculationExplain.resetTooltip();
    $('#calculation-title').textContent=reverse?'求解过程 · '+window.ReverseCalculation.names[state.reverseTarget]:'完整计算过程';
    $('#expand-inline').textContent=proofOpen?'收起技术细节':'查看技术细节';
    if(result.cost)W.wireChart(result.cost,result.effectiveState||state);
    if(page==='trace')renderTrace();if(page==='data')renderData();
    window.PanelV4={getState:()=>structuredClone(state),getResult:()=>structuredClone(result),fields,labels,refresh,evaluate:evaluateState,context,
      makeState:patch=>window.AdvisorCore.patchState(state,patch,D,E),
      commit:next=>{next=normalizeState(next);const checked=evaluateState(next);if(!checked.ok)throw Error(checked.errors.join('；'));snapshot();state=structuredClone(next);refresh();return checked;},
      showPage,toast};
    window.dispatchEvent(new CustomEvent('panel-state-change'));
    window.PanelV3=window.PanelV4;
  }
  function download(name,text,type){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  function report(){return `# GPU 部署推演报告\n\n生成：${new Date().toLocaleString('zh-CN')}\n引擎：${E.VERSION}\n状态：${result.ok?(result.feasible?'满足理论约束；仍需压测':'不满足目标 / 无可行配置'):'输入无效'}\n\n## 口径\n\n${result.performanceEvidence?.reason?result.performanceEvidence.reason+'\n\n':''}首批全部同时到达，单路上下文 = 最大输入 + 最大输出。K=1000 Token，GB=10⁹ bytes；冷启动、同步批处理。完整模型与假设见 UPDATE-20261001.md。\n\n## 输入快照\n\n${Object.keys(state).map(k=>`- ${labels[k]||k}（${k}）：${inputValue(k)}`).join('\n')}\n\n## 完整计算过程\n\n${result.trace.map((n,i)=>`### ${i+1}. ${n.title}\n\n依赖：${n.deps.join('、')}\n\n公式：${n.formula}\n\n结果：${n.value??'未知 / 不适用'} ${n.unit}\n\n${n.note}`).join('\n\n')}\n\n## 所有候选\n\n\`\`\`json\n${JSON.stringify({targetComparisons:result.solve?.alternatives||[],finalCandidates:result.candidates||[]},null,2)}\n\`\`\`\n\n## 限制与错误\n\n${[...result.errors,...result.warnings].map(x=>'- '+x).join('\n')}\n`;}
  function save(){if(!result.ok){toast('先修正无效参数，再保存方案。');return;}try{localStorage.setItem(storageKey,JSON.stringify({version:5,catalogVersion:D.catalogVersion,state}));toast('方案已保存在此浏览器，仅 v5 使用，不覆盖旧版记录。');}catch{toast('浏览器不允许保存，请导出报告留存。');}}
  function load(){try{
    let x=JSON.parse(localStorage.getItem(storageKey)||'null'),legacy=false;
    if(!x){x=JSON.parse(localStorage.getItem('deployment-planning-v4')||'null');legacy=!!x;}
    if(!x?.state||![4,5].includes(x.version)){toast('此浏览器没有可读的 v4/v5 方案。');return;}
    const old={...x.state,model:D.modelAliases?.[x.state.model]||x.state.model};if(!D.models[old.model]||!D.cards[old.card]||!E.precision[old.precision]){toast('旧方案的型号/精度ID无法迁移，请从新目录选择；原存档仍保留。');return;}
    let next={...initial(),...Object.fromEntries(Object.keys(initial()).filter(k=>Object.hasOwn(old,k)).map(k=>[k,old[k]]))};
    if(legacy){
      Object.assign(next,E.modelDefaults(D.models[next.model]));
      next.api=window.ApiPricing.defaultApi(next.model,D);next.apiUseCatalog=true;
      const api=D.apiPrices[next.api]||{};Object.assign(next,{apiHit:api.hit??null,apiMiss:api.miss??null,apiOut:api.out??null});
      next.topologyMode='single';
    }
    next=normalizeState(next);snapshot();state=next;refresh();
    toast(legacy?'已迁移旧需求：模型结构与API按新目录重核，保留旧单实例及手填硬件/报价假设；旧存档未覆盖，可撤销。':'已读取v5方案；无效或缺失参数将在页面说明。');
  }catch{toast('方案无法读取，请检查存档格式。');}}
  $('#workbench').addEventListener('change',event=>{const el=event.target,k=el.dataset.key;if(!k)return;let value;if(el.type==='checkbox')value=el.checked;else if(fields[k]){if(el.value===''){applyChange(k,NaN);toast('数值未填，计算已暂停；不会把空白当成 0。');return;}value=Number(el.value)/(fields[k][6]||1);}else value=k==='slots'?Number(el.value):el.value;applyChange(k,value);});
  document.addEventListener('click',event=>{const b=event.target.closest('button');if(!b)return;if(b.dataset.page)showPage(b.dataset.page);if(b.dataset.goto)showPage(b.dataset.goto);if(b.hasAttribute('data-enable-cross-node'))applyChange('multiNode',true);if(b.dataset.mode)applyChange('mode',b.dataset.mode);if(b.dataset.costMode)applyChange('costMode',b.dataset.costMode);if(b.dataset.reverseTarget)applyChange('reverseTarget',b.dataset.reverseTarget);if(b.dataset.input)focusField(b.dataset.input);if(b.dataset.trace)jump(b.dataset.trace);if(b.dataset.focusInput){focusInput=b.dataset.focusInput;showPage('trace');}if(b.dataset.dataTab){dataTab=b.dataset.dataTab;renderData();}});
  document.addEventListener('change',event=>{if(event.target.id==='focus-input'){focusInput=event.target.value;renderTrace();}});
  document.addEventListener('click',event=>{if(event.target.closest('[data-refresh-api]')){applyChange('api',state.api);toast('已应用当前目录价格；可在页尾撤销。未核实价格留空。');}});
  document.addEventListener('input',event=>{if(event.target.id==='catalog-search'){const query=event.target.value.toLowerCase();$$('#catalog-table tbody tr').forEach(tr=>tr.hidden=!tr.textContent.toLowerCase().includes(query));}});
  $('#save').onclick=save;$('#load').onclick=load;$('#undo').onclick=()=>{if(!undo.length)return;state=undo.pop();refresh();$('#undo').disabled=!undo.length;toast('已撤销上一次参数修改。');};
  $('#reset').onclick=()=>{snapshot();state=initial();refresh();toast('已恢复初始场景，可撤销。');};
  $('#export').onclick=()=>download('部署推演-完整报告.md',report(),'text/markdown;charset=utf-8');if($('#export-json'))$('#export-json').onclick=()=>download('部署推演-计算链.json',JSON.stringify({version:E.VERSION,state,effectiveState:result.effectiveState||state,solve:result.solve,result},null,2),'application/json');
  $('#teach-current').onclick=()=>{const snapshot=structuredClone(state);const link=document.createElement('a');link.href='capacity-lesson.html#state='+encodeURIComponent(JSON.stringify(snapshot));link.target='_blank';link.rel='noopener';link.click();};
  $('#expand-inline').onclick=()=>{const proof=$('#full-calculation-proof');if(!proof)return;proof.open=!proof.open;$('#expand-inline').textContent=proof.open?'收起技术细节':'查看技术细节';if(proof.open)proof.scrollIntoView({block:'center'});};
  if($('#expand-trace'))$('#expand-trace').onclick=()=>{const nodes=$$('.trace-item'),open=nodes.some(x=>!x.open);nodes.forEach(x=>x.open=open);$('#expand-trace').textContent=open?'收起全部公式':'展开全部公式';};
  window.addEventListener('hashchange',()=>showPage(location.hash.slice(1)));window.addEventListener('resize',()=>{if(page==='trace')renderTrace();});
  refresh();showPage(location.hash.slice(1)||'workbench');
})();
