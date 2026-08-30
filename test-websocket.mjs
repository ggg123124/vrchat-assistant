/**
 * VRChat WebSocket 连接测试脚本 (经过代理)
 * 
 * 连接 wss://pipeline.vrchat.cloud 并监听事件
 * 固定监听时长: 120 秒
 * 代理: http://127.0.0.1:7892
 */
import { VrchatApiClient } from './vrchat-api.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

const COOKIE_FILE = fileURLToPath(new URL('./auth_cookie.txt', import.meta.url));
const CRED_FILE = fileURLToPath(new URL('./credentials.json', import.meta.url));
const PROXY = 'http://127.0.0.1:7892';
const LISTEN_DURATION_MS = 120_000; // 2 分钟

const eventCounts = {};
const eventSamples = {};
let totalEvents = 0;
let connectedAt = null;
let disconnectedAt = null;

function recordEvent(type, data) {
  totalEvents++;
  eventCounts[type] = (eventCounts[type] || 0) + 1;
  if (!eventSamples[type]) eventSamples[type] = [];
  if (eventSamples[type].length < 2) {
    eventSamples[type].push({
      time: new Date().toISOString().slice(11, 19),
      preview: JSON.stringify(data).slice(0, 300)
    });
  }
}

function formatContent(parsed) {
  const type = parsed.type || 'unknown';
  let content = parsed.content || {};
  if (typeof content === 'string') {
    try { content = JSON.parse(content); } catch {}
  }
  const userId = content?.userId || content?.user?.id || content?.id || '?';
  const displayName = content?.displayName || content?.user?.displayName || '';
  const location = content?.location || '';
  const extra = displayName ? ` name=${displayName}` : '';
  const loc = location ? ` loc=${location.slice(0,30)}` : '';
  return `${type} | userId=${userId}${extra}${loc}`;
}

