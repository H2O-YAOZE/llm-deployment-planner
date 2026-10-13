'use strict';
// Compact presentation. Constraint plans use the same engine, inputs and topology search.
(function(root){
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const f=n=>Number.isFinite(n)?new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(n):'未知';
  const money=n=>Number.isFinite(n)?'¥ '+f(n):'未知';
  const wan=n=>Number.isFinite(n)?f(n/10000)+' 万':'未知';
  function packing(ctx,q){
    const slots=ctx.s.slots;
    if(q.tp<=slots){
      const perServer=Math.floor(slots/q.tp);
      return {formula:`⌈${f(q.groups)} ÷ ${f(perServer)}⌉ = ${f(q.servers)} 台`,note:`每台 ${f(slots)} 张卡，可放 ⌊${f(slots)} ÷ ${f(q.tp)}⌋ = ${f(perServer)} 个实例；服务器数向上取整。`};
    }
    const exact=q.tp%slots===0,perInstance=exact?`${f(q.tp)} ÷ ${f(slots)}`:`⌈${f(q.tp)} ÷ ${f(slots)}⌉`;
    return {formula:`${q.groups===1?'':f(q.groups)+' × ('}${perInstance}${q.groups===1?'':')'} = ${f(q.servers)} 台`,note:`每台 ${f(slots)} 张卡；每实例占 ${f(Math.ceil(q.tp/slots))} 台，${f(q.groups)} 个实例分别布置。${exact?'':'不足一台也按一台配置。'}`};
  }
  const cache=new WeakMap();
  const constraints=[
    {id:'memory',title:'显存 · 上下文与并发',ignore:['ttft','speed','throughput'],note:'保留全部输入、输出和并发，只检查显存容量；首 Token 与生成速度暂不限制。'},
    {id:'prefill',title:'Prefill · 首 Token',ignore:['speed','throughput'],note:'保留全部输入、输出和并发，同时满足显存与首 Token 目标；生成速度暂不限制。'},
    {id:'decode',title:'Decode · 单路吞吐',ignore:['ttft','throughput'],note:'保留全部输入、输出和并发，同时满足显存与单路生成速度；首 Token 暂不限制。'}
  ];
  function plans(ctx){
    if(cache.has(ctx.result))return cache.get(ctx.result);
    const out=constraints.map(item=>{
      const options={performanceOnly:true,ignoreTargets:item.ignore};
      const raw=ctx.E.calculate({...ctx.s,mode:'forward'},ctx.D,options);
      const result=ctx.E.withFinancials(raw,{...ctx.s,mode:'forward'},ctx.D);
      return {...item,result,ctx:{...ctx,result,s:{...ctx.s,mode:'forward'}}};
    });
    cache.set(ctx.result,out);return out;
  }
  function constraintContext(ctx){
    const r=ctx.result,items=plans(ctx),memory=items[0].result.chosen;
    const reference=(r.candidates||[]).find(q=>q.id===memory?.id)||(r.candidates||[]).find(q=>q.id===r.diagnostics?.requestLayout);
    return items.map(p=>{
      const selected=p.result.chosen,kind={memory:'kv',prefill:'ttft',decode:'decode'}[p.id];
      const proof=reference?.proof[kind];
      const inherited=p.id!=='memory'&&selected&&memory&&selected.id===memory.id&&selected.groups===memory.groups&&selected.purchasedCards===memory.purchasedCards;
      const capacity=proof?.inactive?null:proof?.cap;
      let description=reference&&capacity!==undefined&&capacity!==null?`按 ${f(reference.tp)} 卡估算：${proof.capped?'至少可承接':'最多可承接'} ${f(capacity)} 路`:'';
      if(proof?.inactive)description='本次仅生成首 Token，不约束 Decode 速度';
      if(inherited){
        const limit=Number.isFinite(capacity)&&capacity>=ctx.s.concurrency;
        description+=description?'；':'';
        description+=limit?'沿用显存配置，无需加卡':'与显存选型相同，无额外整机';
      }
      return {...p,referenceTP:reference?.tp,capacity,inherited,description};
    });
  }
  const process=(id,label)=>`<button class="process-link" data-trace="${id}" aria-label="查看${esc(label)}计算过程">计算过程 <span aria-hidden="true">↘</span></button>`;
  function apiValues(ctx){
    const {s,result:r}=ctx,a=r.apiBudget||root.ApiPricing.budget(s,ctx.D),c=r.cost||{};
    const manual=s.costMode==='manual'&&Number.isFinite(s.manualDaily)&&s.manualDaily>=0?s.manualDaily*s.days:null;
    const monthly=Number.isFinite(manual)?manual:Number.isFinite(c.apiMonthly)?c.apiMonthly:a.ok?a.monthly:null;
    const range=s.costMode==='manual'?null:r.apiMonthlyRange||a.monthlyRange;
    return {a,monthly,range};
  }
  function api(ctx){
    const {s,D}=ctx,{a,monthly,range}=apiValues(ctx),manual=s.costMode==='manual';
    const known=Number.isFinite(monthly)||!!range;
    const text=range?range.map(money).join(' ～ '):money(monthly);
    const prices=a.quote||{};
    const detail=manual?`每日账单 ${money(s.manualDaily)} × ${f(s.days)} 天`:
      known?`输入 ${f(prices.inputPrice)} · 输出 ${f(prices.outputPrice)} 元 / 百万 Token`:'在左侧选择 API 模型或填写输入、输出单价。';
    return `<section class="panel api-summary" data-overview="api"><div class="summary-heading"><h2><span class="section-no">01</span>云端 API 月费</h2>${process('api-budget','API 月费')}</div><div class="api-primary"><strong data-cost="api-monthly">${text}</strong><span>${esc(manual?'已填账单':D.apiPrices[s.api]?.name||'未选择 API 模型')}</span></div><p class="summary-note">${detail}</p>${manual?'':'<p class="summary-note">每天 12 小时满载，每次用满输入与输出；每月 30 天。</p>'}${!manual&&!a.ok&&s.api?`<p class="summary-alert">${esc(a.errors[0])}</p>`:''}${!manual&&s.api&&!D.apiPrices[s.api]?.modelIds?.includes(s.model)?'<p class="summary-alert">所选 API 与本地模型不同，费用仅作预算对照。</p>':''}</section>`;
  }
  function local(ctx){
    const {s,result:r,D}=ctx,q=r.chosen,c=r.cost||{};
    const rows=constraintContext(ctx).map(p=>{
      const x=p.result.chosen;
      const value=p.id==='memory'?`${f(s.concurrency)} 路 · ${f(s.inputK)}K 输入 + ${f(s.outputK)}K 输出`:
        p.id==='prefill'?`首 Token ≤ ${f(s.ttft)} s`:`每路 ≥ ${f(s.speed)} Token/s`;
      return `<tr data-sizing="${p.id}" data-inherited="${!!p.inherited}"><th scope="row">${p.title}<small>${value}</small>${p.description?`<small class="sizing-impact">${p.description}</small>`:''}</th><td data-sizing-cards>${x?`<strong>${p.inherited?'沿用':'运行'} ${f(x.activeCards)} 张</strong><small>采购 ${f(x.purchasedCards)} 张 · ${f(x.servers)} 台</small>`:'未找到配置'}</td><td data-sizing-cost>${wan(p.result.cost?.capex)}</td><td>${process('sizing-'+p.id,p.title)}</td></tr>`;
    }).join('');
    const floor=r.diagnostics?.minimumWeightCards;
    const floorText=floor!==undefined?`权重 ${f(r.weight)} GB，纯容量下限 ${f(floor)} 张卡；实际配置还需满足上下文、速度和整机卡位。`:'模型与精度决定完整权重，输入、输出和并发决定请求状态占用。';
    return `<section class="panel local-summary deployment-result" data-overview="local"><div class="summary-heading"><h2><span class="section-no">02</span>本地部署选型</h2><button class="process-link" data-input="slots" aria-label="修改每台装卡数">每台 ${f(s.slots)} 张卡</button></div><p class="model-line">${esc(D.models[s.model]?.name||s.model)} <span>· ${esc(D.cards[s.card]?.name||s.card)} · ${esc(ctx.E.precision[s.precision]?.name||s.precision)}</span></p><p class="weight-line">${floorText}${r.trace?.some(n=>n.id==='weightCardFloor')?process('weightCardFloor','权重容量下限'):''}</p><div class="sizing-table-wrap"><table class="sizing-table"><thead><tr><th>需要满足的条件</th><th>卡数 / 台数</th><th>采购费用</th><th><span class="sr-only">计算依据</span></th></tr></thead><tbody>${rows}<tr class="final-sizing" data-sizing="final"><th scope="row">同时满足全部条件<small>卡数按综合约束选型</small></th><td>${q?`<strong>${f(q.purchasedCards)} 张</strong><small>${f(q.servers)} 台 · ${f(s.slots)} 张/台</small>`:'未找到配置'}</td><td><strong data-cost="capex">${wan(c.capex)}</strong></td><td>${q?process('serverCount','最终配置'):''}</td></tr></tbody></table></div>${q?`<div class="selected-performance"><span>首 Token <strong>${f(q.w.ttft)} s</strong></span><span>单路生成 <strong>${r.O>1?f(q.w.speed)+' Token/s':'仅首 Token'}</strong></span><span>总输出吞吐 <strong>${f(q.outputThroughput)} Token/s</strong></span></div><p class="summary-note">${packing(ctx,q).formula}。${f(q.groups)} 个实例 × ${f(q.tp)} 张卡 / 实例，承接 ${f(s.concurrency)} 路并发。${q.activeCards!==q.purchasedCards?`实际参与 ${f(q.activeCards)} 张卡。`:''}各行是单项选型，最终卡数不相加。</p>`:`<p class="summary-alert">${esc(!r.ok?r.errors.join('；'):'当前搜索范围未找到满足全部条件的配置，展开下方过程查看限制。')}</p>`}<p class="quote-note">性能与台数为估算${r.performanceEvidence?.servingPlanning?'，已参考同模型、FP8、H200公开测试修正':''}，不代表实机已达标。${D.cards[s.card]?.quoteStatus==='planning'?'采用目录规划报价，可填写当前询价。':''}</p>${q&&!Number.isFinite(c.capex)&&r.financeErrors?.length?`<p class="summary-alert">${esc(r.financeErrors[0])}</p>`:''}</section>`;
  }
  function curve(ctx,chart){
    const {s,result:r}=ctx,c=r.cost||{},{monthly,range}=apiValues(ctx);
    const ready=[c.capex,c.energy,c.maintenance,monthly].every(n=>Number.isFinite(n)&&n>=0);
    const reason=!Number.isFinite(monthly)?range?'API 单价仍有档位范围，选定价格后显示曲线。':'API 单价未齐，补齐后显示与本地的费用曲线。':!Number.isFinite(c.capex)?'本地配置或报价未齐，补齐后显示费用曲线。':'本地电费或维护参数未齐，补齐后显示费用曲线。';
    return `<section id="cost-comparison" class="panel cost-chart-panel compact-comparison" data-overview="curve" data-comparison="${c.comparable?'validated':'budget'}"><div class="summary-heading"><h2><span class="section-no">03</span>API vs 本地部署</h2><span class="summary-label">${f(s.years)} 年累计费用</span></div>${ready?chart({...c,apiMonthly:monthly},s):`<p class="comparison-pending">${reason}</p>`}<p class="summary-note">本地累计支出 = 采购 + 电费 + 维护。${!c.comparable?'费用按当前预算对照，实际服务能力仍需验证。':''}</p></section>`;
  }
  function render(ctx,chart){return api(ctx)+local(ctx)+curve(ctx,chart);}
  function proofRow(title,formula,result){return `<div class="budget-equation"><span>${title}</span><code>${formula}</code><strong>${result}</strong></div>`;}
  function apiProof(ctx){
    const {s}=ctx,{a,monthly,range}=apiValues(ctx),q=a.quote||{};
    const manual=s.costMode==='manual';
    const unit=n=>f(n);
    const cycle=s.ttft+(a.O>1?(a.O-1)/s.speed:0);
    const budgetBody=manual?proofRow('月 API 账单',`${money(s.manualDaily)} × ${f(s.days)} 天`,money(monthly)):
      proofRow('单轮目标周期',a.O>1?`${f(s.ttft)} + (${f(a.O)} − 1) ÷ ${f(s.speed)}`:`${f(s.ttft)}（只输出首 Token）`,f(cycle)+' s')+
      proofRow('每日完整请求',`${f(s.concurrency)} × ${f(s.usageHours)} × 3,600 × ${f(s.dutyCycle)} ÷ ${f(cycle)}`,f(a.rounds)+' 次')+
      proofRow('每日输入量',`${f(a.rounds)} × ${f(a.I)}`,f(a.dailyIn)+' Token')+
      proofRow('每日输出量',`${f(a.rounds)} × ${f(a.O)}`,f(a.dailyOut)+' Token')+
      (range?Object.keys(q.priceRange||{}).map((band,i)=>{
        const quote=root.ApiPricing.quote({...s,apiContextBand:band},ctx.D,a.I,a.O);
        return proofRow('月 API 费用 · '+esc(band),`((${f(a.dailyIn)} × ${f(quote.inputPrice)} + ${f(a.dailyOut)} × ${f(quote.outputPrice)}) ÷ 1,000,000 + ${f(quote.storagePerDay)}) × ${f(s.days)}`,money(range[i]));
      }).join(''):
      proofRow('每日 API 费用',`(${f(a.dailyIn)} × ${unit(q.inputPrice)} + ${f(a.dailyOut)} × ${unit(q.outputPrice)}) ÷ 1,000,000 + ${f(q.storagePerDay)}`,Number.isFinite(monthly)?money(monthly/s.days):'未知'))+
      proofRow('月 API 费用',`每日费用 × ${f(s.days)} 天`,range?range.map(money).join(' ～ '):money(monthly))+
      `<details class="proof-extra"><summary>查看有效单价与价格来源</summary><p>有效输入价 ${f(q.inputPrice)}、输出价 ${f(q.outputPrice)} 元 / 百万 Token。输入按缓存命中 ${f(s.apiCache*100)}%、缓存写入 ${f(s.cacheWriteShare*100)}% 与服务计费规则加权；峰谷倍率 ${f(q.factor)}，美元价按汇率 ${f(s.apiFx)} 换算。额外工具、检索和媒体调用按实际另计。</p><p>${esc(ctx.D.apiPrices[s.api]?.source||'手动单价，无官方价格来源')}</p></details>`;
    return `<details id="overview-api-budget" class="sizing-proof" tabindex="-1"><summary>云端 API 月费计算 <strong>${range?range.map(money).join(' ～ '):money(monthly)}</strong></summary><div class="proof-body">${budgetBody}${!manual&&!a.ok?`<p class="summary-alert">${esc(a.errors.join('；'))}</p>`:''}<p class="summary-note">显示值经过取整，计算使用完整精度。每天 12 小时满载，每次用满填写的输入、输出。</p></div></details>`;
  }
  function planBranch(p){
    const r=p.result,q=r.chosen,ctx=p.ctx,X=root.CalculationExplain;
    const title={memory:'显存：能不能装下',prefill:'首 Token：能否及时回答',decode:'Decode：生成能否跟上'}[p.id];
    const heading=`<header class="core-branch-heading"><h3>${title}</h3><span class="core-check ${q?'pass':'fail'}">${q?'满足':'未找到配置'}</span></header>`;
    if(!q)return `<section id="overview-sizing-${p.id}" data-core="${p.id}" class="core-branch" tabindex="-1">${heading}<p class="summary-alert">${esc(r.ok?'当前搜索范围内没有满足本项条件的配置。':r.errors.join('；'))}</p></section>`;
    const equations=X.equations(ctx).filter(row=>row.section===p.id);
    const renderRows=rows=>rows.map(row=>`<div class="core-equation" id="overview-${row.id}" data-equation="${row.id}" tabindex="-1"><div class="equation-name">${esc(row.title)}</div>${X.renderEquation(ctx,row)}</div>`).join('');
    const candidates=r.candidates.map(x=>`<tr class="${x===q?'chosen':''}"><td>${f(x.tp)}<small>Attention TP ${f(x.attentionTP)} / DP ${f(x.attentionDP)}</small></td><td>${f(x.groups)}</td><td>${f(x.B)}</td><td>${x.valid?f(x.purchasedCards):'不可行'}</td><td>${x.valid?'满足本项约束':[!x.w.fits?'显存不足':'',!x.w.ttftOK?'首 Token 超时':'',!x.w.speedOK?'速度不足':''].filter(Boolean).join('、')||'无可行实例'}</td></tr>`).join('');
    const packed=packing(ctx,q);
    const price=proofRow('采购费用',`(${f(q.purchasedCards)} × ${f(ctx.s.cardWan)} + ${f(q.servers)} × ${f(ctx.s.platformWan)}) × 10,000`,money(r.cost?.capex));
    const target=p.id==='prefill'?`目标 ≤ ${f(ctx.s.ttft)} s · 估算 ${f(q.w.ttft)} s`:p.id==='decode'?r.O>1?`目标 ≥ ${f(ctx.s.speed)} Token/s · 估算 ${f(q.w.speed)} Token/s`:'仅输出首 Token，无 Decode 阶段':'';
    const mainIds={memory:['weight','storedWeight','context','kvSession','requestCacheTotal','allInstanceWeight','actualMemoryTotal'],prefill:['prefillInputTotal','ttftResult'],decode:['decodeStep','decodeSpeed']}[p.id];
    const main=mainIds.filter(id=>id!=='storedWeight'||q.attentionDP>1).filter(id=>id!=='allInstanceWeight'||q.groups>1).map(id=>equations.find(row=>row.id===id)).filter(Boolean),extra=equations.filter(row=>!main.some(x=>x.id===row.id));
    const durations=p.id==='memory'?'':`<div class="duration-pair">${(p.id==='prefill'?['prefillComputeTime','prefillMemoryTime']:['decodeComputeTime','decodeMemoryTime']).map(id=>{const row=equations.find(row=>row.id===id);return row?X.token({...ctx,explanationRows:[row]},id,row.result.value,id.endsWith('ComputeTime')?'计算用时':'搬运用时',row.result.unit):'';}).join('')}</div><p class="summary-note">计算和搬运取较慢的一项。</p>`;
    return `<section id="overview-sizing-${p.id}" data-core="${p.id}" class="core-branch" tabindex="-1">${heading}<p class="summary-note"><strong>${f(q.purchasedCards)} 张 · ${f(q.servers)} 台</strong><br>每台 ${f(ctx.s.slots)} 张：${packed.formula}<br></p>${selection(ctx,true)}${target?`<p class="summary-note">${target}</p>`:''}${p.id==='memory'?'':`<p class="summary-note">每套 ${q.tp} 张卡共同处理 ${q.B} 路；${q.attentionDP} 个内部处理组，最忙组 ${q.w.attentionBatch} 路。${p.id==='prefill'?'读取每路输入，计算参数与上下文关系，再等待首个 Token。':'每步给各路生成一个 Token；按输出末端的最长历史检查速度。'}</p>`}${renderRows(main.filter(row=>row.id==='prefillInputTotal'))}${p.id==='memory'?'':`<div class="duration-pair">${X.token(ctx,'matrixRate',q.w.matrix/1e12,'本套参数算力',ctx.E.precision[ctx.s.precision].compute==='int8'?'TOP/s':'TFLOP/s')}${X.token(ctx,'bandwidthRate',q.w.bw/1e9,'本套显存带宽','GB/s')}</div><p class="summary-note">已扣利用率和协作损失；组内 Attention 按分配到的资源计算。</p>`}${durations}${renderRows(main.filter(row=>row.id!=='prefillInputTotal'))}${p.id==='memory'?`<p class="summary-note">总量之外还要逐组装得下：最忙组需要 ${f(q.w.used/q.attentionDP)} GB ≤ 每组可用 ${f(q.w.usable/q.attentionDP)} GB。${q.w.cacheBatch>q.B?`每套实际 ${q.B} 路，容量折合 ${q.w.cacheBatch} 份：按 ${q.attentionDP} 组各容纳 ${q.w.attentionBatch} 路折算的容量，不是实际请求数。`:''}</p>`:''}<details class="core-assumptions"><summary>查看工作量、代入参数与卡数依据</summary><p class="summary-note">${p.note}</p>${renderRows(extra)}${proofRow('台数换算',packed.formula,packed.note)}${proofRow('实例与运行卡',`${f(q.groups)} × ${f(q.tp)} 张`,f(q.allocatedCards)+' 张')}${price}<details class="proof-extra"><summary>查看本项选型候选</summary><div class="table-wrap"><table><thead><tr><th>每实例卡数</th><th>实例数</th><th>最忙并发</th><th>整机卡位</th><th>检查结果</th></tr></thead><tbody>${candidates}</tbody></table></div></details></details></section>`;
  }
  function proofs(ctx){return ctx.s.mode==='reverse'?'':apiProof(ctx);}
  function selection(ctx,compact=false){
    const r=ctx.result,q=r.chosen,s=ctx.s;if(!q||!r.feasible)return '';
    const valid=r.candidates.filter(a=>a.valid).sort((a,b)=>ctx.E.comparePlans(a,b,s));
    const price=a=>ctx.E.procurement(a,s),same=valid.filter(a=>a.id!==q.id&&(price(q)!==null?price(a)===price(q):a.purchasedCards===q.purchasedCards));
    const seen=new Set([q.tp]),others=valid.filter(a=>{if(a.id===q.id||seen.has(a.tp))return false;seen.add(a.tp);return true;});
    const examples=[q,...others.slice(0,3),...(!others.length&&same.length?[same[0]]:[])];
    const span=Math.ceil(q.tp/s.slots),kind=price(q)===null?'采购卡数最少':'服务器采购额最低';
    const rule=same.length?'存在同价或同卡数方案；依次优先每实例跨机台数少、实例数少，再比较用卡和权重。这个次序不代表实测速度更快。':'当前候选按服务器采购额比较；未报价时仅比较卡数。';
    const summary=`同一模型运行 ${q.groups} 套，每套 ${q.tp} 张卡${span>1?`、占 ${span} 台服务器`:'、在单台内运行'}；共接 ${s.concurrency} 路，最忙一套接 ${q.B} 路。${q.attentionDP>1?`每套内部 ${q.attentionDP} 个处理组，每组分配 ${f(q.w.layout.attentionCards)} 张卡的资源。`:''}`;
    return `<div class="deployment-choice"><p class="summary-note">${summary}</p><details class="core-assumptions forward-selection"><summary>为什么选 ${q.groups} 个实例、每实例 ${q.tp} 张卡？</summary><p>已检查 ${r.candidates.length} 种分组，其中 ${valid.length} 种满足${compact?'本栏约束':'全部需求'}；当前方案${kind}。${rule}</p><div class="layout-comparison"><table><thead><tr><th>分卡方式</th><th>采购卡数 / 台数</th><th>服务器采购额</th>${compact?'':'<th>首 Token / 单路速度</th>'}</tr></thead><tbody>${examples.map(a=>`<tr${a.id===q.id?' class="selected-layout"':''}><td>${a.groups} 套 × ${a.tp} 张${a.id===q.id?' · 选中':''}<small>每套最多分配 ${a.B} 路 · 内部 ${a.attentionDP} 组</small></td><td>${a.purchasedCards} 张 / ${a.servers} 台</td><td>${wan(price(a))}</td>${compact?'':`<td>${f(a.w.ttft)} s / ${a.w.speed===null?'仅首 Token':f(a.w.speed)+' Token/s'}</td>`}</tr>`).join('')}</tbody></table></div><p>固定当前模型、精度、芯片和需求，只比较已枚举的同规格实例、均衡分配请求；单实例最多 ${s.maxTP} 张卡。服务器报价之外的网卡、交换机及布线未计入，跨机速度采用效率假设。</p></details></div>`;
  }
  function calculations(ctx){
    const X=root.CalculationExplain;
    if(ctx.s.mode!=='forward')return X.render(ctx);
    const tail=ctx.result.ok&&ctx.result.chosen?X.render(ctx,{sectionsOnly:true}):{throughput:'<section class="core-branch core-throughput" data-core="throughput"><h3>响应与吞吐怎么算</h3><p class="summary-note">综合配置成立后显示。</p></section>',conclusion:''};
    return proofs(ctx)+selection(ctx)+'<p class="summary-note">前三栏对应上方各项选型；响应与吞吐采用最终综合配置。</p><div class="core-branches core-four-columns">'+plans(ctx).map(planBranch).join('')+tail.throughput+'</div>'+tail.conclusion;
  }
  root.WorkbenchSummary={render,proofs,calculations,plans,constraintContext,apiValues,packing};
  if(typeof module!=='undefined')module.exports=root.WorkbenchSummary;
})(typeof window==='undefined'?globalThis:window);
