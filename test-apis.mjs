/**
 * VRChat API 全面测试脚本
 * 验证 vrchat-api-reference.md 中的每个 API 端点
 * 速率控制：每次调用间隔 2.5 秒（约 24 次/分钟，低于 30次/分钟限制）
 */
import { VrchatApiClient } from './vrchat-api.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COOKIE_FILE = fileURLToPath(new URL('./auth_cookie.txt', import.meta.url));
const CRED_FILE = fileURLToPath(new URL('./credentials.json', import.meta.url));

// ── 测试结果跟踪 ──
const results = [];
let passed = 0, failed = 0;

function report(category, apiName, status, detail, data = null) {
  const entry = { category, apiName, status, detail };
  if (data) entry.dataPreview = JSON.stringify(data).slice(0, 200);
  results.push(entry);
  if (status === '✅') passed++;
  else failed++;
  console.log(`  ${status}  ${apiName}: ${detail}`);
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── 主测试流程 ──
async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  VRChat API 全面测试');
  console.log('══════════════════════════════════════════════\n');

  // 读取凭证
  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  const api = new VrchatApiClient(creds.email, creds.password);

  // ── Phase 0: 认证 ──
  console.log('═══ Phase 0: 认证 ────────────────────────────\n');
  
  // 0a. 尝试加载 cookie
  const hasCookie = api.loadCookieFromFile(COOKIE_FILE);
  report('认证', 'loadCookie', hasCookie ? '✅' : '⚠️',
    `Cookie 文件${hasCookie ? '存在' : '不存在'}, 长度=${api.authCookie.length}`);

  // 0b. 验证 cookie 或登录
  await sleep(500);
  let userData = null;
  try {
    userData = await api.ensureAuth();
    report('认证', 'ensureAuth', '✅',
      `用户: ${userData.displayName} (${userData.id}), 信任等级: ${userData.developerType || 'unknown'}`);
    api.saveCookieToFile(COOKIE_FILE);
  } catch (err) {
    if (err.needsOtp) {
      report('认证', 'ensureAuth', '⚠️', '需要 OTP — 尝试自动获取...');
      // 尝试从 QQ 邮箱获取 OTP
      const { execSync } = await import('node:child_process');
      const otpScript = fileURLToPath(new URL('./fetch-otp.py', import.meta.url));
      const { existsSync } = await import('node:fs');
      if (existsSync(otpScript)) {
        try {
          const otp = execSync(
            `python "${otpScript}" "${creds.email}" "${creds.qqmail_auth_code}"`,
            { timeout: 15000, encoding: 'utf-8' }
          ).trim();
          if (/^\d{6}$/.test(otp)) {
            await api.loginWithOtp(otp);
            userData = api.currentUser;
            api.saveCookieToFile(COOKIE_FILE);
            report('认证', 'ensureAuth+OTP', '✅',
              `OTP 登录成功: ${userData.displayName}`);
          } else {
            report('认证', 'ensureAuth+OTP', '❌', `无效 OTP: ${otp}`);
            process.exit(1);
          }
        } catch (otpErr) {
          report('认证', 'ensureAuth+OTP', '❌', `OTP 失败: ${otpErr.message}`);
          process.exit(1);
        }
      } else {
        report('认证', 'ensureAuth+OTP', '❌', 'OTP 脚本不存在');
        process.exit(1);
      }
    } else {
      report('认证', 'ensureAuth', '❌', `登录失败: ${err.message}`);
      process.exit(1);
    }
  }

  const currentUserId = userData.id;

  // ═══════════════════════════════════════════════
  // Phase 1: 好友 API
  // ═══════════════════════════════════════════════
  console.log('\n═══ Phase 1: 好友 API ─────────────────────────\n');

  await sleep(2500);

  // 1a. 在线好友列表
  try {
    const r = await api._request('GET', '/auth/user/friends?offline=false');
    const friends = Array.isArray(r.data) ? r.data : [];
    const online = friends.filter(f => f.location && f.location !== 'offline');
    report('好友', 'GET /friends?offline=false', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 在线好友=${online.length}, 总计=${friends.length}`,
      online.length > 0 ? { first: { id: online[0].id, name: online[0].displayName, location: online[0].location } } : null);
  } catch (err) {
    report('好友', 'GET /friends?offline=false', '❌', err.message);
  }

  await sleep(2500);

  // 1b. 全部好友列表
  try {
    // 只取前3个，避免数据量太大
    const r = await api._request('GET', '/auth/user/friends?offline=true&n=100&offset=0');
    const friends = Array.isArray(r.data) ? r.data : [];
    const named = friends.filter(f => f.displayName && f.displayName.length > 0);
    report('好友', 'GET /friends?offline=true', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 好友总数=${friends.length}, 有名字=${named.length}`,
      friends.length > 0 ? { sample: { id: friends[0].id, name: friends[0].displayName, status: friends[0].status } } : null);
  } catch (err) {
    report('好友', 'GET /friends?offline=true', '❌', err.message);
  }

  await sleep(2500);

  // 1c. friendStatus — 检查当前用户自己（应是好友）
  try {
    const r = await api._request('GET', `/user/${currentUserId}/friendStatus`);
    report('好友', `GET /user/{userId}/friendStatus`, r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, isFriend=${r.data?.isFriend}, incoming=${r.data?.incomingRequest}`);
  } catch (err) {
    report('好友', `GET /user/{userId}/friendStatus`, '❌', err.message);
  }

  // ═══════════════════════════════════════════════
  // Phase 2: 用户 API
  // ═══════════════════════════════════════════════
  console.log('\n═══ Phase 2: 用户 API ─────────────────────────\n');

  await sleep(2500);

  // 2a. 获取当前用户详情
  try {
    const r = await api._request('GET', '/auth/user');
    const u = r.data;
    report('用户', 'GET /auth/user (当前用户)', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, displayName=${u.displayName}, id=${u.id}, tags=${(u.tags||[]).length}`);
  } catch (err) {
    report('用户', 'GET /auth/user', '❌', err.message);
  }

  await sleep(2500);

  // 2b. 获取某个好友详情（取第一个在线好友）
  try {
    const friendsR = await api._request('GET', '/auth/user/friends?offline=false&n=3');
    const targetId = Array.isArray(friendsR.data) && friendsR.data.length > 0
      ? friendsR.data[0].id : currentUserId;
    
    const r = await api._request('GET', `/users/${targetId}`);
    const u = r.data;
    report('用户', 'GET /users/{userId}', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, displayName=${u.displayName}, worldId=${u.worldId?.slice(0,20)}, state=${u.state}, platform=${u.platform}, tags=${(u.tags||[]).length}, pastNames=${(u.pastDisplayNames||[]).length}`);
  } catch (err) {
    report('用户', 'GET /users/{userId}', '❌', err.message);
  }

  await sleep(2500);

  // 2c. 搜索用户
  try {
    const r = await api._request('GET', `/users?search=风&n=5`);
    const users = Array.isArray(r.data) ? r.data : [];
    report('用户', 'GET /users?search=', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 搜索结果=${users.length}条`,
      users.length > 0 ? { names: users.map(u => u.displayName) } : null);
  } catch (err) {
    report('用户', 'GET /users?search=', '❌', err.message);
  }

  await sleep(2500);

  // 2d. 用户的群组
  try {
    const r = await api._request('GET', `/users/${currentUserId}/groups`);
    const groups = Array.isArray(r.data) ? r.data : [];
    report('用户', 'GET /users/{userId}/groups', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 群组数量=${groups.length}`);
  } catch (err) {
    report('用户', 'GET /users/{userId}/groups', '❌', err.message);
  }

  await sleep(2500);

  // 2e. 共同好友数
  try {
    const r = await api._request('GET', `/users/${currentUserId}/mutuals`);
    report('用户', 'GET /users/{userId}/mutuals', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 数据=${JSON.stringify(r.data).slice(0,100)}`);
  } catch (err) {
    report('用户', 'GET /users/{userId}/mutuals', '❌', err.message);
  }

  await sleep(2500);

  // 2f. 展示的群组
  try {
    const r = await api._request('GET', `/users/${currentUserId}/groups/represented`);
    report('用户', 'GET /users/{userId}/groups/represented', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 响应=${r.data?.id ? `group: ${r.data.id}` : '无'}`);
  } catch (err) {
    report('用户', 'GET /users/{userId}/groups/represented', '⚠️', err.message);
  }

  // ═══════════════════════════════════════════════
  // Phase 3: 世界 API
  // ═══════════════════════════════════════════════
  console.log('\n═══ Phase 3: 世界 API ─────────────────────────\n');

  await sleep(2500);

  // 3a. 获取世界信息（用一个测试世界ID）
  // 先试试从在线好友拿一个 worldId
  let testWorldId = 'wrld_71b11d71-882e-4c65-a48f-2e6b04230ab6'; // The Great Pug
  try {
    const friendsR = await api._request('GET', '/auth/user/friends?offline=true&n=5');
    if (Array.isArray(friendsR.data)) {
      for (const f of friendsR.data) {
        if (f.worldId && f.worldId !== 'offline') {
          testWorldId = f.worldId;
          break;
        }
      }
    }
  } catch {}
  
  await sleep(500);
  try {
    const r = await api._request('GET', `/worlds/${testWorldId}`);
    const w = r.data;
    report('世界', 'GET /worlds/{worldId}', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, name="${w.name}", capacity=${w.capacity}, occupants=${w.occupants}, author=${w.authorName}, releaseStatus=${w.releaseStatus}`);
  } catch (err) {
    report('世界', 'GET /worlds/{worldId}', '❌', err.message);
  }

  await sleep(2500);

  // 3b. 搜索世界
  try {
    const r = await api._request('GET', `/worlds?search=Pug&n=3`);
    const worlds = Array.isArray(r.data) ? r.data : [];
    report('世界', 'GET /worlds?search=', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 搜索结果=${worlds.length}条`,
      worlds.length > 0 ? { names: worlds.map(w => w.name).slice(0,3) } : null);
  } catch (err) {
    report('世界', 'GET /worlds?search=', '❌', err.message);
  }

  await sleep(2500);

  // 3c. 收藏的世界
  try {
    const r = await api._request('GET', '/worlds/favorites?n=3');
    const worlds = Array.isArray(r.data) ? r.data : [];
    report('世界', 'GET /worlds/favorites', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 收藏世界数=${worlds.length}`);
  } catch (err) {
    report('世界', 'GET /worlds/favorites', '⚠️', err.message);
  }

  // ═══════════════════════════════════════════════
  // Phase 4: 实例 API
  // ═══════════════════════════════════════════════
  console.log('\n═══ Phase 4: 实例 API ─────────────────────────\n');

  await sleep(2500);

  // 4a. 获取实例信息
  try {
    const r = await api._request('GET', `/instances/${testWorldId}:12345`);
    report('实例', 'GET /instances/{worldId}:{instanceId}', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 位置=${r.data?.location?.slice(0,30)}, 活跃用户=${r.data?.activeUsers}`);
  } catch (err) {
    report('实例', 'GET /instances/{worldId}:{instanceId}', '⚠️', `状态码错误或实例不存在 (预期中，实例可能已关闭): ${err.message}`);
  }

  await sleep(2500);

  // 4b. 配置信息
  try {
    const r = await api._request('GET', '/config');
    const c = r.data;
    report('其他', 'GET /config', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, appName=${c?.appName}, deployVersion=${c?.deployVersion?.version}`);
  } catch (err) {
    report('其他', 'GET /config', '❌', err.message);
  }

  // ═══════════════════════════════════════════════
  // Phase 5: Avatar API
  // ═══════════════════════════════════════════════
  console.log('\n═══ Phase 5: Avatar API ────────────────────────\n');

  await sleep(2500);

  // 5a. 当前用户的 Avatar
  try {
    if (userData.currentAvatar) {
      const r = await api._request('GET', `/avatars/${userData.currentAvatar}`);
      const a = r.data;
      report('Avatar', 'GET /avatars/{avatarId}', r.status === 200 ? '✅' : '⚠️',
        `状态=${r.status}, name="${a.name}", authorName=${a.authorName}, platform=${a.platform || 'unknown'}`);
    } else {
      report('Avatar', 'GET /avatars/{avatarId}', '⚠️', '当前用户无 currentAvatar 字段');
    }
  } catch (err) {
    report('Avatar', 'GET /avatars/{avatarId}', '❌', err.message);
  }

  await sleep(2500);

  // 5b. 上传的 Avatar 列表
  try {
    const r = await api._request('GET', `/avatars?userId=${currentUserId}&n=5&sort=updated`);
    const avatars = Array.isArray(r.data) ? r.data : [];
    report('Avatar', 'GET /avatars?userId=', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, Avatar数量=${avatars.length}`);
  } catch (err) {
    report('Avatar', 'GET /avatars?userId=', '❌', err.message);
  }

  await sleep(2500);

  // 5c. Avatar 样式
  try {
    const r = await api._request('GET', '/avatarStyles');
    report('Avatar', 'GET /avatarStyles', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 样式数=${Object.keys(r.data||{}).length}`);
  } catch (err) {
    report('Avatar', 'GET /avatarStyles', '❌', err.message);
  }

  // ═══════════════════════════════════════════════
  // Phase 6: 通知 API
  // ═══════════════════════════════════════════════
  console.log('\n═══ Phase 6: 通知 API ──────────────────────────\n');

  await sleep(2500);

  // 6a. 获取通知列表
  try {
    const r = await api._request('GET', '/auth/user/notifications?n=10');
    const notifs = Array.isArray(r.data) ? r.data : [];
    report('通知', 'GET /auth/user/notifications', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 通知数=${notifs.length}`);
  } catch (err) {
    report('通知', 'GET /auth/user/notifications', '❌', err.message);
  }

  await sleep(2500);

  // 6b. 收藏限制
  try {
    const r = await api._request('GET', '/auth/user/favoritelimits');
    report('收藏', 'GET /auth/user/favoritelimits', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 数据=${JSON.stringify(r.data).slice(0,120)}`);
  } catch (err) {
    report('收藏', 'GET /auth/user/favoritelimits', '❌', err.message);
  }

  await sleep(2500);

  // 6c. 收藏列表
  try {
    const r = await api._request('GET', '/favorites?n=10&offset=0');
    const favs = Array.isArray(r.data) ? r.data : [];
    const types = {};
    favs.forEach(f => { types[f.type] = (types[f.type]||0) + 1; });
    report('收藏', 'GET /favorites', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 收藏数=${favs.length}, 类型分布=${JSON.stringify(types)}`);
  } catch (err) {
    report('收藏', 'GET /favorites', '❌', err.message);
  }

  await sleep(2500);

  // 6d. 收藏分组
  try {
    const r = await api._request('GET', '/favorite/groups?n=10&offset=0');
    const groups = Array.isArray(r.data) ? r.data : [];
    report('收藏', 'GET /favorite/groups', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 分组数=${groups.length}`);
  } catch (err) {
    report('收藏', 'GET /favorite/groups', '⚠️', err.message);
  }

  // ═══════════════════════════════════════════════
  // Phase 7: 玩家管控 & 备注
  // ═══════════════════════════════════════════════
  console.log('\n═══ Phase 7: 管控 & 备注 ───────────────────────\n');

  await sleep(2500);

  // 7a. 玩家管控列表
  try {
    const r = await api._request('GET', '/auth/user/playermoderations');
    const mods = Array.isArray(r.data) ? r.data : [];
    report('管控', 'GET /auth/user/playermoderations', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 管控数=${mods.length}`);
  } catch (err) {
    report('管控', 'GET /auth/user/playermoderations', '⚠️', err.message);
  }

  await sleep(2500);

  // 7b. 收藏的 Avatar
  try {
    const r = await api._request('GET', '/avatars/favorites?n=3');
    const favAvatars = Array.isArray(r.data) ? r.data : [];
    report('收藏', 'GET /avatars/favorites', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, 收藏Avatar数=${favAvatars.length}`);
  } catch (err) {
    report('收藏', 'GET /avatars/favorites', '⚠️', err.message);
  }

  // ═══════════════════════════════════════════════
  // Phase 8: WebSocket Token
  // ═══════════════════════════════════════════════
  console.log('\n═══ Phase 8: WebSocket ──────────────────────────\n');

  await sleep(2500);

  // 8a. 获取 WebSocket token
  try {
    const r = await api._request('GET', '/auth');
    report('WebSocket', 'GET /auth', r.status === 200 ? '✅' : '⚠️',
      `状态=${r.status}, ok=${r.data?.ok}, hasToken=${!!(r.data?.token)}`);
  } catch (err) {
    report('WebSocket', 'GET /auth', '❌', err.message);
  }

  // ═══════════════════════════════════════════════
  // 结果汇总
  // ═══════════════════════════════════════════════
  console.log('\n══════════════════════════════════════════════');
  console.log('  测试完成');
  console.log('══════════════════════════════════════════════\n');
  console.log(`  通过: ${passed}  ✅`);
  console.log(`  失败: ${failed}  ${failed > 0 ? '❌' : '✅'}`);
  console.log(`  总计: ${results.length}\n`);

  // 打印详细表格
  console.log('详细结果:');
  console.log('┌──────────────────────┬────────────────────────────────────────────┬──────┬──────────────────────────────┐');
  console.log('│ 分类                 │ API                                        │ 结果 │ 详情                        │');
  console.log('├──────────────────────┼────────────────────────────────────────────┼──────┼──────────────────────────────┤');
  for (const r of results) {
    const cat = r.category.padEnd(18).slice(0,18);
    const name = r.apiName.padEnd(38).slice(0,38);
    const status = r.status.padEnd(4).slice(0,4);
    const detail = r.detail.slice(0,36).padEnd(36).slice(0,36);
    console.log(`│ ${cat} │ ${name} │ ${status} │ ${detail} │`);
  }
  console.log('└──────────────────────┴────────────────────────────────────────────┴──────┴──────────────────────────────┘');

  // 保存结果到文件
  const { writeFileSync } = await import('node:fs');
  writeFileSync(
    'api-test-results.json',
    JSON.stringify({ summary: { passed, failed, total: results.length }, results }, null, 2)
  );
  console.log('\n结果已保存到 api-test-results.json');
}

main().catch(err => {
  console.error('测试脚本异常:', err);
  process.exit(1);
});
