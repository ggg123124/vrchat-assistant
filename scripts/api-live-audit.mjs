// 全量 GET 实测审计：用服务真实会话（auth cookie）+ 规范路径清单逐个探测，
// 输出「端点 → 状态 → 响应形状」矩阵。改为基于 VrchatApiClient._request 原语——
// 旧版脚本按已不存在的具名方法编写（vrchat-api.js 搬家至仓库根 + 方法面收窄），无法运行。
// 用法：VRC_MONITOR_DIR=<仓库路径> COOKIE_FILE=<cookie文件> [VRC_MONITOR_USER_ID=<userId>] node scripts/api-live-audit.mjs
// ⚠️ Windows/git-bash：VRC_MONITOR_DIR 必须用原生路径（如 D:/workspace/vrcx-mcp-actions）；
//    写成 MSYS 形态（/d/workspace/...）会被原生 node 当成本地盘符下的相对路径 → ERR_MODULE_NOT_FOUND。
// 只读探测：仅 GET；限速 400ms/次；素材 ID 自动从 auth/user 与本地 DB 采集。
// 日志脱敏（CodeQL #20）：本脚本读的 env（VRC_MONITOR_USER_ID / COOKIE_FILE / DIR / DB_PATH）
// 会经请求路径进入超时错误消息，再被回显 → id 明文进日志。因此**输出一律只用占位标签**
// （<self>/<friend>/<group>/<world>/<file>）与错误类别（e.code/e.name），请求路径本身仍用真实 id。
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

// Windows 兼容（review #175 🔴1）：ESM import 的绝对路径必须是 file:// URL，
// 裸盘符路径（D:/...）会 ERR_UNSUPPORTED_ESM_URL_SCHEME；默认 REPO 也要 fileURLToPath 归一。
const REPO = process.env.VRC_MONITOR_DIR || fileURLToPath(new URL('..', import.meta.url));
const { VrchatApiClient } = await import(pathToFileURL(path.join(REPO, 'vrchat-api.js')).href);
const api = new VrchatApiClient('', '');
api.loadCookieFromFile(process.env.COOKIE_FILE || path.join(REPO, 'data', 'auth_cookie.txt'));
try { await api.ensureAuth(); } catch (e) { console.log('ensureAuth 失败（继续用现有 cookie）:', errorKind(e)); }

const dbPath = process.env.VRC_MONITOR_DB_PATH || path.join(REPO, 'data', 'vrc-monitor.sqlite3');
const db = new Database(dbPath, { readonly: true });

const meRes = await api._request('GET', '/auth/user');
const me = meRes.data || {};
// fail-fast（review #175 ⚠️1）：认证失效若不拦截，me.id=undefined 会让下游 URL
// 退化成 /users/undefined/...，把「认证失效」伪装成「端点不可用」
if (!me.id) {
  console.error(`认证失效：/auth/user 返回 ${meRes.status}（检查 COOKIE_FILE 的 auth cookie 是否有效）`);
  process.exit(1);
}
const SELF = process.env.VRC_MONITOR_USER_ID || me.id;
const friend = db.prepare("SELECT user_id, display_name FROM friends LIMIT 1").get();
const grp = db.prepare('SELECT group_id, name FROM group_cache LIMIT 1').get();
const world = db.prepare('SELECT world_id FROM world_cache LIMIT 1').get();
const files = (await api._request('GET', '/files?n=5')).data || [];
const fileId = files[0] && files[0].id;
console.log(`素材: self=${me.displayName} friend=${friend ? friend.display_name : '无'} group=${grp ? grp.name : '无'}`);

const results = [];

/** 错误类别：只取稳定标识，不回显 e.message（超时消息形如 "请求超时: GET /users/usr_xxx/..."，
 *  路径含 env 派生 id → 明文进日志，CodeQL #20）。 */
function errorKind(e) {
  if (!e) return 'Error';
  if (e.code) return String(e.code);
  if (e.name && e.name !== 'Error') return String(e.name);
  return 'Error';
}

/**
 * 探测单个端点。
 * @param {string} name     人读名称
 * @param {string} p        真实请求路径（可含真实 id）
 * @param {string} logPath  日志用占位路径（**必须是字面量**，不含真实 id）
 */
