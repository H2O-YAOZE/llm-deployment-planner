'use strict';
const assert=require('node:assert/strict'),D=structuredClone(require('../data.js')),
 E=require('../engine-v5.js'),S=require('../solver-v5.js'),C=require('../advisor-core.js');
require('../catalog-ui.js');
const mid='integration_new_model',cid='integration_new_gpu';
D.models[mid]={...structuredClone(D.models.qwen3b8),id:mid,name:'新模型测试',apiIds:[],totalParamsB:9,activeParamsB:9};
D.cards[cid]={...structuredClone(D.cards.h200),id:cid,name:'新芯片测试',memoryGB:160,cardPriceWan:22};
let state=C.patchState(E.defaults(D),{model:mid,card:cid,precision:'bf16',inputK:1,outputK:1,concurrency:20,ttft:30,speed:30},D,E);
assert.equal(state.totalB,9);assert.equal(state.memoryGB,160);assert.equal(state.cardWan,22);
const forward=E.calculate(state,D);assert.equal(forward.ok,true);assert.equal(forward.feasible,true);assert.ok(forward.chosen);
const reverse=S.solve({...state,servers:1,slots:8},D,'concurrency');assert.equal(reverse.ok,true);assert.equal(reverse.feasible,true);assert.ok(reverse.solve.answer>0);
assert.ok(CatalogUI.render(D,'models').includes('新模型测试'));assert.ok(CatalogUI.render(D,'cards').includes('新芯片测试'));
const choices=C.catalog(D,E);assert.ok(JSON.stringify(choices).includes(mid));assert.ok(JSON.stringify(choices).includes(cid));
const changed=E.calculate({...state,cardWan:44},D);assert.ok(changed.cost.capex>forward.cost.capex);
D.models[mid].catalogOnly=true;assert.equal(E.calculate(state,D).ok,false);
console.log('PASS new catalog IDs feed fields, forward cards/cost, reverse capacity, data page and advisor; unsupported architecture rejected');
