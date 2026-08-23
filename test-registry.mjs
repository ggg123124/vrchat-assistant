/**
 * test-registry.mjs — PR-1 registry 完整性无凭据测试（自包含，供 CI 使用）
 *
 * 校验：
 *   1. listTools() 数量与 core/tool-order.json 一致
 *   2. 工具名唯一
 *   3. 每个工具定义合法（name/description/inputSchema/handler）
 *   4. listTools() 返回顺序与 tool-order.json 完全一致
 *   5. dispatch 能路由到真实 handler（无副作用工具，测试环境无凭据）
 *   6. safe-mode 开启时破坏性工具被过滤/拦截
 */
import { readFileSync } from 'node:fs';
import * as registry from './core/registry.js';

const order = JSON.parse(readFileSync(new URL('./core/tool-order.json', import.meta.url), 'utf-8')).tool_order;

let pass = true;
const errors = [];

function assert(cond, msg) {
  if (!cond) {
    pass = false;
    errors.push(msg);
  }
}

const safeMode = process.env.VRC_MONITOR_SAFE_MODE === 'true';
const tools = registry.listTools();
const names = tools.map(t => t.name);

// 1. 数量（safe-mode 下为 91 - 10 破坏性 = 81）
const expectedCount = safeMode ? order.length - 10 : order.length;
assert(tools.length === expectedCount, `listTools() returned ${tools.length}, expected ${expectedCount}`);

// 2. 唯一性
assert(new Set(names).size === names.length, 'duplicate tool names detected');

// 3. 定义合法 + handler 存在
const map = registry.getRegistryMap ? registry.getRegistryMap() : null;
for (const t of tools) {
  assert(typeof t.name === 'string' && t.name.length > 0, 'tool missing name');
  assert(typeof t.description === 'string', `tool ${t.name} missing description`);
  assert(t.inputSchema && typeof t.inputSchema === 'object' && t.inputSchema.type === 'object', `tool ${t.name} has invalid inputSchema`);
  if (map) {
    assert(map.has(t.name) && typeof map.get(t.name).handler === 'function', `tool ${t.name} missing handler in registry map`);
  }
}

// 4. 顺序与 tool-order.json 一致（非安全模式）
if (!safeMode) {
  assert(JSON.stringify(names) === JSON.stringify(order), 'listTools() order differs from core/tool-order.json');
}

// 5. 非安全模式下，无副作用工具应能路由到 handler 并执行（get_server_status 无凭据也能跑）
try {
  const r = await registry.dispatch('get_server_status', {});
  assert(r && typeof r === 'object', 'dispatch(get_server_status) returned unexpected result');
} catch (err) {
  assert(!err.message.startsWith('Unknown tool'), `dispatch('get_server_status') did not reach handler: ${err.message}`);
}

// 6. safe-mode 破坏性过滤与拦截
if (safeMode) {
  const destructive = ['remove_print','remove_gallery_image','remove_friend','remove_from_backlog','remove_from_watchlist','leave_group','unfavorite_friend','move_friend_group','hide_notification','decline_friend_request'];
  assert(JSON.stringify(names) === JSON.stringify(order.filter(n => !destructive.includes(n))), 'safe mode should filter exactly the 10 destructive tools');
  let blocked = false;
  try {
    await registry.dispatch('remove_print', { printId: 'test' });
  } catch (err) {
    blocked = err.message.includes('blocked in safe mode');
  }
  assert(blocked, 'remove_print should be blocked in safe mode');
}

if (pass) {
  console.log('PR-1 registry integrity: PASS');
  process.exit(0);
} else {
  console.log('PR-1 registry integrity: FAIL');
  for (const e of errors) console.log(' -', e);
  process.exit(1);
}
