'use strict';
// Rendering only: every number comes from PlanningEngine or ReverseSolver.
(function(root){
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const f=n=>Number.isFinite(n)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n):'—';
  const money=n=>Number.isFinite(n)?'¥ '+f(n):'未知', wan=n=>Number.isFinite(n)?f(n/10000)+' 万':'未知';
  const det=(id,title,body)=>`<details id="${id}" class="control-details"><summary>${title}</summary>${body}</details>`;
  function section(n,title,body,extra=''){return `<section class="panel input-section" data-section="${extra}"><h2><span class="section-no">${n}</span>${title}</h2>${body}</section>`;}
  function controls(ctx){
    const {s,E,D,field,pair,select}=ctx,m=D.models[s.model],c=D.cards[s.card];
    const model=select('model','部署模型',Object.values(D.models).map(m=>[m.id,m.name+(!E.canEstimate(m)?'（缺少参数）':m.resourceEstimate?'（架构参考估算）':'')]));
    const card=select('card','芯片',Object.values(D.cards).map(c=>[c.id,c.name+'（'+E.estimation(m,c).label+'）']));
    const sp=E.supported(m,c),precision=select('precision','权重 / 矩阵精度',sp.length?sp.map(k=>[k,E.precision[k].name]):[['','当前模型与芯片暂无已核验路径']])+(!sp.length?`<p class="notice compact-note precision-status">${esc(m.catalogOnly?'该模型已收录结构和原生量化信息，但本地推理路径尚未建模；不代表芯片没有权重精度支持。':'目录暂未建立该模型与此芯片的精度适配路径。')}<br>${esc(c.name)} 已收录：${esc((c.precisions||[]).join('、')||'待核对')}；当前模型：${esc((m.supportedPrecisions||[]).join('、')||'未标注')}。</p>`:'');
    const slots=select('slots','每台装卡数',[[1,'1 张'],[2,'2 张'],[4,'4 张'],[8,'8 张']]);
    // KV format is independent of weight quantization. Byte size is an explicit
    // planning assumption, not a claim that the device has an FP8 KV kernel.
    const kv=field('kvBytes');
    const topology=select('topologyMode','实例部署方式',[['replicas','自动分组 / 多实例'],['single','单模型实例']])+`<div class="topology-control"><label class="field-checkbox"><input type="checkbox" data-key="multiNode" ${s.multiNode?'checked':''}>自动评估单机与跨机方案</label><p class="muted">${s.multiNode?'跨机是候选，不表示通信已验证；部署前需核对互连和框架。':'当前仅搜索单机副本；多台设备的显存不会自动拼到一个副本。'}</p>${field('maxTP')}</div>`;
    const route=`<p class="notice compact-note">${esc(E.estimation(m,c,s.precision).note)}</p>`+(m.resourceEstimate?det('architecture-estimate','架构参考估算：查看计算假设',`<p>${esc(m.resourceEstimate.note)}</p>`):'')+routeInfo(ctx)+(c.manualCompute?`<p class="notice">${esc(c.note)}</p>`:'');
    const hardware=det('hardware-details','硬件效率与运行假设',`${kv}${pair('memoryGB','bandwidth')}${field('matrixTF')}${field('attentionTF')}${pair('mfu','attentionMfu')}${pair('bwEff','parallelLoss')}${pair('reserve','scratchGB')}${field('weightOverhead')}${field('kvReplication')}${field('kvTraffic')}${field('unionGrowth')}${pair('stepMs','transportMs')}`);
    const structure=det('model-details','模型结构与 Attention 假设',`<p class="muted">${esc(m.attentionType)} · 可编辑参考值，需目标框架验证。</p>${pair('totalB','activeB')}${pair('layers','qHeads')}${pair('qkDim','vDim')}${field('kvWidth')}${field('attentionFraction')}`);
    const business=section('01','需求',`${field('concurrency')}${pair('ttft','speed')}${pair('inputK','outputK')}<div class="context-summary">单路上下文 <strong>${f(s.inputK+s.outputK)}K Token</strong></div>`,'business');
    const api=D.apiPrices[s.api]||{};
    const sourceNote=`<p class="muted">${esc(api.note||api.source||'历史目录，未重新核验')}<br>核验：${esc(api.updatedAt||api.checkedAt||'未标注')} ${api.native?`· 原币输入 / 输出 ${api.native.miss} / ${api.native.out} ${api.currency==='USD'?'USD × '+s.apiFx:'CNY'}`:''}${api.validUntil?`<br>促销到期：${esc(api.validUntil)}；不要将短期折扣直接用于多年预算。`:''}</p>${/^https:\/\//.test(api.source||'')?`<a href="${esc(api.source)}" target="_blank" rel="noopener noreferrer">官方价格依据</a>`:''}<button data-refresh-api style="margin-left:8px">应用目录价</button>`;
    const priceDetails=det('api-details','缓存与价格口径',`${field('apiHit')}${field('apiCache')}${pair('cacheWriteShare','cacheStorageMTokHours')}${select('cacheTTL','缓存写入TTL',[['fiveMinutes','5分钟'],['oneHour','1小时']])}${field('apiFx')}${api.longContextPrices?select('apiContextBand','上下文价格情景',[['auto','阈值未知：给价格范围'],['short','短档（用户预算假设）'],['long','长档（用户预算假设）']]):''}<p class="muted">${s.apiUseCatalog?'自动目录价：随长度、服务和汇率更新':'手动单价情景：不宣称官方账单'}。修改价格即进入手动情景。</p>${api.peakPricing?field('peakShare'):''}${sourceNote}`);
    const cloud=section('02','云端调用',`<div class="segmented cost-tabs">${[['manual','每日账单'],['continuous','模型 API']].map(([key,name])=>`<button data-cost-mode="${key}" class="${s.costMode===key?'selected':''}">${name}</button>`).join('')}</div>${s.costMode==='manual'?`${field('manualDaily')}<p class="muted compact-note">按 30 天计算月费，累计比较 3 年。</p>`:`${select('api','API 模型',[['','无已匹配API'],...Object.values(D.apiPrices).filter(a=>!a.legacy).sort((a,b)=>Number(b.modelIds.includes(s.model))-Number(a.modelIds.includes(s.model))).map(a=>[a.id,(a.modelIds.includes(s.model)?'同模型 · ':'其他模型对比 · ')+a.name])])}${pair('apiMiss','apiOut')}${priceDetails}<p class="muted compact-note">每日 12 小时满载，每次用满输入与输出。</p>`}`,'cloud');
    const local=section('03','本地部署',`${model}${card}${precision}${route}${slots}${det('topology-details','部署方式与跨机设置',topology)}${det('local-quote-details','硬件报价',pair('cardWan','platformWan'))}${det('local-cost-details','用电与维护',`${pair('tdpW','hostW')}${pair('pue','electricity')}${pair('powerHours','maintenance')}`)}${hardware}${structure}`,'local');
    if(s.mode==='reverse')return `<div class="hardware-setup">${section('01','已有设备',`${card}<div class="field-pair">${field('servers')}${slots}</div><div class="context-summary">${s.servers} 台 × ${s.slots} 张 = <strong>${f(s.servers*s.slots)} 张卡</strong></div>`,'hardware')}${section('02','部署模型',`${model}`,'model')}${section('03','运行精度',`${precision}${route}`,'precision')}</div><div class="panel reverse-topology">${det('topology-details','部署方式与跨机设置',topology)}</div><div class="panel reverse-advanced">${hardware}${structure}</div>`;
    return business+cloud+local;
  }
  function chartData(cost,months){
    const opex=cost.energy+cost.maintenance;
    const at=t=>({month:t,cloud:cost.apiMonthly*t,local:cost.capex+opex*t,difference:cost.apiMonthly*t-cost.capex-opex*t});
    const payback=cost.apiMonthly>opex?cost.capex/(cost.apiMonthly-opex):null;
    return {months,opex,payback,crossing:payback!==null&&payback<=months?at(payback):null,end:at(months),at};
  }
  function chart(cost,s){
    const view=typeof module!=='undefined'&&module.exports?require('./cost-chart'):root.CostChart;
    return view.render(cost,s,chartData(cost,s.years*12));
  }
  function expenseValues(ctx){
    const {s,result:r}=ctx,c=r.cost||{},a=s.costMode==='manual'?null:r.apiBudget;
    const valid=n=>Number.isFinite(n)&&n>=0;
    const rawRange=r.apiMonthlyRange||(a?.ok?a.monthlyRange:null);
    const range=Array.isArray(rawRange)&&rawRange.length===2&&rawRange.every(valid)?[...rawRange].sort((x,y)=>x-y):null;
    const manual=s.costMode==='manual'&&valid(s.manualDaily)&&Number.isInteger(s.days)&&s.days>=1&&s.days<=31?s.manualDaily*s.days:null;
    const apiMonthly=valid(c.apiMonthly)?c.apiMonthly:valid(manual)?manual:a?.ok&&valid(a.monthly)?a.monthly:null;
    const running=valid(c.energy)&&valid(c.maintenance)?c.energy+c.maintenance:null;
    return {c,a,range,apiMonthly,running,localOK:valid(c.capex)&&valid(running),valid};
  }
  function comparison(ctx){
    const {s,result:r,D}=ctx,{c,range,apiMonthly,running,localOK,valid}=expenseValues(ctx);
    const periodOK=Number.isFinite(s.years)&&s.years>0,months=periodOK?s.years*12:null;
    const cloudName=s.costMode==='manual'?'手动每日账单':D.apiPrices[s.api]?.name||'未选择 API 模型';
    const matched=s.costMode!=='manual'&&(r.costStatus?.matched??D.apiPrices[s.api]?.modelIds?.includes(s.model));
    const status=c.comparable?'同模型规划对比':s.costMode==='manual'?'手动账单费用预算':matched?'同模型费用预算':'不同模型费用预算';
    const hasAPI=valid(apiMonthly)||!!range;
    const note=c.comparable?'按同模型工作量规划，实际服务表现仍需验证。':s.costMode==='manual'?'手动账单需核对是否对应相同工作量，暂不作回本结论。':matched?'API 限额及实际部署表现仍需确认，暂不作回本结论。':'不同模型的费用可以对照，业务效果和服务能力需另行核对。';
    const canChart=localOK&&valid(apiMonthly)&&periodOK;
    const localTotal=localOK&&periodOK?c.capex+running*months:null;
    const apiTotal=valid(apiMonthly)&&periodOK?apiMonthly*months:null;
    const apiRange=range&&periodOK?range.map(n=>n*months):null;
    const incomplete=r.quoteBlocked?'模型专用推理架构尚未建模，本地采购及回本暂不能核算。':!hasAPI?'API 单价或工作量未齐，云端费用暂未知。':!localOK?'本地报价、财务参数或部署方案未齐，采购与累计费用暂未知。':!periodOK?'请填写有效对比年限后查看累计费用。':'API 价格档位尚未确定，保留费用范围；选择明确档位后显示曲线。';
    const totals=`<div class="chart-totals"><div><small>${periodOK?f(s.years)+' 年':'累计'}云端</small><strong data-cost="api-total">${apiRange?apiRange.map(wan).join(' ～ '):wan(apiTotal)}</strong></div><div><small>${periodOK?f(s.years)+' 年':'累计'}本地</small><strong data-cost="local-total">${wan(localTotal)}</strong></div><div><small>${valid(apiTotal)&&valid(localTotal)?apiTotal>=localTotal?'本地少支出':'云端少支出':'费用差额'}</small><strong data-cost="difference">${valid(apiTotal)&&valid(localTotal)?wan(Math.abs(apiTotal-localTotal)):apiRange&&valid(localTotal)?apiRange.map(n=>wan(n-localTotal)).join(' ～ '):'待补齐'}</strong>${apiRange&&valid(localTotal)?'<small>云端 − 本地</small>':''}</div></div>`;
    const sides=`<div class="comparison-sides"><div><small>云端每月</small><strong>${range?range.map(money).join(' ～ '):money(apiMonthly)}</strong><span>${esc(cloudName)}</span></div><div><small>本地每月运营</small><strong>${money(running)}</strong><span>${esc(D.cards[s.card]?.name||s.card)} · ${esc(ctx.E.precision[s.precision]?.name||s.precision)}</span></div></div>`;
    return `<section id="cost-comparison" class="panel cost-chart-panel" data-comparison="${c.comparable?'validated':'budget'}"><div class="result-heading"><h2>API 与本地部署</h2><span class="status-chip">${hasAPI?status:'费用预算待补齐'}</span></div><div class="comparison-models"><div><small>云端 API</small><strong>${esc(cloudName)}</strong></div><div><small>本地部署</small><strong>${esc(D.models[s.model]?.name||s.model)}</strong><small>${esc(D.cards[s.card]?.name||s.card)} · ${esc(ctx.E.precision[s.precision]?.name||s.precision)}</small></div></div>${sides}${canChart?chart(c,s):`<p class="comparison-pending">${incomplete}</p>${totals}`}<p class="muted chart-footnote">本地 = 采购 + 电费 + 维护，累计费用不重复加摊销。${note}${r.ok&&!r.feasible?'当前本地配置未满足所选目标，费用仅供预算。':''}</p>${c.comparable?'<button class="inline-action" data-trace="payback">交点怎么算</button>':''}</section>`;
  }
  function expenses(ctx){
    const {s,result:r}=ctx,{c,a,range,apiMonthly,running,valid}=expenseValues(ctx);
    const apiText=range?range.map(money).join(' ～ '):money(apiMonthly);
    const hasApiTrace=r.trace?.some(n=>n.id==='apiMonthly'),hasLocalTrace=r.trace?.some(n=>n.id==='localMonthly');
    return `<section class="panel expense-panel"><h2>每月费用拆分</h2><div class="expense-columns"><div><h3><span>云端 API</span><strong data-cost="api-monthly">${apiText}</strong></h3>${!r.chosen&&a?.ok?'<p>独立API预算</p>':''}<p>${s.costMode==='manual'?'按已填每日账单':'按当前需求与目录单价估算'}</p>${hasApiTrace?'<button class="inline-action" data-trace="apiMonthly">输入 / 输出与计费过程</button>':a?.ok?`<p class="muted">${f(a.rounds)} 请求/日，输入 ${f(a.dailyIn/1e6)} 百万 + 输出 ${f(a.dailyOut/1e6)} 百万 Token/日</p>`:'<p class="muted">请补齐 API 单价。</p>'}</div><div><h3><span>本地运营</span><strong data-cost="local-monthly">${money(running)}</strong></h3><p>电费 ${money(c.energy)} ＋ 维护 ${money(c.maintenance)}</p>${valid(c.localMonthly)?`<details class="control-details"><summary>查看用电与摊销</summary><p>硬件摊销 ${money(c.depreciation)} / 月</p><p>含摊销总计 ${money(c.localMonthly)} / 月</p>${hasLocalTrace?'<button class="inline-action" data-trace="localMonthly">查看费用计算</button>':''}</details>`:r.quoteBlocked?'<p class="muted">全 Attention 资源参考不能用于采购报价。</p>':'<p class="muted">补齐本地报价与部署方案后显示费用。</p>'}</div></div></section>`;
  }
  function timeline(ctx){
    const {result:r,s}=ctx,q=r.chosen,w=q.w;
    return `<section class="panel timing-panel"><div class="result-heading"><h2>这批请求如何完成</h2><span class="muted">${f(r.effectiveState?.concurrency||s.concurrency)} 路同时发起</span></div><div class="request-stages"><button data-trace="ttftResult"><small>传输</small><strong>${f(s.transportMs/1000)} s</strong></button><span aria-hidden="true">＋</span><button data-trace="prefillTime"><small>Prefill · 读入</small><strong>${f(w.prefill)} s</strong></button><span aria-hidden="true">＋</span><button data-trace="decodeDuration"><small>Decode · 生成</small><strong>${f(w.decode)} s</strong></button></div><div class="request-milestones"><button data-trace="ttftResult"><span>首 Token</span><strong>${f(w.ttft)} s</strong></button><button data-trace="decodeSpeed"><span>末端单路速度</span><strong>${f(w.speed)} Token/s</strong></button><button data-trace="response"><span>完整输出</span><strong>${f(w.response)} s</strong></button></div><p class="muted compact-note">首 Token 由 Prefill 产生，之后逐 Token 计算上下文增长。点击可看公式；阶段卡片不按时长比例。</p></section>`;
  }
  function routeInfo(ctx){const p=ctx.D.models[ctx.s.model].deploymentPaths?.[ctx.s.card];if(!p)return '';return `<details class="control-details route-info"><summary>已核对的精度与部署路径</summary>${p.rows.map(row=>`<p><strong>${esc(row.name)}</strong><br>${esc(row.status)}</p>`).join('')}<p>${esc(p.note)}</p><a href="${esc(p.source)}" target="_blank" rel="noopener noreferrer">${esc(p.title)}</a><small>核对日期 ${esc(p.checkedAt)}</small></details>`;}
  function diagnosis(ctx){
    const {s,result:r}=ctx,d=r.diagnostics;if(!d)return '';
    const limited=r.performanceEvidence?.referenceOnly;
    let action=!d.weightFits?(s.multiNode?'当前设备数量、显存或每副本上限不足以容纳完整权重。请查看卡数下限和拓扑候选。':'当前限制为单机副本。增加服务器不会自动合并显存，可开启下方跨机方案评估。'):!d.requestFits?'权重可以装载，但当前上下文所需的一路完整 KV 放不下。':!r.feasible?'模型可以装载，但参考方程下未满足所选体验条件；请查看首字、速度及完整响应的具体限制。':limited?'模型可以装载；下面按当前架构和运行假设估算卡数与性能，实际表现待压测校准。':'装载和本次目标分开检查；下面显示满足参考方程的配置。';
    return `<section class="panel fit-diagnosis" data-diagnosis="${d.weightFits?'loadable':'weight-blocked'}"><div class="result-heading"><h2>${d.weightFits?'模型可装载':'当前搜索范围装不下模型'}</h2><span class="status-chip">${limited?'实际性能待校准':'理论装载检查'}</span></div><div class="fit-checks"><div><small>完整权重</small><strong>${f(r.weight)} GB</strong><span>显存容量下限 ${d.minimumWeightCards??'—'} 张卡</span></div><div><small>权重 + 一路峰值 KV</small><strong>${f(r.weight+r.kvSession)} GB</strong><span>${d.requestFits?'当前搜索范围内可容纳':'当前搜索范围内不可容纳'}</span></div><div><small>所选目标</small><strong>${limited?'待压测确认':r.feasible?'参考方程内满足':'参考方程内未满足'}</strong><span>${limited?'算术结果不等于实际部署表现':'先检查范围，再检查体验'}</span></div></div><p>${esc(action)}</p>${!s.multiNode?'<button data-enable-cross-node class="primary">评估跨机方案</button>':''}<button class="inline-action" data-trace="loadingCheck">装载检查怎么算</button>${limited?`<details class="performance-limits"><summary>估算依据与误差</summary><p>${esc(r.performanceEvidence.reason)}</p><p>压测不足仍提供规划；已有测试用于校准，不将其他模型或不同负载的结果直接套用。</p></details>`:''}${!r.feasible&&d.requestFits?`<p class="muted">仅一路请求的各候选最佳参考值（可能来自不同拓扑）：首 Token ${f(d.fastestSingleTTFT)} s；末端速度 ${f(d.fastestSingleSpeed)} Token/s。整批目标还需按实际副本批量检查。</p>`:''}</section>`;
  }
  function errors(r,table){return `<div class="panel"><h2>${!r.ok?'先补齐有效参数':'参考方程内未找到满足全部目标的配置'}</h2><div class="notice ${!r.ok?'error':''}">${(!r.ok?r.errors:['不是笼统的“模型跑不动”：下表逐项列出装载、KV、首 Token 与 Decode 的限制。']).map(esc).join('<br>')}</div>${r.ok?table():''}</div>`;}
  function warning(r){return `<details class="panel estimate-notes"><summary>估算边界与待核验项</summary><ul class="list-clean">${r.warnings.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`;}
  function quotePending(ctx){
    return `<section class="panel deployment-result"><h2>部署配置待核验</h2><p>该模型使用专用推理架构，当前参考计算不能确定所需卡数或采购费用。需对照相同精度、输入输出、并发和延迟的部署压测。</p></section>${comparison(ctx)}${expenses(ctx)}${warning(ctx.result)}`;
  }
  function forward(ctx){
    if(root.WorkbenchSummary)return root.WorkbenchSummary.render(ctx,chart);
    if(ctx.result.quoteBlocked)return quotePending(ctx);
    const {s,result:r,candidateTable}=ctx;if(!r.ok||!r.chosen)return diagnosis(ctx)+errors(r,candidateTable)+comparison(ctx)+expenses(ctx)+warning(r);
    const q=r.chosen,c=r.cost||{};
    const metric=s.throughputMetric==='requests'?['完整请求吞吐',q.requestsPerSecond,'请求/s']:s.throughputMetric==='decode-output'?['Decode末端总吞吐',q.decodeThroughput,'Token/s']:['完整周期总输出吞吐',q.outputThroughput,'Token/s'];
    return `${diagnosis(ctx)}<section class="panel deployment-result"><h2>${r.quoteBlocked?'全 Attention 参考配置':'资源规划结果'}</h2><div class="recommendation"><div><strong>${q.servers}</strong><span>台服务器</span><small>采购/已有 ${q.purchasedCards} 张卡</small></div><div><strong>${q.activeCards}</strong><span>张参与计算</span><small>${q.groups} 个实例 × 每实例 ${q.tp} 张</small></div><div><strong>${wan(c.capex)}</strong><span>规划采购</span><small>${ctx.D.cards[s.card].quoteStatus==='planning'?'采用旧规划报价；请填当前询价':'未知报价不影响资源计算'}</small></div></div><div class="result-bottom"><span>${metric[0]} <strong>${f(metric[1])} ${metric[2]}</strong></span><button data-trace="${s.throughputMetric==='requests'?'completedRequests':s.throughputMetric==='decode-output'?'totalDecodeThroughput':'totalOutputThroughput'}">吞吐怎么算</button></div></section>${comparison(ctx)}${timeline(ctx)}${expenses(ctx)}<div class="panel">${candidateTable()}</div>${warning(r)}`;
  }
  function reverseTargets(s){return `<div class="reverse-target-heading"><h2>想求解什么？</h2><span class="muted">固定设备，选择一个目标</span></div><div class="target-tabs" role="group" aria-label="反向求解目标">${Object.entries(root.ReverseSolver.targets).filter(([key])=>key!=='throughput').map(([key,t])=>`<button data-reverse-target="${key}" aria-pressed="${s.reverseTarget===key}" class="${s.reverseTarget===key?'selected':''}">${t.name}</button>`).join('')}</div>`;}
  function reverseControls(ctx){const target=ctx.s.reverseTarget==='throughput'?'concurrency':ctx.s.reverseTarget,t=root.ReverseSolver.targets[target];return `<section class="panel"><h2>已知条件</h2><p class="muted">${t.name}由系统求解，不作为输入。</p><div class="condition-fields">${t.conditions.filter(k=>k!=='throughput').map(ctx.field).join('')}</div>${target==='speed'||target==='ttft'?'<p class="muted">当前所求指标不作为约束，另一项体验目标仍保留。</p>':''}</section>`;}
  function reverse(ctx){
    if(ctx.result.quoteBlocked)return errors(ctx.result,ctx.candidateTable)+warning(ctx.result);
    ctx={...ctx,s:ctx.result.effectiveState||ctx.s};
    const {s,result:r,candidateTable}=ctx;if(!r.ok||!r.feasible||!r.chosen)return diagnosis(ctx)+errors(r,candidateTable)+warning(r);
    const z=r.solve,q=r.chosen,w=q.w;
    const bound=z.target==='concurrency'?`<div class="capacity-equation"><span>取三项最小值</span><strong>min(${f(z.bounds.kv)}, ${f(z.bounds.decode)}, ${f(z.bounds.prefill)}) = ${f(z.answer)} 路</strong></div><div class="capacity-limits">${[['kv','KV 显存'],['decode','Decode 速度'],['prefill','Prefill / 首 Token']].map(([k,label])=>`<button data-trace="caps" class="${z.bounds[k]===z.answer?'limiting':''}"><small>${label}</small><strong>${f(z.bounds[k])}<span> 路</span></strong><span>${z.bounds[k]===z.answer?'当前限制':'尚有余量'}</span></button>`).join('')}</div>`:'';
    return `<section class="panel solve-result"><div class="result-heading"><h2>${r.performanceEvidence?.referenceOnly?'参考情景 · ':''}${z.meta.answer}</h2><span class="status-chip">${r.performanceEvidence?.referenceOnly?'非实测容量':'满足已知条件'}</span></div><div class="answer-value">${f(z.answer)}<span>${z.meta.unit}</span></div><p class="muted">${q.groups} 个副本 × ${q.tp} 张卡，最繁忙副本 ${q.B} 路。</p>${bound}<button class="inline-action" data-trace="solveAnswer">查看这个结果的求解过程</button>${z.search?.limitHit?'<p class="notice">已到原生上下文或搜索上限，结果受此上限约束。</p>':''}</section>${warning(r)}`;
  }
  const groups=[
    ['scene','请求与上下文',['input','output','context','batch']],
    ['weight','模型权重',['weight','activeWeight']],
    ['hardware','拓扑与有效硬件能力',['topology','chosenTP','efficiency','matrixRate','attentionRate','bandwidthRate']],
    ['kv','KV Cache 与显存',['kv','kvSession','weightCardFloor','requestCardFloor','loadingCheck','usable','used']],
    ['prefill','Prefill 与首 Token',['pairs','attentionCoef','prefillMatrix','prefillAttention','prefillComputeTime','prefillTraffic','prefillMemoryTime','prefillTime','ttftResult','prefillThroughput']],
    ['decode','Decode 与完整响应',['decodeMatrix','decodeAttention','decodeComputeTime','decodeMemoryTime','decodeStep','decodeSpeed','decodeDuration','response']],
    ['capacity','并发容量、副本与整机',['caps','groups','groupBatch','union','activeCards','serverCount','purchasedCards']],
    ['local','本地采购与运营费用',['capex','power','energy','maintenanceCost','depreciation','localMonthly']],
    ['cloud','云端用量与费用',['apiPriceSource','apiFactor','apiInputPrice','apiOutputPrice','targetCycle','dailyRounds','dailyInput','dailyOutput','dailyAPI','apiMonthly']],
    ['compare','累计费用与交点',['saving','payback','localTCO','apiTCO']],
    ['solve','反向求解边界',['responseCheck','solveAnswer']]
  ];
  function calculations(ctx,opened=[]){
    if(ctx.s.mode==='reverse'&&root.ReverseCalculation)return root.ReverseCalculation.technical(ctx);
    const {result:r,labels,nodeValue}=ctx;
    const known=new Set(groups.flatMap(g=>g[2]));const list=[...groups,['other','其他计算步骤',r.trace.filter(n=>!known.has(n.id)).map(n=>n.id)]];
    let order=0;
    return list.map(([key,title,ids])=>{const nodes=ids.map(id=>r.trace.find(n=>n.id===id)).filter(Boolean);if(!nodes.length)return '';order++;
      return `<details class="calc-section" data-calc-group="${key}" ${opened.includes(key)?'open':''}><summary><span><em>${String(order).padStart(2,'0')}</em>${title}</span><small>${nodes.length} 步</small></summary><div class="calc-grid">${nodes.map(n=>`<article id="calc-${n.id}" class="calc-step" data-step="${n.id}" tabindex="-1"><div class="calc-step-header"><h3>${esc(n.title)}</h3><strong>${esc(nodeValue(n))}</strong></div><div class="formula">${esc(n.formula)}</div>${n.note?`<p>${esc(n.note)}</p>`:''}<div class="dep-links"><span>来源</span>${n.deps.map(id=>`<button ${r.trace.some(t=>t.id===id)?`data-trace="${id}"`:`data-input="${id}"`}>${esc(r.trace.find(t=>t.id===id)?.title||labels[id]||id)}</button>`).join('')}</div></article>`).join('')}</div></details>`;
    }).join('')||'<p class="muted">修正输入后，计算步骤会在这里显示。</p>';
  }
  function wireChart(){root.CostChart.mount();}
  // Single-instance wording is a rendering policy, not an extra customer input.
  function singleCopy(html){return html.replaceAll('副本','实例');}
  function explainedCalculations(ctx,opened){
    const html=calculations(ctx,opened);
    return singleCopy(root.CalculationExplain?html.replace(/(<article\b[^>]*data-step="([^"]+)"[\s\S]*?)(<div class="dep-links">)/g,(_,body,id,end)=>body+root.CalculationExplain.dependencies(ctx,ctx.result.trace.find(n=>n.id===id))+end):html);
  }
  root.WorkbenchUI={controls:ctx=>singleCopy(controls(ctx)),forward:ctx=>singleCopy(forward(ctx)),reverse:ctx=>singleCopy(reverse(ctx)),reverseTargets,reverseControls,calculations:explainedCalculations,wireChart,chartData,singleCopy};
  if(typeof module!=='undefined')module.exports=root.WorkbenchUI;
})(typeof window==='undefined'?globalThis:window);