async function probe(name, p, logPath) {
  if (!p) return;
  const startedAt = Date.now();
  try {
    const r = await api._request('GET', p);
    const d = r.data;
    const info = Array.isArray(d) ? `数组[${d.length}]`
      : typeof d === 'object' && d ? Object.keys(d).slice(0, 5).join(',')
      : String(d).slice(0, 30);
    results.push({ name, status: String(r.status), info, path: logPath });
  } catch (e) {
    // 客户端超时为 15s（vrchat-api.js REQUEST_TIMEOUT_MS），据此还原"超时"信号——
    // 不再从 e.message 里取（那会带回请求路径）
    const slow = Date.now() - startedAt >= 14000;
    results.push({ name, status: 'THROW', info: slow ? '超时(≥14s)' : errorKind(e), path: logPath });
  }
  await new Promise(r => setTimeout(r, 400));
}

// Phase 1: 无参/自足 GET
await probe('配置', '/config');
await probe('在线人数', '/visits');
await probe('认证状态', '/auth');
await probe('收藏上限', '/auth/user/favoritelimits');
await probe('通知(legacy)', '/auth/user/notifications?n=10');
await probe('玩家屏蔽', '/auth/user/playermoderations');
await probe('头像审核屏蔽', '/auth/user/avatarmoderations');
await probe('收藏分组', '/favorite/groups?n=50');
await probe('好友收藏', '/favorites?type=friend&n=50');
await probe('世界收藏', '/favorites?type=world&n=50');
await probe('文件列表', '/files?n=20');
await probe('邀请消息模板', `/message/${me.id}/message?n=20`, `/message/<self>/message?n=20`);
await probe('日历(全部)', '/calendar?n=10');
await probe('日历(精选)', '/calendar/featured');
await probe('日历(关注)', '/calendar/following');
await probe('物品栏', '/inventory?n=20');
await probe('全局物品', '/inventory/global');
await probe('掉落', '/inventory/drops');
await probe('群组角色模板', '/groups/roleTemplates');
await probe('账号权限', '/auth/permissions');

// Phase 2: 素材 ID 参数化 GET
await probe('我的群组', `/users/${SELF}/groups`, `/users/<self>/groups`);
await probe('代表群组', `/users/${SELF}/groups/represented`, `/users/<self>/groups/represented`);
await probe('群组邀请', `/users/${SELF}/groups/invited`, `/users/<self>/groups/invited`);
await probe('我的反馈', `/users/${SELF}/feedback`, `/users/<self>/feedback`);
await probe('自己详情', `/users/${SELF}`, `/users/<self>`);
await probe('自己头像', `/users/${SELF}/avatar`, `/users/<self>/avatar`);
await probe('群组实例', `/users/${SELF}/instances/groups?n=10`, `/users/<self>/instances/groups?n=10`);
if (friend) {
  await probe(`共同好友@${friend.display_name}`, `/users/${friend.user_id}/mutuals/friends?n=10`, `/users/<friend>/mutuals/friends?n=10`);
  await probe(`共同群组@${friend.display_name}`, `/users/${friend.user_id}/mutuals/groups`, `/users/<friend>/mutuals/groups`);
  await probe('好友状态', `/user/${friend.user_id}/friendStatus`, `/user/<friend>/friendStatus`);
}
if (grp) {
  await probe('群组相册', `/groups/${grp.group_id}/galleries`, `/groups/<group>/galleries`);
  await probe('群组帖子', `/groups/${grp.group_id}/posts?n=10`, `/groups/<group>/posts?n=10`);
  await probe('群组公告', `/groups/${grp.group_id}/announcement`, `/groups/<group>/announcement`);
  await probe('群组成员', `/groups/${grp.group_id}/members?n=5`, `/groups/<group>/members?n=5`);
  await probe('群组审计类型', `/groups/${grp.group_id}/auditLogTypes`, `/groups/<group>/auditLogTypes`);
}
if (world) await probe('世界元数据', `/worlds/${world.world_id}/metadata`, `/worlds/<world>/metadata`);
if (fileId) await probe('文件详情(单数 /file)', `/file/${fileId}`, `/file/<file>`);

// 输出矩阵
for (const r of results) console.log(`[${r.status.padEnd(5)}] ${r.name} :: ${r.info}`);
const ok = results.filter(r => r.status === '200').length;
console.log(`\n矩阵: ${ok}/${results.length} 200 | 非200 明细:`);
for (const r of results.filter(r => r.status !== '200')) console.log(`  [${r.status}] ${r.name} (${r.path}) ${r.info.slice(0, 40)}`);
