/**
 * redeem —— VRChat 兑换码与礼包领取
 * =====================================================================
 * 需求：使用者常收到 VRChat 官方/活动发放的兑换码（中文社区戏称「免费鸡蛋」），
 * 领取链路是「提交码 → 拿到礼包 → 再领取礼包 → 物品进库存」四步，此前只能靠
 * Agent 手搓 curl 打 REST（还要记住 `auth=` 前缀、UA、consume 端点等细节），
 * 既不可复用也容易出错。本插件把这套流程固化为 MCP 工具。
 *
 * 与核心既有工具的关系：
 *   - 核心 `get_inventory_global` / `get_inventory_drops` 只覆盖「账号级全局物品」
 *     与「待领取掉落」，**不覆盖兑换码与礼包（bundle）**；后者是 inventory 域的
 *     另一套端点（`/reward/redeem`、`/inventory`、`/inventory/{id}/consume`）。
 *
 * 为什么是插件（DEVELOPMENT.md §1.1）：具体业务功能一律落插件；出网走
 * `api.vrchat.fetch`（核心注入登录态 + 自动限流），插件不接触凭据。
 *
 * 工具：
 *   redeem_code            提交兑换码（POST /reward/redeem）
 *   get_redeemable_bundles 列出待领取礼包（GET /inventory?types=bundle）
 *   claim_bundle           领取（打开）礼包（POST /inventory/{id}/consume）
 *   get_inventory_items    列出库存物品（GET /inventory）
 *   get_redeem_history     查询本插件的兑换/领取历史（本地私有表）
 *
 * 安全与不变量：
 *   - 兑换码是**一次性消耗品**：提交成功即不可回滚，因此工具只在真正提交后记录；
 *     失败不改动账号任何状态（VRChat 侧原子）。
 *   - 只读工具绝不发写请求；写工具的 `ok` 完全来自 VRChat 响应，不臆造成功。
 *   - 历史表仅存码 / 物品名 / 响应摘要，**不存 cookie / token**（插件也接触不到）。
 *   - 工具名必须登记在 core/tool-order.json 才会出现在 tools/list。
 */

/** 兑换码/礼包 id 的合理长度上限（防误传超长串） */
const MAX_CODE_CHARS = 64;
const MAX_ID_CHARS = 128;
/** 工具返回条目上限（inventory 分页参数 n 的上下限） */
const MAX_ITEMS = 100;
const DEFAULT_ITEMS = 50;
/** 历史查询默认条数 */
const DEFAULT_HISTORY = 20;

/** 规整物品条目为稳定输出（不同端点字段名一致，缺失值统一 null） */
export function normalizeItem(raw = {}) {
  const meta = raw.metadata || {};
  const toInstantiate = Array.isArray(meta.inventoryItemsToInstantiate) ? meta.inventoryItemsToInstantiate : [];
  return {
    inventoryId: raw.id || null,
    name: raw.name || null,
    itemType: raw.itemType || null,
    itemTypeLabel: raw.itemTypeLabel || null,
    description: raw.description || null,
    equipSlots: Array.isArray(raw.equipSlots) ? raw.equipSlots : [],
    imageUrl: raw.imageUrl || null,
    acquisition: raw.acquisition || null,
    createdAt: raw.created_at || null,
    expiryDate: raw.expiryDate || null,
    seen: raw.isSeen === true,
    /** 礼包内含物品数（>0 表示这是需要再 claim 的礼包） */
    contains: toInstantiate.length,
    /** 礼包内含物品 id 列表（便于核对 claim 结果） */
    containsIds: toInstantiate,
  };
}

/** 从 redeem 响应提取物品列表（兼容 redeemedRewards[].data.item 结构） */
export function extractRedeemedItems(res) {
  const rewards = res && Array.isArray(res.redeemedRewards) ? res.redeemedRewards : [];
  const out = [];
  for (const r of rewards) {
    const item = r && r.data && r.data.item;
    if (item) out.push(normalizeItem(item));
  }
  return out;
}

/** 从 inventory 列表响应提取 data 数组（兼容 {data:[...]} 与裸数组） */
export function extractInventoryList(res) {
  if (Array.isArray(res)) return res;
  if (res && Array.isArray(res.data)) return res.data;
  return [];
}

