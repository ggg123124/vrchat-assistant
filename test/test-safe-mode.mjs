/**
 * test-safe-mode.mjs — 安全模式（VRC_MONITOR_SAFE_MODE）功能验证
 *
 * 覆盖：
 *   1. 单元：开关判定（true/1/yes/on 及大小写/缺省）
 *   2. 单元：filterTools 过滤 / assertToolAllowed 拦截
 *   3. 单元：DESTRUCTIVE_TOOLS 清单与 CUSTOM_TOOLS 无漂移（每个名字都存在）
 *   4. 端到端（开启）：真实 HTTP 服务器 tools/list 不含破坏性工具、tools/call 拦截并报错、普通工具正常
 *   5. 端到端（关闭）：tools/list 恢复全部工具
 *
 * 用法：node test-safe-mode.mjs
 * 无需 VRChat 凭据 / 网络，可离线运行。退出码 0=全部通过。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DESTRUCTIVE_TOOLS, isSafeModeEnabled, filterTools, assertToolAllowed } from '../core/safe-mode.js';
import { createServer } from '../core/http-server.js';
import { getRegistryMap } from '../core/registry.js';
import { ctx } from '../core/server-context.js';
import { RateLimiter } from '../core/rate-limiter.js';

// CUSTOM_TOOLS 原数据源 core/mcp-definitions.js 已被 PR-1 重构拆分为 core/tools/*.js（该文件已删除）。
// 改用权威工具名清单 core/tool-order.json 的 tool_order 构造「含 name 的工具对象数组」：
// filterTools / 无漂移断言仅依赖 name 属性，语义与原 CUSTOM_TOOLS 一致；tool_order 涵盖核心+插件全部工具。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = JSON.parse(readFileSync(path.join(__dirname, '..', 'core', 'tool-order.json'), 'utf-8'));
const CUSTOM_TOOLS = MANIFEST.tool_order.map((name) => ({ name }));

let passed = 0;
function ok(name) { passed++; console.log(`  ✅ ${name}`); }

console.log('── 1. 开关判定 ──');
{
  const cases = [
    ['true', true], ['TRUE', true], ['True', true],
    ['1', true], ['yes', true], ['YES', true], ['on', true], [' ON ', true],
    [undefined, false], ['', false], ['false', false], ['0', false], ['no', false], ['off', false], ['anything', false],
  ];
  for (const [v, expect] of cases) {
    if (v === undefined) delete process.env.VRC_MONITOR_SAFE_MODE;
    else process.env.VRC_MONITOR_SAFE_MODE = v;
    assert.equal(isSafeModeEnabled(), expect, `VRC_MONITOR_SAFE_MODE=${JSON.stringify(v)}`);
  }
  ok(`${cases.length} 个取值组合判定正确`);
}

console.log('── 2. 单元：过滤与拦截 ──');
{
  // 关闭态：不过滤、不拦截
  delete process.env.VRC_MONITOR_SAFE_MODE;
  assert.equal(filterTools(CUSTOM_TOOLS), CUSTOM_TOOLS, '关闭态 filterTools 应原样返回');
  assert.doesNotThrow(() => assertToolAllowed('remove_friend'), '关闭态不应拦截');
  ok('关闭态：filterTools 原样返回、assertToolAllowed 放行');

  // 开启态：过滤 + 拦截
  process.env.VRC_MONITOR_SAFE_MODE = 'true';
  const filtered = filterTools(CUSTOM_TOOLS);
  const names = new Set(filtered.map(t => t.name));
  assert.equal(filtered.length, CUSTOM_TOOLS.length - DESTRUCTIVE_TOOLS.length, '过滤数量不对');
  for (const t of DESTRUCTIVE_TOOLS) {
    assert.ok(!names.has(t), `破坏性工具 ${t} 不应出现在过滤后列表`);
  }
  assert.ok(names.has('get_online_friends') && names.has('favorite_world') && names.has('submit_totp'), '普通工具应保留');
  assert.throws(() => assertToolAllowed('remove_friend'), (e) => e.safeModeBlocked === true, 'remove_friend 应被拦截');
  assert.throws(() => assertToolAllowed('unfavorite_friend'), (e) => e.safeModeBlocked === true, 'unfavorite_friend 应被拦截');
  assert.doesNotThrow(() => assertToolAllowed('get_online_friends'), '普通工具不应被拦截');
  ok(`开启态：剔除 ${DESTRUCTIVE_TOOLS.length} 个破坏性工具（剩 ${filtered.length} 个），拦截生效`);
}

console.log('── 2b. 单元：destructive 标志优先、硬编码清单兜底 ──');
{
  process.env.VRC_MONITOR_SAFE_MODE = 'true';
  const customTools = [
    { name: 'get_online_friends' },
    { name: 'wipe_everything', destructive: true },   // 不在硬编码清单，标志为 true
    { name: 'remove_friend' },                        // 硬编码清单兜底
    { name: 'purge_cache', destructive: false },      // 非破坏性
  ];
  const filtered = filterTools(customTools);
  assert.deepEqual(
    filtered.map(t => t.name),
    ['get_online_friends', 'purge_cache'],
    'destructive:true（不在硬编码清单）应被过滤，硬编码清单兜底，destructive:false 保留'
  );
  assert.throws(() => assertToolAllowed('wipe_everything', true), (e) => e.safeModeBlocked === true,
    'destructive:true 工具即使不在硬编码清单也应拦截');
  assert.doesNotThrow(() => assertToolAllowed('purge_cache', false), 'destructive:false 且不在清单 → 放行');
  assert.throws(() => assertToolAllowed('remove_friend'), (e) => e.safeModeBlocked === true,
    '硬编码清单兜底：仅凭名字拦截（不依赖标志）');
  ok('destructive 标志优先过滤/拦截，硬编码 DESTRUCTIVE_TOOLS 清单兜底');
}

console.log('── 3. 单元：破坏性工具清单无漂移 ──');
{
  const allNames = new Set(CUSTOM_TOOLS.map(t => t.name));
  const missing = DESTRUCTIVE_TOOLS.filter(t => !allNames.has(t));
  assert.deepEqual(missing, [], `DESTRUCTIVE_TOOLS 含不存在的工具: ${missing.join(', ')}`);
  ok(`DESTRUCTIVE_TOOLS 全部 ${DESTRUCTIVE_TOOLS.length} 个名字均存在于 CUSTOM_TOOLS`);
}

// ── 端到端：真实 HTTP 服务器（独立端口 8899，不碰运行中的 8799）──
async function e2e(envValue, label, expectRemoved, port) {
  console.log(`── 4/5. 端到端（${label}）──`);
  if (envValue === undefined) delete process.env.VRC_MONITOR_SAFE_MODE;
  else process.env.VRC_MONITOR_SAFE_MODE = envValue;

  ctx.paths.PORT = port;
  ctx.rateLimiter = new RateLimiter({ minInterval: 1 });
  // 最小 ctx 桩：e2e 用核心离线的 get_server_status 做「普通工具仍可用」样例，其 handler 读 ctx.storage/serverState。
  if (!ctx.storage) ctx.storage = { getStats: () => ({ events: 0, friends: 0 }) };
  if (!ctx.serverState) ctx.serverState = { started: Date.now(), authUser: null, needsTotp: false };
  const server = createServer();
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  async function mcp(body) {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    return JSON.parse(dataLine.slice(6));
  }

  try {
    // tools/list
    const listResp = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const toolNames = new Set(listResp.result.tools.map(t => t.name));
    // 仅对「当前已注册」的破坏性工具断言可见性：DESTRUCTIVE_TOOLS 含插件工具（如 remove_print /
    // unfavorite_world / move_world_group，属 media/favorites 插件），本测试未加载插件故未注册，
    // 跳过以免误报；核心已注册的破坏性工具（如 remove_friend）按开关态断言。
    const registeredDestructive = DESTRUCTIVE_TOOLS.filter(t => getRegistryMap().has(t));
    for (const t of registeredDestructive) {
      assert.equal(toolNames.has(t), !expectRemoved, `${label}: tools/list 中 ${t} 可见性错误`);
    }
    assert.equal(toolNames.has('get_online_friends'), true, `${label}: 普通工具应始终可见`);
    ok(`${label}: tools/list ${expectRemoved ? '已剔除' : '包含'}全部破坏性工具（共 ${listResp.result.tools.length} 个）`);

    if (expectRemoved) {
      // tools/call 拦截：破坏性工具 → JSON-RPC 错误
      const blockedResp = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remove_friend', arguments: { displayName: 'x', confirm: true } } });
      assert.ok(blockedResp.error, `${label}: remove_friend 应返回错误`);
      assert.match(blockedResp.error.message, /安全模式/, `${label}: 错误信息应说明安全模式，实际: ${blockedResp.error.message}`);
      ok(`${label}: tools/call remove_friend 被拦截（error.message 含「安全模式」）`);

      // tools/call 正常工具仍可用（用核心离线的 get_server_status；get_boop_emojis 原为 media 插件工具，本测试未加载插件故未注册）
      const okResp = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_server_status', arguments: {} } });
      assert.ok(okResp.result?.content?.[0]?.text, `${label}: get_server_status 应成功`);
      ok(`${label}: tools/call get_server_status 正常返回`);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
}

await e2e('true', '安全模式开启', true, 8899);
await e2e(undefined, '安全模式关闭', false, 8898);

console.log(`\n🎉 全部 ${passed} 项断言通过`);
