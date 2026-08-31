#!/usr/bin/env node
// Dashboard 接口回归探针：一键验证全部 HTTP 端点。
// 用法：VRC_MONITOR_AUTH_TOKEN=xxx node scripts/dashboard-probe.mjs [baseUrl]
// 默认 baseUrl http://127.0.0.1:8799（容器内）；DASHBOARD_URL 可覆盖。
const base = process.env.DASHBOARD_URL || process.argv[2] || 'http://127.0.0.1:8799';
const token = process.env.VRC_MONITOR_AUTH_TOKEN || '';

const endpoints = [
  ['dashboard-page', '/dashboard'],
  ['home', '/api/dashboard/home'],
  ['overview', '/api/dashboard/overview'],
  ['friends', '/api/dashboard/friends?limit=5'],
  ['events', '/api/dashboard/events?limit=5'],
  ['events-offset', '/api/dashboard/events?limit=5&offset=5'],
  ['stats', '/api/dashboard/stats?days=7'],
  ['search', '/api/dashboard/search?q=vrc&type=users'],
  ['fav-friends', '/api/dashboard/favorites?type=friends'],
  ['fav-worlds', '/api/dashboard/favorites?type=worlds&limit=5'],
  ['fav-avatars', '/api/dashboard/favorites?type=avatars&limit=5'],
  ['fav-groups', '/api/dashboard/favorites?type=groups'],
  ['avatars', '/api/dashboard/avatars?limit=5'],
  ['moderation', '/api/dashboard/moderation'],
  ['notifications', '/api/dashboard/notifications?limit=5'],
  ['recent-worlds', '/api/dashboard/recent-worlds?limit=5'],
];

let pass = 0, fail = 0;
const rows = [];
for (const [name, path] of endpoints) {
  const t0 = Date.now();
  try {
    const r = await fetch(base + path, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(25000) });
    const ms = Date.now() - t0;
    let jsonOk = true, size = 0, key = '';
    try { const j = await r.json(); size = JSON.stringify(j).length; key = Object.keys(j).slice(0, 3).join(','); } catch { jsonOk = false; }
    if (r.ok) pass++; else fail++;
    rows.push({ name, status: r.status, ms, ok: r.ok, jsonOk, size, key });
  } catch (e) {
    fail++;
    rows.push({ name, status: 'ERR', ms: Date.now() - t0, ok: false, error: e.message });
  }
}
rows.sort((a, b) => (a.ok ? 0 : 1) - (b.ok ? 0 : 1));
for (const r of rows) {
  console.log(`${r.ok ? '✔' : '✖'} ${String(r.status).padEnd(5)} ${r.name.padEnd(16)} ${String(r.ms).padStart(6)}ms ${r.jsonOk ? 'json' : 'non-json'}${r.size ? ` ${r.size}B` : ''}${r.key ? ` [${r.key}]` : ''}${r.error ? ' ' + r.error : ''}`);
}
console.log(`\nPASS ${pass}/${rows.length}  FAIL ${fail}`);
process.exit(fail ? 1 : 0);
