'use strict';

// Prices below are independent expectations transcribed from the official
// Beijing price table inspected on 2026-10-02; see CATALOG-REVIEW-20261002.md.
const assert = require('node:assert/strict');
const D = require('../data.js');
const P = require('../pricing.js');
const E = require('../engine-v5.js');
const C = require('../advisor-core.js');

let groups = 0;
function test(name, run) {
  run();
  groups++;
  console.log('PASS ' + name);
}
function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)),
    `${actual} != ${expected}`);
}
const plus = {
  ...E.defaults(D), model: 'api_qwenClassicPlus', api: 'qwenClassicPlus',
  apiUseCatalog: true, apiCache: 0, peakShare: 0, cacheWriteShare: 0,
  cacheStorageMTokHours: 0,
};

test('Qwen-Plus非思考三档费用，长输入不沿用首档', () => {
  assert.equal(D.apiPrices.qwenClassicPlus.mode, 'non-thinking');
  for (const [input, inputPrice, outputPrice, requestCost] of [
    [8000, 0.8, 2, 0.0264],
    [200000, 2.4, 20, 0.68],
    [500000, 4.8, 48, 2.88],
  ]) {
    const q = P.quote(plus, D, input, 10000);
    assert.equal(q.ok, true, q.errors.join('; '));
    near(q.inputPrice, inputPrice);
    near(q.outputPrice, outputPrice);
    near((input * q.inputPrice + 10000 * q.outputPrice) / 1e6, requestCost);
  }
  const monthly = P.budget({
    ...plus, inputK: 500, outputK: 10,
    workloadMode: 'requests', requestsPerDay: 100, days: 30,
  }, D);
  assert.equal(monthly.ok, true, monthly.errors.join('; '));
  near(monthly.monthly, 8640);
});

test('129K处于未确定K换算区间，不输出确定账单', () => {
  const q = P.quote(plus, D, 129000, 10000);
  assert.equal(q.ok, false);
  assert.ok(q.errors.some(e => e.includes('K单位')));
  const b = P.budget({
    ...plus, inputK: 129, outputK: 10,
    workloadMode: 'requests', requestsPerDay: 100, days: 30,
  }, D);
  assert.equal(b.ok, false);
  assert.equal(b.monthly, null);
  assert.equal(P.quote(plus, D, 128000, 10000).ok, true);
  assert.equal(P.quote(plus, D, 132000, 10000).ok, true);
});

const newlyBound = [
  ['qwenNextInstruct', 'qwennext', 'qwen3-next-80b-a3b-instruct',
    'Qwen3-Next-80B-A3B-Instruct', [[8000, 1, 4]]],
  ['qwenCoder480', 'qwencoder', 'qwen3-coder-480b-a35b-instruct',
    'Qwen3-Coder-480B-A35B-Instruct', [[8000, 6, 24], [80000, 9, 36], [180000, 15, 60]]],
  ['qwen35_397', 'qwen35_397', 'qwen3.5-397b-a17b',
    'Qwen3.5-397B-A17B', [[8000, 1.2, 7.2], [200000, 3, 18]]],
];

test('新增三条API严格匹配公开模型，并按官方档位报价', () => {
  for (const [api, model, endpoint, checkpoint, cases] of newlyBound) {
    const a = D.apiPrices[api];
    assert.equal(a.endpoint, endpoint);
    assert.equal(a.region, 'cn-beijing');
    assert.equal(a.currency, 'CNY');
    assert.equal(a.source, 'https://help.aliyun.com/zh/model-studio/model-pricing');
    assert.equal(D.models[model].source, 'https://huggingface.co/Qwen/' + checkpoint);
    assert.deepEqual(a.modelIds, [model]);
    assert.equal(P.defaultApi(model, D), api);
    for (const [input, inputPrice, outputPrice] of cases) {
      const q = P.quote({ ...plus, model, api }, D, input, 1000);
      assert.equal(q.ok, true, q.errors.join('; '));
      assert.equal(q.matched, true);
      near(q.inputPrice, inputPrice);
      near(q.outputPrice, outputPrice);
    }
  }
  // No known price tier covers a 220K Coder request. Do not extrapolate 200K pricing.
  assert.equal(P.quote({ ...plus, api: 'qwenCoder480', model: 'qwencoder' }, D, 220000, 1000).ok, false);
});

