/**
 * redeem.test.mjs — redeem 插件回归（兑换码 / 礼包领取 / 库存 / 本地历史）
 *
 * 覆盖：纯函数（条目规整 / 响应提取 / 参数校验 / 错误描述）+ register() 行为
 *      （工具注册、兑换码成功与失败、礼包列表、礼包领取、库存查询、历史落库）。
 * 自包含：手写最小 fake api（db / vrchat.fetch 均为可断言替身），不触网、不写生产库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import register, {
  normalizeItem,
  extractRedeemedItems,
  extractInventoryList,
  extractTotalCount,
  extractErrors,
  isPlausibleCode,
  isPlausibleInventoryId,
  describeError,
} from '../plugins/official/redeem/index.js';

const BUNDLE_ITEM = {
  id: 'invt_bundle_1',
  name: 'Tokyo Game Show 2026 Nameplate',
  itemType: 'bundle',
  itemTypeLabel: 'Bundle',
  imageUrl: 'https://example.invalid/file.png',
  metadata: { inventoryItemsToInstantiate: ['invt_inner_1'] },
};

function makeDb(historyRows = []) {
  const runs = [];
  const alls = [];
  const handle = {
    run: (sql, params) => { runs.push({ sql, params }); },
    all: (sql, params) => { alls.push({ sql, params }); return historyRows; },
  };
  return { table: () => handle, __runs: runs, __alls: alls };
}

function makeApi({ routes = {}, historyRows = [] } = {}) {
  const tools = new Map();
  const calls = [];
  const logs = [];
  const api = {
    db: makeDb(historyRows),
    registerTool: (def) => tools.set(def.name, def),
    log: (m) => logs.push(String(m)),
    vrchat: {
      fetch: async (path, opts) => {
        calls.push({ path, opts });
        const key = Object.keys(routes).find((k) => path.startsWith(k));
        if (!key) throw Object.assign(new Error(`no route for ${path}`), { status: 404 });
        const r = routes[key];
        if (r instanceof Error) throw r;
        return typeof r === 'function' ? r(path, opts) : r;
      },
    },
  };
  return { api, tools, calls, logs };
}

// ── 纯函数 ───────────────────────────────────────────────────────────────
test('normalizeItem：规整字段并算出 contains/containsIds', () => {
  const it = normalizeItem(BUNDLE_ITEM);
  assert.equal(it.inventoryId, 'invt_bundle_1');
  assert.equal(it.name, 'Tokyo Game Show 2026 Nameplate');
  assert.equal(it.itemType, 'bundle');
  assert.equal(it.contains, 1);
  assert.deepEqual(it.containsIds, ['invt_inner_1']);
  assert.equal(it.seen, false);
  assert.equal(it.expiryDate, null);
  assert.deepEqual(normalizeItem().equipSlots, []);
});

test('extractRedeemedItems：从 redeemedRewards 结构提取（并跳过空项）', () => {
  const items = extractRedeemedItems({
    redeemedRewards: [
      { data: { item: BUNDLE_ITEM }, type: 'item' },
      { data: {}, type: 'item' },
      { type: 'item' },
    ],
    redemptionCode: 'R0614WS81RYC0EUY',
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Tokyo Game Show 2026 Nameplate');
  assert.deepEqual(extractRedeemedItems(null), []);
  assert.deepEqual(extractRedeemedItems({}), []);
});

test('extractInventoryList：兼容 {data:[...]} 与裸数组', () => {
  assert.deepEqual(extractInventoryList({ data: [1, 2] }), [1, 2]);
  assert.deepEqual(extractInventoryList([3]), [3]);
  assert.deepEqual(extractInventoryList({ totalCount: 0 }), []);
  assert.deepEqual(extractInventoryList(undefined), []);
});

test('isPlausibleCode / isPlausibleInventoryId：空串与超长拒绝', () => {
  assert.equal(isPlausibleCode('R0614WS81RYC0EUY'), true);
  assert.equal(isPlausibleCode('  R0614WS81RYC0EUY  '), true);
  assert.equal(isPlausibleCode(''), false);
  assert.equal(isPlausibleCode('   '), false);
  assert.equal(isPlausibleCode('x'.repeat(65)), false);
  assert.equal(isPlausibleCode(123), false);
  assert.equal(isPlausibleInventoryId('inv_4f884e92'), true);
  assert.equal(isPlausibleInventoryId(''), false);
});

test('describeError：解析 VRChat 错误结构', () => {
  const e1 = Object.assign(new Error('VRChat API 请求失败: 401 /reward/redeem'), {
    status: 401,
    response: { error: { message: '"Missing Credentials"', status_code: 401 } },
  });
  assert.deepEqual(describeError(e1), { status: 401, message: '"Missing Credentials"' });
  const e2 = Object.assign(new Error('网络错误'), { status: 0 });
  assert.equal(describeError(e2).message, '网络错误');
});

// ── register 行为 ────────────────────────────────────────────────────────
test('register：注册 5 个工具', () => {
  const { api, tools } = makeApi();
  register(api);
  assert.deepEqual([...tools.keys()].sort(), [
    'claim_bundle',
    'get_inventory_items',
    'get_redeem_history',
    'get_redeemable_bundles',
    'redeem_code',
  ]);
});

test('redeem_code：POST /reward/redeem，返回物品并提示礼包需再领', async () => {
  const { api, tools, calls } = makeApi({
    routes: { '/reward/redeem': { redeemedRewards: [{ data: { item: BUNDLE_ITEM }, type: 'item' }], redemptionCode: 'R0614WS81RYC0EUY' } },
  });
  register(api);
  const res = await tools.get('redeem_code').handler({ code: ' R0614WS81RYC0EUY ' });
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.equal(res.items[0].itemType, 'bundle');
  assert.match(res.nextStep, /claim_bundle/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/reward/redeem');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.body.code, 'R0614WS81RYC0EUY'); // 去掉首尾空格
  // 成功后写历史
  assert.equal(api.db.__runs.length, 1);
  assert.match(api.db.__runs[0].sql, /INSERT INTO history/);
  assert.equal(api.db.__runs[0].params.$code, 'R0614WS81RYC0EUY');
  assert.equal(api.db.__runs[0].params.$ok, 1);
});

test('redeem_code：非 bundle 物品直接入库（nextStep 不含 claim 提示）', async () => {
  const { api, tools } = makeApi({
    routes: { '/reward/redeem': { redeemedRewards: [{ data: { item: { id: 'invt_x', name: 'Sticker', itemType: 'sticker' } } }] } },
  });
  register(api);
  const res = await tools.get('redeem_code').handler({ code: 'ABC' });
  assert.equal(res.ok, true);
  assert.match(res.nextStep, /get_inventory_items/);
});

test('redeem_code：空码/非法参数 → 不调用 API', async () => {
  const { api, tools, calls } = makeApi();
  register(api);
  const r1 = await tools.get('redeem_code').handler({});
  assert.equal(r1.ok, false);
  const r2 = await tools.get('redeem_code').handler({ code: '   ' });
  assert.equal(r2.ok, false);
  const r3 = await tools.get('redeem_code').handler({ code: 'x'.repeat(65) });
  assert.equal(r3.ok, false);
  assert.equal(calls.length, 0);
});

test('redeem_code：API 失败 → ok:false 带 status，并记失败历史（不臆造成功）', async () => {
  const err = Object.assign(new Error('VRChat API 请求失败: 404 /reward/redeem'), {
    status: 404,
    response: { error: { message: 'Invalid code', status_code: 404 } },
  });
  const { api, tools } = makeApi({ routes: { '/reward/redeem': err } });
  register(api);
  const res = await tools.get('redeem_code').handler({ code: 'BADCODE' });
  assert.equal(res.ok, false);
  assert.equal(res.status, 404);
  assert.equal(res.error, 'Invalid code');
  assert.equal(api.db.__runs[0].params.$ok, 0);
});

test('redeem_code：HTTP 200 但非空 errors → ok:false（不臆造成功，errors 透出）', async () => {
  const { api, tools } = makeApi({
    routes: { '/reward/redeem': { redeemedRewards: [], errors: [{ message: 'This code has already been used' }] } },
  });
  register(api);
  const res = await tools.get('redeem_code').handler({ code: 'USEDCODE' });
  assert.equal(res.ok, false);
  assert.equal(res.count, 0);
  assert.equal(res.errors.length, 1);
  assert.match(res.error, /errors/);
  assert.equal(api.db.__runs[0].params.$ok, 0);
});

test('get_redeemable_bundles：limit 参数化 + total 透出', async () => {
  const { api, tools, calls } = makeApi({
    routes: { '/inventory': { data: [{ id: 'inv_1', name: 'TGS', itemType: 'bundle' }], totalCount: 3 } },
  });
  register(api);
  const res = await tools.get('get_redeemable_bundles').handler({ limit: 999 });
  assert.equal(res.ok, true);
  assert.equal(res.total, 3);
  assert.match(calls[0].path, /n=100/);
});

test('get_redeemable_bundles：列待领礼包（带过期时间）', async () => {
  const { api, tools, calls } = makeApi({
    routes: {
      '/inventory': {
        data: [
          { id: 'inv_1', name: 'TGS 2026', itemType: 'bundle', isSeen: false, expiryDate: null, created_at: '2026-09-19T03:02:41.636Z' },
          { id: 'inv_2', name: 'Old Pack', itemType: 'bundle', isSeen: true, expiryDate: '2026-10-01T00:00:00.000Z' },
        ],
      },
    },
  });
  register(api);
  const res = await tools.get('get_redeemable_bundles').handler();
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.equal(res.items[0].inventoryId, 'inv_1');
  assert.equal(res.items[1].expiryDate, '2026-10-01T00:00:00.000Z');
  assert.match(calls[0].path, /types=bundle/);
});

test('claim_bundle：POST /inventory/{id}/consume 并返回到手物品', async () => {
  const { api, tools, calls } = makeApi({
    routes: {
      '/inventory/inv_4f884e92': {
        errors: [],
        inventoryItems: [{ id: 'invt_np', name: 'Bolt Matrix', itemType: 'nameplateEffect', description: 'Pure pop energy.' }],
      },
    },
  });
  register(api);
  const res = await tools.get('claim_bundle').handler({ inventoryId: ' inv_4f884e92 ' });
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.equal(res.items[0].name, 'Bolt Matrix');
  assert.equal(res.items[0].itemType, 'nameplateEffect');
  assert.equal(calls[0].path, '/inventory/inv_4f884e92/consume');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(api.db.__runs[0].params.$kind, 'claim');
});

test('claim_bundle：HTTP 200 但非空 errors → ok:false（部分失败不当成功）', async () => {
  const { api, tools } = makeApi({
    routes: {
      '/inventory/inv_partial': {
        errors: [{ message: 'Item unavailable' }],
        inventoryItems: [{ id: 'invt_x', name: 'Half', itemType: 'nameplateEffect' }],
      },
    },
  });
  register(api);
  const res = await tools.get('claim_bundle').handler({ inventoryId: 'inv_partial' });
  assert.equal(res.ok, false);
  assert.equal(res.count, 1);
  assert.equal(res.errors.length, 1);
  assert.equal(api.db.__runs[0].params.$ok, 0);
});

test('claim_bundle：缺 id → 不调用 API；API 报错 → ok:false', async () => {
  const { api, tools, calls } = makeApi({
    routes: { '/inventory/': Object.assign(new Error('boom'), { status: 500, response: { error: { message: 'server' } } }) },
  });
  register(api);
  const r1 = await tools.get('claim_bundle').handler({});
  assert.equal(r1.ok, false);
  assert.equal(calls.length, 0);
  const r2 = await tools.get('claim_bundle').handler({ inventoryId: 'inv_x' });
  assert.equal(r2.ok, false);
  assert.equal(r2.status, 500);
});

test('get_inventory_items：type/limit/offset 拼进查询串，limit 上限 100，返回 total/hasMore', async () => {
  const { api, tools, calls } = makeApi({
    routes: { '/inventory': { data: [{ id: 'invt_a', name: 'X', itemType: 'nameplateEffect' }], totalCount: 119 } },
  });
  register(api);
  const r1 = await tools.get('get_inventory_items').handler({ type: 'nameplateEffect', limit: 999 });
  assert.equal(r1.ok, true);
  assert.match(calls[0].path, /types=nameplateEffect/);
  assert.match(calls[0].path, /n=100/);
  assert.match(calls[0].path, /offset=0/);
  assert.equal(r1.total, 119);
  assert.equal(r1.hasMore, true);            // 0 + 1 < 119
  const r2 = await tools.get('get_inventory_items').handler({});
  assert.match(calls[1].path, /^\/inventory\?n=50&offset=0$/);
  assert.equal(r2.filter, null);
  // offset 透传；翻到末页时 hasMore=false
  const r3 = await tools.get('get_inventory_items').handler({ offset: 118, limit: 1 });
  assert.match(calls[2].path, /offset=118/);
  assert.equal(r3.hasMore, false);           // 118 + 1 = 119
  // 非法 offset 回落 0
  const r4 = await tools.get('get_inventory_items').handler({ offset: -5 });
  assert.match(calls[3].path, /offset=0/);
  assert.equal(r4.offset, 0);
  // 无 totalCount 时按「返回满一页」推断 hasMore
  const { api: api2, tools: tools2 } = makeApi({ routes: { '/inventory': { data: [{ id: 'invt_b', name: 'Y', itemType: 'prop' }] } } });
  register(api2);
  const r5 = await tools2.get('get_inventory_items').handler({ limit: 10 });
  assert.equal(r5.total, null);
  assert.equal(r5.hasMore, false);           // 1 < 10
});

test('get_redeem_history：按 kind 过滤查询本地表', async () => {
  const rows = [{ id: 1, kind: 'redeem', code: 'ABC', ok: 1 }];
  const { api, tools } = makeApi({ historyRows: rows });
  register(api);
  const r1 = await tools.get('get_redeem_history').handler({ limit: 5 });
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.items, rows);
  assert.match(api.db.__alls[0].sql, /LIMIT \$limit/);
  assert.equal(api.db.__alls[0].params.$limit, 5);
  const r2 = await tools.get('get_redeem_history').handler({ kind: 'redeem' });
  assert.match(api.db.__alls[1].sql, /WHERE kind = \$kind/);
  assert.equal(api.db.__alls[1].params.$kind, 'redeem');
  // 非法的 kind 被忽略（查询全部）
  await tools.get('get_redeem_history').handler({ kind: 'nonsense' });
  assert.match(api.db.__alls[2].sql, /ORDER BY id DESC/);
  assert.equal(api.db.__alls[2].params.$kind, undefined);
});

// ── 纯函数（分页与 errors 判定，随审核建议新增）──────────────────────────
test('extractTotalCount：合法返回数字，缺失/非法返回 NaN', () => {
  assert.equal(extractTotalCount({ totalCount: 119 }), 119);
  assert.equal(extractTotalCount({ totalCount: 0 }), 0);
  assert.ok(Number.isNaN(extractTotalCount({})));
  assert.ok(Number.isNaN(extractTotalCount({ totalCount: 'abc' })));
  assert.ok(Number.isNaN(extractTotalCount(null)));
});

test('extractErrors：非数组/缺失一律空数组（不把 undefined 当失败）', () => {
  assert.deepEqual(extractErrors({ errors: [{ message: 'x' }] }), [{ message: 'x' }]);
  assert.deepEqual(extractErrors({ errors: [] }), []);
  assert.deepEqual(extractErrors({}), []);
  assert.deepEqual(extractErrors(null), []);
});

test('extractInventoryList：兼容 {data:[...]} 与裸数组，totalCount 不影响取值', () => {
  assert.deepEqual(extractInventoryList({ data: [1], totalCount: 2 }), [1]);
  assert.deepEqual(extractInventoryList([1, 2]), [1, 2]);
  assert.deepEqual(extractInventoryList({}), []);
});

// ── get_redeemable_bundles offset 分页 ─────────────────────────────────────
test('get_redeemable_bundles：带 offset 时请求路径同时含 n= 与 offset=', async () => {
  const { api, tools, calls } = makeApi({
    routes: { '/inventory': { data: [{ id: 'inv_1', name: 'B', itemType: 'bundle' }], totalCount: 5 } },
  });
  register(api);
  const res = await tools.get('get_redeemable_bundles').handler({ limit: 10, offset: 20 });
  assert.equal(res.ok, true);
  assert.match(calls[0].path, /types=bundle/);
  assert.match(calls[0].path, /n=10/);
  assert.match(calls[0].path, /offset=20/);
  assert.equal(res.offset, 20);
  assert.equal(res.limit, 10);
});

test('get_redeemable_bundles：offset 缺省为 0', async () => {
  const { api, tools, calls } = makeApi({
    routes: { '/inventory': { data: [], totalCount: 0 } },
  });
  register(api);
  const res = await tools.get('get_redeemable_bundles').handler({});
  assert.match(calls[0].path, /offset=0/);
  assert.equal(res.offset, 0);
});

test('get_redeemable_bundles：非法 offset（负数 / NaN）按 0 处理', async () => {
  const { api, tools, calls } = makeApi({
    routes: { '/inventory': { data: [], totalCount: 0 } },
  });
  register(api);
  const r1 = await tools.get('get_redeemable_bundles').handler({ offset: -5 });
  assert.match(calls[0].path, /offset=0/);
  assert.equal(r1.offset, 0);
  const r2 = await tools.get('get_redeemable_bundles').handler({ offset: NaN });
  assert.match(calls[1].path, /offset=0/);
  assert.equal(r2.offset, 0);
});

test('get_redeemable_bundles：total 已知时 hasMore 正确（首页 true、末页 false）', async () => {
  const { api, tools } = makeApi({
    routes: { '/inventory': (path) => {
      const m = path.match(/offset=(\d+)/);
      const off = m ? Number(m[1]) : 0;
      const items = off < 3 ? [{ id: `inv_${off}`, name: 'B', itemType: 'bundle' }] : [];
      return { data: items, totalCount: 3 };
    } },
  });
  register(api);
  const r1 = await tools.get('get_redeemable_bundles').handler({ limit: 1, offset: 0 });
  assert.equal(r1.hasMore, true);   // 0 + 1 < 3
  const r2 = await tools.get('get_redeemable_bundles').handler({ limit: 1, offset: 2 });
  assert.equal(r2.hasMore, false);  // 2 + 1 = 3
});

test('get_redeemable_bundles：total 未知时按 items.length >= limit 推断；limit 钳到 100', async () => {
  const { api: api2, tools: tools2, calls: calls2 } = makeApi({
    routes: { '/inventory': { data: [{ id: 'inv_x', name: 'Y', itemType: 'bundle' }] } },
  });
  register(api2);
  const r1 = await tools2.get('get_redeemable_bundles').handler({ limit: 10 });
  assert.equal(r1.total, null);
  assert.equal(r1.hasMore, false);  // 1 < 10
  // limit 超过 100 被钳到 100
  const r2 = await tools2.get('get_redeemable_bundles').handler({ limit: 999 });
  assert.match(calls2[1].path, /n=100/);
  assert.equal(r2.limit, 100);
});
