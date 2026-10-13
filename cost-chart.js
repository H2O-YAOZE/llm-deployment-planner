'use strict';
// Rendering only. All points come from WorkbenchUI.chartData's existing cost model.
(function(root){
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const fmt=(n,d=2)=>new Intl.NumberFormat('zh-CN',{maximumFractionDigits:d}).format(n);
 const yuan=n=>'¥ '+fmt(n),wan=n=>fmt(n/10000)+' 万';
 let chart=null,observer=null;
 function dispose(){observer?.disconnect();observer=null;if(chart){chart.dispose();chart=null;}}
 function render(cost,s,d){
  const points=Array.from({length:d.months+1},(_,month)=>d.at(month));
  const caption=!cost.comparable?'当前价格与工作量下的费用预算':d.payback===null?'当前预算下，两条费用曲线不相交':d.crossing?`预计第 ${fmt(d.payback)} 个月累计费用持平`:`预计第 ${fmt(d.payback)} 个月持平，超出当前比较范围`;
  const payload={points,months:d.months,payback:cost.comparable&&d.crossing?d.payback:null,crossing:cost.comparable?d.crossing:null};
  return `<div class="cost-explorer" data-cost-series="${esc(JSON.stringify(payload))}"><div class="cost-explorer-tools"><div class="chart-periods" role="group" aria-label="查看时间范围">${[12,24,36].filter(n=>n<=d.months).map(n=>`<button type="button" data-chart-period="${n}" aria-pressed="${n===d.months}">${n}个月</button>`).join('')}</div><button type="button" class="chart-reset" data-chart-reset>重置视图</button></div><div id="cost-chart" class="interactive-cost-plot" role="figure" tabindex="0" aria-label="云端API与本地部署累计费用。横轴为月份，纵轴为万元。拖动底部滑块选择时间范围；方向键查看每月费用。"><span class="chart-loading">正在绘制费用曲线…</span></div><div class="chart-interaction-hint"><span>拖动下方两端缩放，拖动选区平移</span><span data-chart-range>0—${d.months}个月</span></div><div class="chart-totals"><div><small>${fmt(s.years)}年云端 API</small><strong data-cost="api-total">${wan(d.end.cloud)}</strong></div><div><small>${fmt(s.years)}年本地部署</small><strong data-cost="local-total">${wan(d.end.local)}</strong></div><div><small>${d.end.difference>=0?'本地少支出':'云端少支出'}</small><strong data-cost="difference">${wan(Math.abs(d.end.difference))}</strong></div></div><p class="chart-budget-caption">${esc(caption)}</p><p id="chart-readout" class="sr-only" aria-live="polite">方向键查看每月费用。</p></div>`;
 }
 function mount(){
  dispose();const el=document.getElementById('cost-chart'),shell=el?.closest('.cost-explorer');if(!el||!shell)return;
  if(!root.echarts){el.innerHTML='<p class="chart-loading">图表暂未加载，累计费用见下方。</p>';return;}
  const d=JSON.parse(shell.dataset.costSeries),cloud='#7795b2',local='#377e61',font='"Microsoft YaHei", "PingFang SC", sans-serif';
  const mobile=el.clientWidth<480,animation=!root.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.replaceChildren();chart=root.echarts.init(el,null,{renderer:'canvas'});const instance=chart;
  const setReadout=point=>{shell.querySelector('#chart-readout').textContent=`第 ${point.month} 个月：云端 ${yuan(point.cloud)}，本地 ${yuan(point.local)}，${point.difference>=0?'本地':'云端'}少支出 ${yuan(Math.abs(point.difference))}。`;};
  const series=(name,key,color)=>({name,type:'line',data:d.points.map(p=>[p.month,p[key]/10000]),smooth:false,showSymbol:false,symbol:'circle',symbolSize:7,lineStyle:{width:2.5,color},itemStyle:{color},emphasis:{focus:'none',lineStyle:{width:3}},animationDuration:400});
  const curves=[series('云端 API','cloud',cloud),series('本地部署','local',local)];
  if(d.crossing&&Number.isFinite(d.payback))curves[1].markPoint={symbol:'circle',symbolSize:9,itemStyle:{color:local,borderColor:'#fff',borderWidth:2},label:{formatter:()=>`第${fmt(d.payback,1)}个月持平`,position:'top',fontSize:11,color:local},data:[{coord:[d.payback,d.crossing.local/10000]}]};
  const option={animation,textStyle:{fontFamily:font,fontSize:12,color:'#586d63'},color:[cloud,local],
   grid:{left:mobile?44:62,right:mobile?18:28,top:54,bottom:72},
   legend:{top:6,right:mobile?8:20,itemWidth:18,itemHeight:3,icon:'roundRect',itemGap:22,selectedMode:false,textStyle:{fontFamily:font,fontSize:12,color:'#52675c'}},
   xAxis:{type:'value',min:0,max:d.months,minInterval:1,splitNumber:mobile?3:6,axisLine:{lineStyle:{color:'#d9e3dc'}},axisTick:{show:false},splitLine:{show:false},axisLabel:{fontSize:11,color:'#718078',hideOverlap:true,formatter:v=>fmt(v,0)+'月'},axisPointer:{label:{show:false}}},
   yAxis:{type:'value',min:0,name:'万元',nameTextStyle:{fontFamily:font,fontSize:11,color:'#718078',align:'right'},nameGap:18,splitNumber:4,axisLine:{show:false},axisTick:{show:false},axisLabel:{fontSize:11,color:'#718078',formatter:v=>fmt(v,1)},splitLine:{lineStyle:{color:'#e8eee9',type:'dashed'}}},
   tooltip:{trigger:'axis',confine:true,backgroundColor:'#fff',borderColor:'#dce6de',borderWidth:1,padding:[12,16],extraCssText:'box-shadow:0 4px 18px rgba(35,65,48,.08);border-radius:10px;',textStyle:{fontFamily:font,fontSize:12,color:'#284535'},axisPointer:{type:'line',snap:true,lineStyle:{color:'#a1b5a9',type:'dashed',width:1}},formatter:items=>{
    const month=Math.max(0,Math.min(d.months,Math.round(items[0]?.value?.[0]??0))),p=d.points[month];setReadout(p);
    return `<div class="cost-hover-title">第 ${month} 个月</div><div class="cost-hover-row"><span><i style="background:${cloud}"></i>云端 API</span><b>${yuan(p.cloud)}</b></div><div class="cost-hover-row"><span><i style="background:${local}"></i>本地部署</span><b>${yuan(p.local)}</b></div><div class="cost-hover-difference">${p.difference>=0?'本地':'云端'}少支出 ${yuan(Math.abs(p.difference))}</div>`;
   }},
   dataZoom:[{type:'slider',xAxisIndex:0,start:0,end:100,bottom:8,height:24,left:mobile?44:62,right:mobile?18:28,minValueSpan:3,brushSelect:false,showDetail:false,showDataShadow:false,borderColor:'#dfe7e1',backgroundColor:'#f4f7f4',fillerColor:'rgba(55,126,97,.10)',handleSize:'110%',handleStyle:{color:'#fff',borderColor:'#7ba28b',borderWidth:1},moveHandleSize:0,textStyle:{fontFamily:font},selectedDataBackground:{lineStyle:{color:'#85a995'},areaStyle:{color:'#d9e6de'}}},
    {type:'inside',xAxisIndex:0,zoomOnMouseWheel:'ctrl',moveOnMouseWheel:false,moveOnMouseMove:true,minValueSpan:3}],series:curves};
  instance.setOption(option);
  const range=()=>{const z=instance.getOption().dataZoom[0],a=Number.isFinite(z.startValue)?z.startValue:d.months*z.start/100,b=Number.isFinite(z.endValue)?z.endValue:d.months*z.end/100;shell.querySelector('[data-chart-range]').textContent=`${fmt(a,0)}—${fmt(b,0)}个月`;shell.querySelectorAll('[data-chart-period]').forEach(button=>button.setAttribute('aria-pressed',String(Math.abs(a)<.01&&Math.abs(b-Number(button.dataset.chartPeriod))<.01)));};
  instance.on('datazoom',range);
  const zoom=(start,end)=>{instance.dispatchAction({type:'dataZoom',startValue:start,endValue:end});range();};
  shell.querySelectorAll('[data-chart-period]').forEach(button=>button.onclick=()=>zoom(0,Number(button.dataset.chartPeriod)));
  shell.querySelector('[data-chart-reset]').onclick=()=>zoom(0,d.months);
  let month=0;
  el.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();month=event.key==='Home'?0:event.key==='End'?d.months:Math.max(0,Math.min(d.months,month+(event.key==='ArrowRight'?1:-1)));const z=instance.getOption().dataZoom[0];if(month<z.startValue||month>z.endValue)zoom(0,d.months);setReadout(d.points[month]);instance.dispatchAction({type:'showTip',seriesIndex:0,dataIndex:month});});
  observer=new ResizeObserver(()=>{if(el.isConnected&&el.clientWidth>0&&chart===instance){instance.resize();const narrow=el.clientWidth<480;instance.setOption({grid:{left:narrow?44:62,right:narrow?18:28},xAxis:{splitNumber:narrow?3:6},dataZoom:[{left:narrow?44:62,right:narrow?18:28}]});}});observer.observe(el);
  el.dataset.chartReady='true';
 }
 root.CostChart={render,mount,dispose};if(typeof module!=='undefined')module.exports=root.CostChart;
})(typeof window==='undefined'?globalThis:window);
