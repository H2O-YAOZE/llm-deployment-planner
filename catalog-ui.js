'use strict';
(function(root){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const n=(v,u='')=>Number.isFinite(v)?v+u:'待核实';
 const source=r=>/^https:\/\//.test(r.source||'')?`<a href="${esc(r.source)}" target="_blank" rel="noopener noreferrer">${r.sourceType==='official'?'官方资料':'资料来源'}</a>`:esc(r.source||'无准确来源');
 function performanceSources(D,m){
  const p=D.performanceBenchmarks;if(!p)return '';
  const rows=p.records.filter(r=>r.modelId===m.id),starts=p.deployments.filter(r=>r.modelId===m.id),partial=p.incomplete.filter(r=>r.modelId===m.id);
  if(!rows.length&&!starts.length&&!partial.length)return '';
  const sources=[...new Set([...rows,...starts,...partial].map(r=>r.source))];
  return `<details><summary>公开性能依据：${rows.length} 个压测工作点</summary><p>${starts.length} 条部署起点，${partial.length} 条条件未齐的测试讨论。已核对 Token/s 口径；不自动外推卡数或修改效率。核验 ${esc(p.checkedAt)}。</p>${sources.map((url,i)=>`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">依据 ${i+1}</a>`).join(' · ')}</details>`;
 }
 function render(D,tab){
  let headers,rows;
  if(tab==='models'){
   headers=['统一ID / 模型','参数 总 / 激活','结构 / 精度','本地与服务上下文','关联API / 核验情况'];
   rows=Object.values(D.models).map(m=>[
    `<strong>${esc(m.name)}</strong><small>${esc(m.id)} · ${esc(m.vendor)}</small>`,n(m.totalParamsB,'B')+' / '+n(m.activeParamsB,'B'),
    `${n(m.layers,'层')} · ${esc(m.attentionType)}<small>${esc(m.supportedPrecisions.join(' · '))||'精度待核实'}</small>`,
    `本地原生 ${n(m.nativeContextTokens,' Token')}<br>扩展 ${n(m.extendedContextTokens,' Token')}<br>服务声明 ${n(m.contextTokens,' Token')}`,
    `${m.apiIds.map(id=>esc(D.apiPrices[id].name)).join('<br>')||'直连API待核实'}<details><summary>${m.resourceEstimate?'架构参考估算，误差可能较大':m.catalogOnly?'本地测算缺少必要数据':m.cacheProfile?.kind==='reference'?'架构替代估算，误差待校准':'资源规划可估算'} · ${esc(m.verificationStatus)}</summary><p>${source(m)} ${m.configSource?`<a href="${esc(m.configSource)}" target="_blank" rel="noopener noreferrer">官方配置</a>`:''}</p><p>核验 ${esc(m.checkedAt)} · 发布 ${esc(m.releaseDate)} · 许可 ${esc(m.license)}</p><p>${esc(m.resourceEstimate?.note||m.note)}</p>${m.radarClaims?`<p>附带雷达声明（非自动报价）：${esc(m.radarClaims.priceSrc)}，${esc(m.radarClaims.priceNote)}</p>`:''}</details>${performanceSources(D,m)}`]);
  }else if(tab==='cards'){
   headers=['统一ID / 芯片','内存 / 带宽 / 功率','矩阵稠密峰值','报价与规格状态','来源与边界'];
   rows=Object.values(D.cards).map(c=>[
    `<strong>${esc(c.name)}</strong><small>${esc(c.id)} · ${esc(c.vendor)}</small>`,`${n(c.memoryGB,' GB')} / ${n(c.bandwidthGBs,' GB/s')}<small>${n(c.tdpW,' W')} · ${esc(c.memoryType)}</small>`,
    Object.entries(c.computeTflops).map(([k,v])=>`${esc(k)}: ${n(v,k==='int8'?' TOP/s':' TFLOP/s')}`).join('<br>')||'对应精度峰值待核实，请填实机/官方值',
    `${c.quoteStatus==='planning'?n(c.cardPriceWan,' 万元（旧规划假设）'):'待询价'}<small>平台 ${n(c.platformPriceWan,' 万元')}<br>${c.sourceGaps?.length?'部分规格待补一手依据':esc(({pending:'规格待核实','official-spec':'已有官方规格',preliminary:'官方初步规格','official-variants-unmapped':'变体与SKU尚未对应'})[c.specStatus]||c.specStatus)} · 报价核验 ${esc(c.quoteCheckedAt||'尚未询价')}</small>`,
    `${source(c)}<details><summary>精度与部署限制</summary><p>${esc(c.precisions.join(' · '))}</p><p>${esc(c.note)}</p>${(c.sourceGaps||[]).map(g=>`<p>待核实：${esc(g)}</p>`).join('')}<p>${esc(c.interconnect)}</p><p>核验 ${esc(c.checkedAt)}。运算格式不证明模型内核可用。</p></details>`]);
  }else{
   headers=['服务 / 精确模型映射','原币输入 未命中 / 命中 / 输出','长度阶梯与上下文','缓存 / 费用 / 日期','来源'];
   rows=Object.values(D.apiPrices).filter(a=>!a.legacy).map(a=>[
    `<strong>${esc(a.name)}</strong><small>${esc(a.endpoint)}<br>模型ID ${esc(a.modelIds.join(', '))}</small>`,
    `${esc(a.currency)} / 百万 Token<br>${n(a.native?.miss)} / ${n(a.native?.hit)} / ${n(a.native?.out)}`,
    `${(a.tiers||[]).map(t=>`输入≤${n(t.maxInputTokens)}${t.maxOutputTokens?'、输出≤'+n(t.maxOutputTokens):''}：${n(t.miss)} / ${n(t.hit)} / ${n(t.out)}`).join('<br>')||'无已核实阶梯'}${a.longContextPrices?`<br>长档：${n(a.longContextPrices.miss)} / ${n(a.longContextPrices.hit)} / ${n(a.longContextPrices.out)}，阈值待核实`:''}<small>服务上下文 ${n(a.contextTokens)} · 最大输出 ${n(a.maxOutputTokens)}${a.outputLimitRange?'（声明范围 '+a.outputLimitRange.join('…')+'）':''}<br>${esc(a.tierUnitStatus||'精确Token以服务文档为准')}</small>`,
    `核验 ${esc(a.checkedAt)}${a.peakPricing?'<br>峰价 ×2；按峰时Token占比加权':''}${a.validUntil?'<br>有效期 '+esc(a.validUntil):''}<details><summary>缓存与费用细则</summary><p>写入 ${esc(JSON.stringify(a.cacheWrite||{}))} · ${esc(a.cacheWriteBilling||'规则待核实')}</p><p>存储 ${n(a.cacheStoragePerMTokenHour)} / 百万Token·小时</p><p>${esc(a.note)}</p><p>额外费用 ${esc(JSON.stringify(a.extraFees||{}))}</p></details>`,source(a)]);
  }
  return `<div class="notice">统一目录 ${esc(D.catalogVersion)} · 本轮修订 ${esc(D.checkedAt)}；逐项核验日期见记录。本页、选项和计算器读取同一份 catalog.json；未知值留空。<a href="CATALOG-REVIEW-20261002.md" target="_blank">本轮数据核对</a> · <a href="REVIEW-20261002.md" target="_blank">计算与界面修正</a></div><div class="panel"><div class="data-tabs">${[['models','模型参数'],['cards','GPU / NPU'],['api','API 输入 / 输出价格']].map(([id,label])=>`<button data-data-tab="${id}" class="${tab===id?'selected':''}">${label}</button>`).join('')}</div><input class="catalog-search" id="catalog-search" placeholder="搜索模型、芯片、精度或来源…" aria-label="搜索目录"><p class="muted">本页显示原币刊例；推演中美元按可编辑汇率折算人民币。K显示=1000；服务K换算不确定的边界暂停自动选档。</p><div class="table-wrap"><table id="catalog-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map((cell,i)=>`<td data-label="${esc(headers[i])}">${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div><div class="panel"><h2>仍需确认的资料</h2><ul>${D.unresolved.map(x=>`<li>${esc(x)}</li>`).join('')}</ul><a href="catalog.json" target="_blank">下载统一目录 JSON</a></div>`;
 }
 function updates(D){
  const s=D.dataSync||{},fmt=v=>v?esc(new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})):'尚无自动更新记录';
  const groups=[['cards','GPU / NPU'],['models','模型'],['apiPrices','API 费用']],changes=s.lastChanges||{};
  return `<section class="panel catalog-update" aria-label="数据更新记录"><div class="catalog-update-heading"><div><h2>数据更新</h2><p class="muted">最近检查：${fmt(s.lastAttemptAt)}</p><p class="muted">最近实际更新：${fmt(s.lastUpdatedAt)}</p></div><span class="catalog-update-status">${({success:'检查完成',partial:'部分来源待核验',failed:'检查失败'})[s.status]||'自动检查尚未运行'}</span></div><div class="catalog-update-groups">${groups.map(([key,label])=>`<div><span>${label}</span><strong>${changes[key]?.length?esc(changes[key].map(x=>x.name).join('、')):'暂无已确认变化'}</strong></div>`).join('')}</div><div class="catalog-sync-actions"><button id="catalog-sync-start" type="button">手动抓取 · 近两个月</button><span id="catalog-sync-message" role="status" aria-live="polite"></span><button id="catalog-sync-reload" type="button" hidden>刷新使用新目录</button></div><details><summary>检查时间与来源${s.pending?.length?' · '+s.pending.length+' 项待核验':''}</summary><p>最近检查：${fmt(s.lastAttemptAt)}。每 ${esc(s.intervalDays||10)} 天检查官方数据；硬件采购报价由你维护。</p>${s.coverage?`<p>官方来源 ${esc(s.coverage.fetched)} / ${esc(s.coverage.officialSources)} 个读取成功；${esc(s.coverage.uncoveredRecords)} 条记录尚无可自动读取的官方来源。</p>`:''}${s.lastSuccessfulCheckAt?`<p>最近完整成功检查：${fmt(s.lastSuccessfulCheckAt)}</p>`:''}${(s.pending||[]).map(p=>`<p><strong>${esc(p.name)}</strong> · ${esc(p.reason)}${/^https:\/\//.test(p.source||'')?` · <a href="${esc(p.source)}" target="_blank" rel="noopener noreferrer">来源</a>`:''}</p>`).join('')}${(s.errors||[]).map(p=>`<p>读取或解析未完成：${esc(p.source)} · ${esc(p.reason)}</p>`).join('')}</details></section>`;
 }
 root.CatalogUI={render:(D,tab)=>updates(D)+render(D,tab)};
})(typeof window==='undefined'?globalThis:window);