test('已核价格不伪装API上下文和输出限额均已核实', () => {
  for (const [api, model] of newlyBound) {
    assert.equal(D.apiPrices[api].contextTokens, null);
    assert.equal(D.apiPrices[api].maxOutputTokens, null);
    const q = P.quote({ ...plus, api, model }, D, 8000, 1000);
    assert.equal(q.ok, true, 'price budget remains available');
    assert.equal(q.limitsVerified, false);
    assert.ok(q.warnings.some(w => w.includes('上下文上限尚未核实')));
    assert.ok(q.warnings.some(w => w.includes('最大输出')));
    assert.equal(P.quote({ ...plus, api, model, apiCache: 0.2 }, D, 8000, 1000).ok, false,
      'unknown cached-input price cannot be treated as zero');
  }
});

test('雷达同义名称与旧存档ID归并到有价的正确模型', () => {
  for (const [oldId, name, canonical, api] of [
    ['radar_claude45haiku', 'Claude 4.5 Haiku', 'haiku45', 'haiku45'],
    ['radar_gemini31pro', 'Gemini 3.1 Pro', 'gemini31', 'gemini31'],
  ]) {
    assert.equal(D.modelAliases[oldId], canonical);
    assert.equal(D.radarAliases[name], canonical);
    assert.equal(D.models[oldId], undefined, 'no duplicate pending selector entry');
    const normalized = C.requirements({ model: oldId }, D, E);
    assert.equal(normalized.model, canonical);
    const applied = C.patchState(E.defaults(D), { model: oldId }, D, E);
    assert.equal(applied.model, canonical);
    assert.equal(applied.api, api);
    const restored = C.patchState({ ...applied, model: oldId }, {}, D, E);
    assert.equal(restored.model, canonical);
    assert.equal(P.quote({ ...plus, api, model: canonical }, D, 8000, 1000).matched, true);
  }
});

test('DeepSeek雷达0813匹配新服务，旧checkpoint不借价', () => {
  assert.equal(D.radarAliases['DeepSeek V4 Pro'], 'dsv4p0813');
  assert.equal(D.models.dsv4p.source, 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro');
  assert.equal(D.models.dsv4p0813.source, 'https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813');
  assert.deepEqual(D.apiPrices.dsPro.modelIds, ['dsv4p0813']);
  assert.equal(D.apiPrices.dsPro.servedVersion, 'DeepSeek-V4-Pro-0813');
  assert.deepEqual(D.models.dsv4p.apiIds, []);
  assert.equal(P.defaultApi('dsv4p', D), '');
  assert.equal(P.defaultApi('dsv4p0813', D), 'dsPro');
  const old = P.quote({ ...plus, model: 'dsv4p', api: 'dsPro' }, D, 8000, 1000);
  assert.equal(old.matched, false);
  assert.ok(old.warnings.some(w => w.includes('模型版本不一致')));
  assert.equal(P.quote({ ...plus, model: 'dsv4p0813', api: 'dsPro' }, D, 8000, 1000).matched, true);
});

test('全部模型、API及雷达别名保持双向有效引用', () => {
  for (const [id, model] of Object.entries(D.models)) {
    for (const api of model.apiIds || []) {
      assert.ok(D.apiPrices[api], `${id} points to absent API ${api}`);
      assert.ok(D.apiPrices[api].modelIds.includes(id), `${id}/${api} missing reverse mapping`);
    }
  }
  for (const [id, api] of Object.entries(D.apiPrices)) {
    for (const model of api.modelIds || []) {
      assert.ok(D.models[model], `${id} points to absent model ${model}`);
      assert.ok(D.models[model].apiIds.includes(id), `${id}/${model} missing reverse mapping`);
    }
  }
  for (const id of Object.values(D.radarAliases)) assert.ok(D.models[id]);
  for (const id of Object.values(D.modelAliases || {})) assert.ok(D.models[id]);
});

console.log(`PASS ${groups} catalog price/identity regression groups`);
