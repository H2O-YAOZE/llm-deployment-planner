'use strict';
(function(root){
  const finite=n=>typeof n==='number'&&Number.isFinite(n);
  function matchingApis(model,D){return Object.values(D.apiPrices).filter(a=>!a.legacy&&a.modelIds?.includes(model));}
  function defaultApi(model,D){return matchingApis(model,D).find(a=>a.status==='verified')?.id||matchingApis(model,D)[0]?.id||'';}
  function quote(s,D,I,O,now=Date.now()){
    const a=D.apiPrices[s.api],errors=[],warnings=[];
    if(!a)return {ok:false,errors:['该模型没有已匹配的API服务；本地资源计算仍可使用。'],warnings,matched:false};
    const matched=a.modelIds?.includes(s.model)||false;
    if(!matched)warnings.push('API与本地模型版本不一致，不能输出同模型节省额或回本期。');
    if(a.validUntil&&now>=Date.parse(a.validUntil))errors.push('该API价格已到期，请更新常规价。');
    if(a.contextTokens&&I+O>a.contextTokens)errors.push('API输入与全部生成Token超过服务上下文上限。');
    if(a.maxOutputTokens&&O>a.maxOutputTokens)errors.push('API输出超过该endpoint的最大输出上限。');
    if(a.outputLimitRange&&O>a.outputLimitRange[1])errors.push('API输出超过官方声明范围的最大可能上限。');
    if(a.outputLimitRange&&O>a.outputLimitRange[0]&&O<=a.outputLimitRange[1])errors.push('API输出处于K换算未核实的边界范围，暂停确定账单。');
    if(a.concurrencyLimit&&s.concurrency>a.concurrencyLimit)errors.push('请求并发超过该API服务的并发限额。');
    if(!a.contextTokens)warnings.push('API服务上下文上限尚未核实，价格不证明可承接该请求。');
    if(!a.maxOutputTokens)warnings.push('API最大输出尚未取得精确服务限额。');
    const fromCatalog=s.apiUseCatalog!==false;
    let native=a.native||{hit:a.hit,miss:a.miss,out:a.out},tier=null;
    let completePrice=true,priceRange=null;
    if(fromCatalog&&a.tiers?.length){
      tier=a.tiers.find(t=>I<=t.maxInputTokens&&(t.maxOutputTokens===undefined||O<=t.maxOutputTokens));
      if(!tier)errors.push('没有覆盖本次输入/输出长度的已核实价格档。');
      else native=tier;
      if(a.tierUnitStatus==='K-base-unconfirmed'){
        const binaryTier=a.tiers.find(t=>I<=t.maxInputTokens*1.024&&(t.maxOutputTokens===undefined||O<=t.maxOutputTokens*1.024));
        if(binaryTier!==tier)errors.push('请求处于价格档K单位未确定的边界，不能自动选档。');
      }
    }
    if(fromCatalog&&a.longContextPrices&&a.longContextThreshold===null){
      if(s.apiContextBand==='long')native=a.longContextPrices;
      else if(s.apiContextBand!=='short')priceRange={short:{...native},long:{...a.longContextPrices}};
      completePrice=false;
      warnings.push('长上下文阈值未知；所选短/长档仅为预算情景。自动模式显示两档范围，不输出确定回本。');
    }
    if(fromCatalog&&a.maxPricedInputTokens&&I>a.maxPricedInputTokens)errors.push('该长度的价格或长上下文触发阈值待核实，不用短输入价格外推。');
    const fx=a.currency==='USD'?(s.apiFx??a.fx??7.2):1;
    if(!finite(fx)||fx<=0)errors.push('美元预算汇率必须为正数。');
    const factor=a.peakPricing?1+(s.peakShare??0):1;
    if(!finite(s.apiCache)||s.apiCache<0||s.apiCache>1)errors.push('缓存命中比例需在0到1之间。');
    if(!finite(s.peakShare)||s.peakShare<0||s.peakShare>1)errors.push('峰时Token用量占比需在0到1之间。');
    const prices=fromCatalog?{hit:finite(native.hit)?native.hit*fx:null,miss:finite(native.miss)?native.miss*fx:null,out:finite(native.out)?native.out*fx:null}:
      {hit:s.apiHit,miss:s.apiMiss,out:s.apiOut};
    if(!finite(prices.miss)||prices.miss<0||!finite(prices.out)||prices.out<0)errors.push('输入/输出单价未知或无效。');
    if(s.apiCache>0&&(!finite(prices.hit)||prices.hit<0))errors.push('缓存命中单价未知，不能计算非零缓存比例。');
    const writeShare=s.cacheWriteShare??0,ttl=s.cacheTTL||'fiveMinutes';
    if(!finite(writeShare)||writeShare<0||writeShare>1-s.apiCache)errors.push('缓存写入比例需介于0和未命中比例之间。');
    const bandWrite=native.cacheWrite?.[ttl]??(ttl==='fiveMinutes'?native.write:undefined);
    // A long-context write cannot silently borrow the short-context tariff.
    const writeNative=fromCatalog&&finite(bandWrite)?bandWrite:fromCatalog&&native===a.longContextPrices?null:a.cacheWrite?.[ttl];
    if(writeShare>0&&(!finite(writeNative)||writeNative<0||!['replacement','separate'].includes(a.cacheWriteBilling)))errors.push('该API的缓存写入价/叠加规则尚未核实。');
    const read=finite(prices.hit)?prices.hit:0;
    let input=prices.miss*(1-s.apiCache)+read*s.apiCache;
    if(writeShare>0&&finite(writeNative))input+=writeShare*(writeNative*fx-(a.cacheWriteBilling==='replacement'?prices.miss:0));
    const storage=s.cacheStorageMTokHours??0;
    if(!finite(storage)||storage<0)errors.push('每日缓存存储量必须是非负的百万Token·小时。');
    if(storage>0&&!finite(a.cacheStoragePerMTokenHour))errors.push('该API缓存存储费尚未核实，不能按免费计算。');
    if(a.cachePolicy==='explicit-write'&&writeShare===0&&s.apiCache>0){
      completePrice=false;
      warnings.push('非零缓存命中但未填写入量，只算已预置缓存情景，不输出完整账单回本。');
    }
    const inputPrice=input*factor,outputPrice=prices.out*factor;
    return {ok:!errors.length,errors,warnings,matched,api:a,tier,fx,factor,prices,inputPrice,outputPrice,
      storagePerDay:storage*(a.cacheStoragePerMTokenHour??0)*fx,
      cachedWriteShare:writeShare,source:fromCatalog?'catalog':'manual',
      priceRange,completePrice:completePrice&&fromCatalog,
      limitsVerified:!!a.contextTokens&&(!!a.maxOutputTokens||!!a.outputLimitRange&&O<=a.outputLimitRange[0])};
  }
  function budget(s,D,now=Date.now()){
    const errors=[],I=Math.round(s.inputK*1000),O=Math.round(s.outputK*1000),usage=s.usageHours??12,duty=s.dutyCycle??1;
    if(!Number.isInteger(I)||I<1||!Number.isInteger(O)||O<1)errors.push('API工作量的输入/输出需为有效Token数。');
    if(!finite(usage)||usage<=0||usage>24||!finite(duty)||duty<=0||duty>1)errors.push('API业务小时/占空比无效。');
    if(!Number.isInteger(s.days)||s.days<1||s.days>31)errors.push('API月天数无效。');
    if(!['closed-loop','requests'].includes(s.workloadMode))errors.push('API工作量方式无效。');
    const cycle=s.ttft+(O>1?(O-1)/s.speed:0);
    if(s.workloadMode==='closed-loop'&&(!finite(s.ttft)||s.ttft<=0||O>1&&(!finite(s.speed)||s.speed<=0)||!finite(cycle)||cycle<=0||!Number.isInteger(s.concurrency)||s.concurrency<1||s.concurrency>100000))errors.push('闭环工作量需明确有效并发、TTFT和单路速度。');
    const rounds=s.workloadMode==='requests'?s.requestsPerDay:s.concurrency*usage*3600*duty/cycle;
    if(!finite(rounds)||rounds<0)errors.push('API每日请求数无效。');
    const q=quote(s,D,I,O,now);errors.push(...q.errors);
    const dailyIn=finite(rounds)?I*rounds:null,dailyOut=finite(rounds)?O*rounds:null;
    const daily=p=>(dailyIn*p.miss+dailyOut*p.out)/1e6+q.storagePerDay;
    const monthly=!errors.length&&!q.priceRange?daily({miss:q.inputPrice,out:q.outputPrice})*s.days:null;
    let monthlyRange=null;
    if(!errors.length&&q.priceRange){
      // Price each declared scenario through the same validated quote path:
      // cache hits/writes, peak multiplier, currency and storage all apply.
      const bands=Object.keys(q.priceRange).map(apiContextBand=>{
        const band=quote({...s,apiContextBand},D,I,O,now);
        errors.push(...band.errors.map(e=>apiContextBand+'档：'+e));
        return (dailyIn*band.inputPrice+dailyOut*band.outputPrice)/1e6*s.days+band.storagePerDay*s.days;
      });
      if(!errors.length)monthlyRange=bands;
    }
    return {ok:!errors.length,errors,warnings:q.warnings,quote:q,I:Number.isFinite(I)?I:null,O:Number.isFinite(O)?O:null,rounds:finite(rounds)?rounds:null,dailyIn,dailyOut,monthly,monthlyRange};
  }
  root.ApiPricing={matchingApis,defaultApi,quote,budget};
  if(typeof module!=='undefined')module.exports=root.ApiPricing;
})(typeof window==='undefined'?globalThis:window);