/** 从 inventory 列表响应提取 totalCount（缺失/非法返回 NaN，供 hasMore 判定） */
export function extractTotalCount(res) {
  const n = res && typeof res === 'object' ? Number(res.totalCount) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/**
 * 从响应提取 errors 数组。
 * 写操作不能只看 HTTP 状态：VRChat 可能返回 200 + 非空 errors[]（部分/全部失败），
 * 此时 `ok` 必须为 false，否则调用方会把「没到账」误读为「已到账」。
 */
export function extractErrors(res) {
  return res && Array.isArray(res.errors) ? res.errors : [];
}

/** 码/id 基础校验（纯函数，便于单测） */
export function isPlausibleCode(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_CODE_CHARS;
}

export function isPlausibleInventoryId(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= MAX_ID_CHARS;
}

/** 把错误对象转成可读结果（VRChat 侧错误结构：{error:{message,status_code}}） */
export function describeError(err) {
  const status = (err && err.status) || 0;
  const payload = err && err.response;
  const message = (payload && payload.error && payload.error.message)
    || (payload && typeof payload === 'string' ? payload : '')
    || (err && err.message)
    || '未知错误';
  return { status, message: String(message).slice(0, 300) };
}

export default function register(api) {
  const history = api.db.table('history');

  /** 写一条历史（失败不阻断主流程，只记日志） */
  function record(entry) {
    try {
      history.run(
        `INSERT INTO history (kind, code, inv_id, name, ok, detail)
         VALUES ($kind, $code, $invId, $name, $ok, $detail)`,
        {
          $kind: entry.kind,
          $code: entry.code || null,
          $invId: entry.inventoryId || null,
          $name: entry.name || null,
          $ok: entry.ok ? 1 : 0,
          $detail: entry.detail ? JSON.stringify(entry.detail).slice(0, 2000) : null,
        }
      );
    } catch (err) {
      api.log(`redeem: 历史写入失败（不影响主流程）：${err.message}`);
    }
  }

  // ── 1. 提交兑换码 ────────────────────────────────────────────────────
  api.registerTool({
    name: 'redeem_code',
    description:
      '[write·兑换] 提交 VRChat 兑换码（活动/联名/周年发的免费物品码，社区俗称「免费鸡蛋」）。'
      + 'POST /reward/redeem，码为一次性消耗品、成功不可回滚。返回换到的物品/礼包清单；'
      + '若返回的是礼包（itemType=bundle，contains>0），还需再调 claim_bundle 领取才会真正到手。'
      + '失败返回 ok:false + status/message（码失效/已用/拼错都会失败，不臆造成功）。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '兑换码（区分大小写，直接粘贴，勿加空格；≤64 字符）' },
      },
      required: ['code'],
    },
    handler: async (args = {}) => {
      const raw = typeof args.code === 'string' ? args.code : '';
      const code = raw.trim();
      if (!isPlausibleCode(code)) {
        return { ok: false, error: `code 必须是非空字符串且不超过 ${MAX_CODE_CHARS} 字符` };
      }
      try {
        const res = await api.vrchat.fetch('/reward/redeem', { method: 'POST', body: { code } });
        const items = extractRedeemedItems(res);
        const errors = extractErrors(res);
        // 200 + 非空 errors = 部分/全部失败（如码无效），不能当成功
        const ok = errors.length === 0;
        record({ kind: 'redeem', code, ok, name: items.map(i => i.name).filter(Boolean).join(', '), detail: { count: items.length, errors, items: items.map(i => ({ id: i.inventoryId, name: i.name, itemType: i.itemType })) } });
        const hasBundle = items.some(i => i.itemType === 'bundle' || i.contains > 0);
        api.log(`redeem: 兑换码${ok ? '提交成功' : '提交未成功'}（${items.length} 项${hasBundle ? '，含礼包待领取' : ''}${ok ? '' : `，errors=${errors.length}`}）`);
        return {
          ok,
          code,
          count: items.length,
          items,
          errors,
          ...(ok ? {} : { error: 'VRChat 返回了 errors（码可能无效/已使用），请以 items/errors 为准' }),
          nextStep: hasBundle
            ? '本次含礼包（bundle）：请用 get_redeemable_bundles 查看，再 claim_bundle 领取礼包内容'
            : '物品已直接进入库存（可用 get_inventory_items 核对）',
        };
      } catch (err) {
        const e = describeError(err);
        record({ kind: 'redeem', code, ok: false, detail: e });
        api.log(`redeem: 兑换码提交失败 status=${e.status} ${e.message}`);
        return { ok: false, code, status: e.status, error: e.message };
      }
    },
  });

  // ── 2. 待领取礼包 ────────────────────────────────────────────────────
  api.registerTool({
    name: 'get_redeemable_bundles',
    description:
      '[query·兑换] 列出账号里**待领取的礼包（Bundles & Packs）**：兑换/活动/VRC+ 掉落都先以礼包形式存在，'
      + '必须再调 claim_bundle 领取才会得到实际物品。'
      + `支持 \`offset\` 翻页（\`limit\` 默认 ${MAX_ITEMS}、单次上限 ${MAX_ITEMS}）；`
      + '返回 `total`（该过滤范围的总数）与 `hasMore`（total 已知时 = offset + items.length < total，'
      + 'total 未知时 = items.length >= limit）。'
      + '返回 inventoryId / 名称 / 获得时间 / 过期时间（expiryDate，'
      + 'null=不过期）/ seen（是否在客户端看过）。列表为空表示没有待领礼包。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `返回条数（默认 ${MAX_ITEMS}，单次上限 ${MAX_ITEMS}）` },
        offset: { type: 'number', description: '可选：从第几条开始（默认 0），配合 hasMore 翻页取全量' },
      },
    },
    handler: async (args = {}) => {
      let limit = Number(args.limit);
      if (!Number.isFinite(limit) || limit <= 0) limit = MAX_ITEMS;
      limit = Math.min(MAX_ITEMS, Math.round(limit));
      let offset = Number(args.offset);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
      offset = Math.round(offset);
      try {
        const res = await api.vrchat.fetch(`/inventory?types=bundle&n=${limit}&offset=${offset}`);
        const data = extractInventoryList(res);
        const items = data.map(normalizeItem);
        const total = extractTotalCount(res);
        const totalKnown = Number.isFinite(total);
        const hasMore = totalKnown ? offset + items.length < total : items.length >= limit;
        return { ok: true, count: items.length, total: totalKnown ? total : null, offset, limit, hasMore, items };
      } catch (err) {
        const e = describeError(err);
        api.log(`redeem: 待领礼包查询失败 status=${e.status} ${e.message}`);
        return { ok: false, status: e.status, error: e.message };
      }
    },
  });

  // ── 3. 领取（打开）礼包 ──────────────────────────────────────────────
  api.registerTool({
    name: 'claim_bundle',
    description:
      '[write·兑换] 领取（打开）一个礼包，内容物真正进入库存（POST /inventory/{inventoryId}/consume）。'
      + 'inventoryId 必须取自 get_redeemable_bundles 返回的 `inv_*`（库存实例 id）；'
      + 'redeem_code 返回的是 `invt_*` 模板 id，**不可**直接用于本工具（实测 404 InventoryItem not found）。'
      + '返回本次到手的物品清单（name/itemType/description/acquisition）。礼包领取后即从待领列表消失，不可重复领取。'
      + 'ok 由响应 errors 是否为空判定（200 + 非空 errors = 部分失败，不当成功）。',
    inputSchema: {
      type: 'object',
      properties: {
        inventoryId: { type: 'string', description: '礼包库存实例 id（形如 inv_xxx，取自 get_redeemable_bundles；redeem_code 给的 invt_* 模板 id 不可用）' },
      },
      required: ['inventoryId'],
    },
    handler: async (args = {}) => {
      const raw = typeof args.inventoryId === 'string' ? args.inventoryId : '';
      const id = raw.trim();
      if (!isPlausibleInventoryId(id)) {
        return { ok: false, error: `inventoryId 必须是非空字符串且不超过 ${MAX_ID_CHARS} 字符` };
      }
      try {
        const res = await api.vrchat.fetch(`/inventory/${encodeURIComponent(id)}/consume`, { method: 'POST', body: {} });
        const items = (res && Array.isArray(res.inventoryItems) ? res.inventoryItems : []).map(normalizeItem);
        const errors = extractErrors(res);
        // 200 + 非空 errors = 部分失败，不能当「已到账」
        const ok = errors.length === 0;
        record({ kind: 'claim', inventoryId: id, ok, name: items.map(i => i.name).filter(Boolean).join(', '), detail: { count: items.length, errors } });
        api.log(`redeem: 礼包领取${ok ? '成功' : '未完全成功'}（${items.length} 项${ok ? '' : `，errors=${errors.length}`}）`);
        return {
          ok,
          inventoryId: id,
          count: items.length,
          items,
          errors,
          ...(ok ? {} : { error: 'VRChat 返回了 errors（部分/全部失败），请以 items/errors 为准' }),
        };
      } catch (err) {
        const e = describeError(err);
        record({ kind: 'claim', inventoryId: id, ok: false, detail: e });
        api.log(`redeem: 礼包领取失败 status=${e.status} ${e.message}`);
        return { ok: false, inventoryId: id, status: e.status, error: e.message };
      }
    },
  });

  // ── 4. 库存物品 ──────────────────────────────────────────────────────
  api.registerTool({
    name: 'get_inventory_items',
    description:
      '[query·兑换] 列出账号库存物品主列表（GET /inventory，可按类型过滤、按 offset 翻页）。'
      + 'itemType 常见值：nameplate / nameplateEffect / profileEffect / iconFrame / accessory / prop / sticker / emoji / bundle / avatarlook。'
      + `单次最多 ${MAX_ITEMS} 条，用 offset 翻页；返回 total（该过滤范围总数）与 hasMore。`
      + '⚠️ 返回顺序**不保证按时间排序**，因此「核对某物品是否到账」不能只看第一页：'
      + '优先用 type 过滤缩小范围，或按 offset 翻页直到取全/找到，否则可能静默误判成「未到账」。'
      + '与核心 get_inventory_global（只给账号级全局物品 /inventory/global）互补——本工具给的是库存主列表。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: '可选：只列该 itemType（如 nameplateEffect）' },
        limit: { type: 'number', description: `返回条数（默认 ${DEFAULT_ITEMS}，单次上限 ${MAX_ITEMS}）` },
        offset: { type: 'number', description: '可选：从第几条开始（默认 0），配合 hasMore 翻页取全量' },
      },
    },
    handler: async (args = {}) => {
      let limit = Number(args.limit);
      if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_ITEMS;
      limit = Math.min(MAX_ITEMS, Math.round(limit));
      let offset = Number(args.offset);
      if (!Number.isFinite(offset) || offset < 0) offset = 0;
      offset = Math.round(offset);
      const type = typeof args.type === 'string' && args.type.trim() ? args.type.trim() : '';
      const path = type
        ? `/inventory?types=${encodeURIComponent(type)}&n=${limit}&offset=${offset}`
        : `/inventory?n=${limit}&offset=${offset}`;
      try {
        const res = await api.vrchat.fetch(path);
        const items = extractInventoryList(res).map(normalizeItem);
        const total = extractTotalCount(res);
        const totalKnown = Number.isFinite(total);
        const hasMore = totalKnown ? offset + items.length < total : items.length >= limit;
        return {
          ok: true,
          count: items.length,
          total: totalKnown ? total : null,
          offset,
          limit,
          hasMore,
          filter: type || null,
          items,
        };
      } catch (err) {
        const e = describeError(err);
        api.log(`redeem: 库存查询失败 status=${e.status} ${e.message}`);
        return { ok: false, status: e.status, error: e.message };
      }
    },
  });

  // ── 5. 本地历史 ──────────────────────────────────────────────────────
  api.registerTool({
    name: 'get_redeem_history',
    description:
      '[query·兑换] 查询本机的兑换码提交与礼包领取历史（插件私有表，跨重启保留）：'
      + 'kind（redeem=提交码 / claim=领礼包）、code、inventoryId、物品名、ok、响应摘要、时间（UTC）。'
      + '用于回溯「这个码什么时候兑过 / 是否已领」以及排查失败原因。',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: `返回条数（默认 ${DEFAULT_HISTORY}）` },
        kind: { type: 'string', description: '可选：redeem（只看到兑换码）或 claim（只看到领礼包）' },
      },
    },
    handler: async (args = {}) => {
      let limit = Number(args.limit);
      if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_HISTORY;
      limit = Math.min(MAX_ITEMS, Math.round(limit));
      const kind = args.kind === 'redeem' || args.kind === 'claim' ? args.kind : '';
      try {
        const rows = kind
          ? history.all('SELECT id, kind, code, inv_id, name, ok, detail, created_at FROM history WHERE kind = $kind ORDER BY id DESC LIMIT $limit', { $kind: kind, $limit: limit })
          : history.all('SELECT id, kind, code, inv_id, name, ok, detail, created_at FROM history ORDER BY id DESC LIMIT $limit', { $limit: limit });
        return { ok: true, count: rows.length, items: rows };
      } catch (err) {
        api.log(`redeem: 历史查询失败：${err.message}`);
        return { ok: false, error: `历史查询失败：${err.message}` };
      }
    },
  });

  api.log('redeem: 已加载（兑换码 / 待领礼包 / 领取礼包 / 库存查询 / 本地历史）');
}
