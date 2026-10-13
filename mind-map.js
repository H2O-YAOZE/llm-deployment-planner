'use strict';
// A spatial projection of the same customer-facing calculation chain, not a second calculator.
(() => {
  let dispose = () => {}, saved = null;
  const NS = 'http://www.w3.org/2000/svg';
  function mount(panel, key, changed) {
    dispose();
    const source = panel.querySelector('.causal-source');
    if (!source) return;
    const notice = [...panel.children].find(el=>el.classList.contains('notice'));
    const audit = panel.querySelector('.causal-audit');
    const branches = [...panel.querySelectorAll('[data-causal-branch]')];
    const nodes = new Map(), edges = new Map();
    const add = (el, lane, x, y) => {
      const id = el.dataset.causalNode;
      if (nodes.has(id)) return id;
      el.classList.add('mm-node'); el.dataset.lane = lane;
      el.style.left = x + 'px'; el.style.top = y + 'px';
      el.tabIndex = 0; el.setAttribute('aria-label', (el.querySelector('h3')?.textContent || '自变量') + '；方向键移动节点');
      nodes.set(id, {id, el, x, y, lane}); return id;
    };
    const link = (a, b, lane) => {
      if (a !== b && nodes.has(a) && nodes.has(b)) edges.set(a + ':' + b, {a,b,lane});
    };
    const root = document.createElement('article'); root.className = 'causal-node mm-source'; root.dataset.causalNode = 'source';
    root.innerHTML = '<h3>所选自变量</h3><div class="causal-value"></div>';
    root.lastElementChild.append(source); add(root,'source',24,270);
    const resourceRows = branches.filter(b => ['memory','prefill','decode'].includes(b.dataset.causalBranch));
    const ys = {memory:28,prefill:220,decode:412};
    for (const branch of resourceRows) {
      const lane = branch.dataset.causalBranch, row = [...branch.querySelectorAll('[data-causal-node]')];
      let previous = 'source';
      row.forEach((el,i) => {
        const x = i === row.length-1 ? 866 : 254 + i*204;
        const id = add(el,lane,x,ys[lane]); link(previous,id,lane); previous=id;
      });
    }
    const merge = [...panel.querySelectorAll('.causal-merge [data-causal-node]')];
    if (merge.length) {
      // Joint validation and physical deployment form one destination, not an extra constraint.
      const joint = merge[0];
      merge.slice(1).forEach(el => {const part=document.createElement('div');part.className='mm-result-part';part.append(...el.childNodes);joint.append(part);});
      add(joint,'result',1100,245);
      resourceRows.forEach(b=>link(b.dataset.causalBranch+'Cards','joint',b.dataset.causalBranch));
    }
    const reverse = panel.querySelector('[data-causal-node="reverseSolve"]');
    if (reverse) {add(reverse,'source',24,470);link('source','reverseSolve','source');for(const e of [...edges.values()])if(e.a==='source'&&e.b!=='reverseSolve'){edges.delete(e.a+':'+e.b);link('reverseSolve',e.b,e.lane);}}
    const local = branches.find(b=>b.dataset.causalBranch==='local');
    if(local){
      const row=[...local.querySelectorAll('[data-causal-node]')];
      let previous=resourceRows.length?'joint':'source';
      row.forEach((el,i)=>{const id=add(el,'local',1100-i*234,636);link(previous,id,'local');previous=id;});
    }
    const api = branches.find(b=>b.dataset.causalBranch==='api');
    if(api){
      const row=[...api.querySelectorAll('[data-causal-node]')]; let previous='source';
      row.forEach((el,i)=>{const id=add(el,'api',254+i*204,828);link(previous,id,'api');previous=id;});
    }
    // Keep every rendered DAG lane. Reverse answer / response checks are not
    // members of the old memory-prefill-decode projection.
    branches.filter(b=>!['memory','prefill','decode','local','api'].includes(b.dataset.causalBranch)).forEach((branch,j)=>{
      [...branch.querySelectorAll('[data-causal-node]')].forEach((el,i)=>add(el,branch.dataset.causalBranch,254+i*240,1050+j*220));
    });
    // V5 links are projected from the executed dependency graph, including
    // transitively collapsed unshown nodes, rather than positional adjacency.
    if([...nodes.values()].some(n=>n.el.dataset.causalDeps)){
      edges.clear();
      for(const n of nodes.values())for(const dep of JSON.parse(n.el.dataset.causalDeps||'[]'))link(dep,n.id,n.lane);
    }
    // A prices-only or inactive parameter needs no empty resource lanes.
    if(!resourceRows.length){
      let index=0;for(const n of nodes.values()){if(n.id==='source'){n.x=24;n.y=190;}else{n.x=260+(index%3)*240;n.y=60+Math.floor(index/3)*230;index++;}}
    }
    const shell=document.createElement('div');shell.className='mm-shell';
    shell.innerHTML='<div class="mm-toolbar"><div><h2>变量影响导图</h2><p>拖动节点，曲线跟随 · 悬停看上下游 · 数字悬停看备注</p></div><div class="mm-tools"><button type="button" data-map-action="out" aria-label="缩小导图">−</button><output class="mm-zoom" aria-live="polite">100%</output><button type="button" data-map-action="in" aria-label="放大导图">＋</button><button type="button" data-map-action="fit">适合画布</button><button type="button" data-map-action="reset">重排</button></div></div><div class="mm-legend"><span data-lane="memory">显存</span><span data-lane="prefill">首 Token</span><span data-lane="decode">Decode</span><span data-lane="api">API 费用</span><span class="mm-change-note"></span></div><div class="mm-viewport" tabindex="0" role="region" aria-label="可拖动缩放的变量影响导图，方向键平移，加减键缩放，0 适合画布"><div class="mm-world"><svg class="mm-lines" aria-hidden="true"></svg></div></div><p class="mm-footnote">三项约束同时满足，卡数不相加。曲线表示影响路径，不代表实测性能。空白处拖动画布；Ctrl + 滚轮缩放。</p>';
    const viewport=shell.querySelector('.mm-viewport'),world=shell.querySelector('.mm-world'),svg=shell.querySelector('svg');
    if(notice){shell.querySelector('.mm-legend').replaceWith(notice);shell.querySelector('.mm-change-note')?.remove();}
    else shell.querySelector('.mm-change-note').textContent=changed?'当前为临时试算，尚未应用':'目录参考场景 · 独立于当前推演';
    panel.replaceChildren(shell);if(audit)panel.append(audit);
    nodes.forEach(n=>{n.el.style.left=n.x+'px';n.el.style.top=n.y+'px';world.append(n.el);});
    const state={scale:1,x:0,y:0},sameKey=saved?.key===key;
    if(sameKey){Object.assign(state,saved.view);nodes.forEach(n=>{const p=saved.positions[n.id];if(p){n.x=p.x;n.y=p.y;}});}
    const pathFor = e => {
      const a=nodes.get(e.a),b=nodes.get(e.b),aw=a.el.offsetWidth,ah=a.el.offsetHeight,bw=b.el.offsetWidth,bh=b.el.offsetHeight;
      let x1,y1,x2,y2,c1x,c1y,c2x,c2y;
      if(e.a==='context' && b.y>a.y+185){
        const rail=a.x+aw+11,ty=b.y+bh/2;
        return `M ${a.x+aw} ${a.y+ah/2} C ${rail} ${a.y+ah/2}, ${rail} ${a.y+ah/2+12}, ${rail} ${a.y+ah/2+22} L ${rail} ${ty-22} C ${rail} ${ty-8}, ${rail} ${ty}, ${b.x} ${ty}`;
      }
      if(Math.abs(a.y-b.y)>150 && (Math.abs(a.x-b.x)<100 || b.x<a.x)){
        const down=b.y>a.y;x1=a.x+aw/2;y1=a.y+(down?ah:0);x2=b.x+bw/2;y2=b.y+(down?0:bh);
        const bend=Math.max(45,Math.abs(y2-y1)*.5);c1x=x1;c1y=y1+(down?bend:-bend);c2x=x2;c2y=y2+(down?-bend:bend);
      }else{
        const right=b.x>a.x;x1=a.x+(right?aw:0);y1=a.y+ah/2;x2=b.x+(right?0:bw);y2=b.y+bh/2;
        const bend=Math.max(12,Math.abs(x2-x1)*.48);c1x=x1+(right?bend:-bend);c1y=y1;c2x=x2+(right?-bend:bend);c2y=y2;
      }
      return `M ${x1} ${y1} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${x2} ${y2}`;
    };
    svg.innerHTML='<defs><marker id="mm-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M 0 0 L 5 3 L 0 6" fill="none" stroke="context-stroke" stroke-width="1"/></marker></defs>';
    for(const e of edges.values()){
      const group=document.createElementNS(NS,'g');group.dataset.lane=e.lane;group.dataset.from=e.a;group.dataset.to=e.b;
      const path=document.createElementNS(NS,'path');path.classList.add('mm-edge');path.setAttribute('marker-end','url(#mm-arrowhead)');
      const flow=document.createElementNS(NS,'path');flow.classList.add('mm-flow');group.append(path,flow);svg.append(group);e.group=group;e.path=path;e.flow=flow;
    }
    const remember=()=>{saved={key,view:{...state},positions:Object.fromEntries([...nodes].map(([id,n])=>[id,{x:n.x,y:n.y}]))};};
    const draw=()=>{
      nodes.forEach(n=>{n.el.style.left=n.x+'px';n.el.style.top=n.y+'px';});
      edges.forEach(e=>{const d=pathFor(e);e.path.setAttribute('d',d);e.flow.setAttribute('d',d);});
      world.style.transform=`translate(${state.x}px,${state.y}px) scale(${state.scale})`;
      shell.querySelector('.mm-zoom').textContent=Math.round(state.scale*100)+'%';remember();
    };
    const fit=()=>{
      const all=[...nodes.values()],left=Math.min(...all.map(n=>n.x))-20,top=Math.min(...all.map(n=>n.y))-20;
      const width=Math.max(...all.map(n=>n.x+n.el.offsetWidth))-left+20,height=Math.max(...all.map(n=>n.y+n.el.offsetHeight))-top+20;
      // Mobile starts readable; users can pan instead of viewing microscopic text.
      state.scale=Math.min(1,Math.max(viewport.clientWidth<600?.8:.48,Math.min(viewport.clientWidth/width,viewport.clientHeight/height)));
      state.x=viewport.clientWidth<600?12-left*state.scale:(viewport.clientWidth-width*state.scale)/2-left*state.scale;
      state.y=12-top*state.scale;draw();
    };
    const zoom=(factor,cx=viewport.clientWidth/2,cy=viewport.clientHeight/2)=>{
      const next=Math.min(1.8,Math.max(.3,state.scale*factor)),ratio=next/state.scale;
      state.x=cx-(cx-state.x)*ratio;state.y=cy-(cy-state.y)*ratio;state.scale=next;draw();
    };
    let pulseTimer;
    const pulse=()=>{shell.classList.remove('mm-pulse');void shell.offsetWidth;shell.classList.add('mm-pulse');clearTimeout(pulseTimer);pulseTimer=setTimeout(()=>shell.classList.remove('mm-pulse'),1800);};
    const highlight=id=>{
      shell.classList.toggle('mm-focused',!!id);
      const upstream=new Set(id?[id]:[]),downstream=new Set(upstream);
      const walk=(seen,reverse)=>{let again=true;while(again){again=false;edges.forEach(e=>{const from=reverse?e.b:e.a,to=reverse?e.a:e.b;if(seen.has(from)&&!seen.has(to)){seen.add(to);again=true;}});}};
      if(id){walk(upstream,true);walk(downstream,false);}
      nodes.forEach(n=>n.el.classList.toggle('mm-on',upstream.has(n.id)||downstream.has(n.id)));
      edges.forEach(e=>e.group.classList.toggle('mm-on',(upstream.has(e.a)&&upstream.has(e.b))||(downstream.has(e.a)&&downstream.has(e.b))));
    };
    world.onpointerover=e=>{const n=e.target.closest('.mm-node');if(n)highlight(n.dataset.causalNode);};
    world.onpointerout=e=>{if(!e.relatedTarget?.closest?.('.mm-node'))highlight(document.activeElement?.closest?.('.mm-node')?.dataset.causalNode);};
    world.addEventListener('focusin',e=>highlight(e.target.closest('.mm-node')?.dataset.causalNode));
    world.addEventListener('focusout',e=>highlight(e.relatedTarget?.closest?.('.mm-node')?.dataset.causalNode));
    let drag=null;
    viewport.onpointerdown=e=>{
      if(e.button!==0||e.target.closest('.calc-factor,button,a,input,select,summary'))return;
      const el=e.target.closest('.mm-node'),node=el?nodes.get(el.dataset.causalNode):null;
      drag={pointer:e.pointerId,node,startX:e.clientX,startY:e.clientY,x:node?node.x:state.x,y:node?node.y:state.y};
      viewport.setPointerCapture(e.pointerId);viewport.classList.add('mm-dragging');e.preventDefault();
    };
    viewport.onpointermove=e=>{if(!drag||drag.pointer!==e.pointerId)return;const dx=e.clientX-drag.startX,dy=e.clientY-drag.startY;if(drag.node){drag.node.x=drag.x+dx/state.scale;drag.node.y=drag.y+dy/state.scale;}else{state.x=drag.x+dx;state.y=drag.y+dy;}draw();};
    const finish=()=>{drag=null;viewport.classList.remove('mm-dragging');};
    viewport.onpointerup=finish;viewport.onpointercancel=finish;viewport.onlostpointercapture=finish;
    viewport.onwheel=e=>{if(!e.ctrlKey&&!e.metaKey)return;e.preventDefault();const box=viewport.getBoundingClientRect();zoom(e.deltaY<0?1.12:1/1.12,e.clientX-box.left,e.clientY-box.top);};
    viewport.onkeydown=e=>{
      if(e.target.closest('.calc-factor'))return;
      if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
        e.preventDefault();const n=nodes.get(e.target.closest('.mm-node')?.dataset.causalNode),target=n||state,step=(e.shiftKey?40:16)/(n?state.scale:1);
        target.x+=(e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0);target.y+=(e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0);draw();if(n)highlight(n.id);
      }else if(e.key==='+'||e.key==='='){e.preventDefault();zoom(1.2);}else if(e.key==='-'){e.preventDefault();zoom(1/1.2);}else if(e.key==='0'){e.preventDefault();fit();}else if(e.key==='Escape'){finish();highlight(null);}
    };
    shell.querySelector('.mm-tools').onclick=e=>{const a=e.target.dataset.mapAction;if(a==='in')zoom(1.2);else if(a==='out')zoom(1/1.2);else if(a==='fit')fit();};
    // Keep the source projection for reset; remounting cannot parse an already projected graph.
    const positions=Object.fromEntries([...nodes].map(([id,n])=>[id,{x:parseFloat(n.el.style.left),y:parseFloat(n.el.style.top)}]));
    shell.querySelector('[data-map-action="reset"]').onclick=e=>{e.stopPropagation();nodes.forEach(n=>Object.assign(n,positions[n.id]));fit();pulse();};
    const observer=new ResizeObserver(()=>{draw();});observer.observe(viewport);nodes.forEach(n=>observer.observe(n.el));
    const frame=requestAnimationFrame(()=>{sameKey?draw():fit();if(changed)pulse();});
    dispose=()=>{cancelAnimationFrame(frame);observer.disconnect();clearTimeout(pulseTimer);};
  }
  window.MindMap={mount};
})();
