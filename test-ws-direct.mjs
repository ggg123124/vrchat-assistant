/**
 * VRChat WebSocket 直连测试（不走代理）
 * 快速测试，30 秒
 */
import WebSocket from 'ws';
import { VrchatApiClient } from './vrchat-api.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COOKIE_FILE = fileURLToPath(new URL('./auth_cookie.txt', import.meta.url));
const CRED_FILE = fileURLToPath(new URL('./credentials.json', import.meta.url));

async function main() {
  console.log('═══ VRChat WebSocket 直连测试 ═══\n');

  const creds = JSON.parse(readFileSync(CRED_FILE, 'utf-8'));
  const api = new VrchatApiClient(creds.email, creds.password);
  api.loadCookieFromFile(COOKIE_FILE);
  await api.ensureAuth();

  const authResp = await api._request('GET', '/auth');
  if (!authResp.data?.ok) {
    console.log('❌ Token 获取失败');
    process.exit(1);
  }
  const token = authResp.data.token;
  console.log(`✅ Token 获取成功 (len=${token.length})\n`);

  // 直连 - 不设代理
  const wsUrl = `wss://pipeline.vrchat.cloud/?auth=${encodeURIComponent(token)}`;
  console.log(`正在直连 ${wsUrl.replace(token, '***')} ...`);

  const ws = new WebSocket(wsUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Origin': 'http://localhost:9000'
    },
    handshakeTimeout: 10000,
  });

  const result = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      ws.close();
      resolve({ status: 'timeout', detail: '10秒无响应' });
    }, 10000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(`✅ WebSocket 直连成功!`);
      // 接收 1 个消息看看
      ws.on('message', (data) => {
        console.log(`📨 收到: ${data.toString().slice(0, 80)}...`);
      });
      setTimeout(() => {
        ws.close();
        resolve({ status: 'connected', detail: '连接正常，已监听10秒' });
      }, 10000);
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ status: 'error', detail: err.message });
    });

    ws.on('close', (code, reason) => {
      clearTimeout(timeout);
      resolve({ status: `closed(code=${code})`, detail: reason?.toString() || '' });
    });
  });

  console.log(`\n结果: ${result.status} — ${result.detail}`);
}

main().catch(e => console.error('异常:', e.message));