async function main() {
  console.log('══════════════════════════════════════════════');
  console.log('  VRChat WebSocket 连接测试 (经代理)');
  console.log('══════════════════════════════════════════════\n');

  // 1. 认证
  console.log('[1/4] 认证...');
  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  const api = new VrchatApiClient(creds.email, creds.password);
  api.loadCookieFromFile(COOKIE_FILE);
  const user = await api.ensureAuth();
  console.log(`  ✅ 已登录: ${user.displayName} (${user.id})\n`);

  // 2. 获取 WebSocket token
  console.log('[2/4] 获取 WebSocket token...');
  const authResp = await api._request('GET', '/auth');
  if (!authResp.data?.ok || !authResp.data?.token) {
    console.log('  ❌ 获取 WebSocket token 失败');
    process.exit(1);
  }
  const token = authResp.data.token;
  console.log(`  ✅ token 获取成功 (长度=${token.length})\n`);

  // 3. 连接 WebSocket (通过代理)
  console.log('[3/4] 连接 WebSocket (通过代理)...');
  console.log(`  代理: ${PROXY}`);
  const wsUrl = `wss://pipeline.vrchat.cloud/?auth=${encodeURIComponent(token)}`;

  const agent = new HttpsProxyAgent(PROXY);
  const ws = new WebSocket(wsUrl, {
    agent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'http://localhost:9000'
    },
    handshakeTimeout: 15000, // 15s 超时
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      console.log('  ⚠️ 连接超时 (15s)');
      reject(new Error('连接超时'));
    }, 15000);

    ws.on('open', () => {
      clearTimeout(timeout);
      connectedAt = new Date();
      console.log(`  ✅ WebSocket 已连接! (${connectedAt.toISOString().slice(11, 19)})\n`);
      console.log(`  协议版本: ${ws.protocol || '默认'}`);
      resolve();
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      console.log(`  ❌ 错误: ${err.message}`);
      reject(err);
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      console.log(`  ⚠️ 连接关闭: code=${code}, reason=${(reason||'').toString() || '无'}`);
    });
  });

  // 4. 监听事件
  console.log(`[4/4] 监听事件中 (${LISTEN_DURATION_MS / 1000} 秒)...`);
  console.log('  等待好友活动... 如果有好友上线/下线/换世界会实时显示\n');

  ws.on('message', (raw) => {
    const rawStr = raw.toString();
    try {
      const parsed = JSON.parse(rawStr);
      const desc = formatContent(parsed);
      const content = parsed.content || {};
      let displayContent = content;
      if (typeof content === 'string') {
        try { displayContent = JSON.parse(content); } catch {}
      }
      recordEvent(parsed.type || 'unknown', displayContent);
      const ts = new Date().toISOString().slice(11, 19);
      console.log(`  [${ts}] 📨 ${desc}`);
    } catch (err) {
      console.log(`  [parse error] ${err.message}: ${rawStr.slice(0, 100)}`);
    }
  });

  ws.on('close', (code, reason) => {
    disconnectedAt = new Date();
    const reasonStr = reason ? reason.toString() : '无';
    console.log(`\n  ⚠️ 连接关闭: code=${code}, reason=${reasonStr}`);
  });

  ws.on('error', (err) => {
    console.log(`  ❌ 连接错误: ${err.message}`);
  });

  // 等待监听时长
  const endTime = new Date(Date.now() + LISTEN_DURATION_MS);
  console.log(`  监听至 ${endTime.toISOString().slice(11, 19)} ...\n`);

  await new Promise(resolve => setTimeout(resolve, LISTEN_DURATION_MS));

  // 5. 关闭连接
  const elapsed = connectedAt ? (new Date() - connectedAt) / 1000 : 0;
  console.log(`\n  监听结束 (已连接 ${elapsed.toFixed(0)} 秒), 关闭 WebSocket...`);
  ws.close();
  await new Promise(r => setTimeout(r, 500));

  // 6. 输出报告
  console.log('\n══════════════════════════════════════════════');
  console.log('  WebSocket 测试报告');
  console.log('══════════════════════════════════════════════\n');

  console.log(`  连接时长: ${elapsed.toFixed(0)} 秒`);
  console.log(`  收到事件: ${totalEvents} 个\n`);

  if (totalEvents === 0) {
    console.log('  ⚪ 未收到好友事件。但这不代表连接有问题。');
    console.log('  - 连接已成功建立 (TCP+TLS+WSS 握手通过)');
    console.log('  - WebSocket 认证通过 (token 有效)');
    console.log('  - 只是当前时段好友无活跃 (无人上线/下线/换世界)\n');
  } else {
    console.log('  📊 事件统计:');
    console.log(`  ┌${'─'.repeat(27)}┬${'─'.repeat(8)}┐`);
    console.log(`  │ 类型${' '.repeat(23)}│ 数量   │`);
    console.log(`  ├${'─'.repeat(27)}┼${'─'.repeat(8)}┤`);
    for (const [type, count] of Object.entries(eventCounts).sort((a, b) => b[1] - a[1])) {
      const t = type.padEnd(25).slice(0, 25);
      const c = String(count).padStart(6).slice(0, 6);
      console.log(`  │ ${t} │ ${c} │`);
    }
    console.log(`  └${'─'.repeat(27)}┴${'─'.repeat(8)}┘\n`);

    console.log('  📝 事件样例:\n');
    for (const [type, samples] of Object.entries(eventSamples)) {
      console.log(`  ── ${type} ──`);
      for (const s of samples) {
        console.log(`    [${s.time}] ${s.preview}`);
      }
      console.log();
    }
  }

  console.log(`  ✅ WebSocket 连接测试完成`);
  console.log(`     - 代理连接: 正常`);
  console.log(`     - WSS 握手: 正常`);
  console.log(`     - 认证: token 有效`);
  console.log(`     - 消息接收: ${totalEvents > 0 ? '正常 (收到数据)' : '通道建立成功 (等待活动)'}`);
  console.log();
}

main().catch(err => {
  console.error(`\n❌ 测试脚本异常: ${err.message}`);
  process.exit(1);
});
