// PR#68 行为实测：负缓存过期清理（惰性删除 + prune 定期清理）
// 对 pr-68 源码做最小变换：导出 negativeCache/pruneNegativeCache，TTL 与 interval 缩为 50ms
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');

const src = readFileSync(path.join(repoRoot, 'core/world-names.js'), 'utf8');
let t = src
  .replace('const negativeCache = new Map();', 'export const negativeCache = new Map();')
  .replace('function pruneNegativeCache(now = Date.now())', 'export function pruneNegativeCache(now = Date.now())')
  .replaceAll('5 * 60 * 1000', '50'); // TTL 与 interval 都缩为 50ms 便于测试

const outDir = path.join(repoRoot, 'tmp/review-0820/pr-68');
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'world-names-test.mjs');
writeFileSync(outFile, t);

const mod = await import('file:///' + outFile.replace(/\\/g, '/'));
const { resolveWorldNames, negativeCache, pruneNegativeCache } = mod;

// mock：storage 全 miss，api 恒失败（404）
let apiCalls = 0;
const storage = { getWorldName: () => null, upsertWorld: () => {} };
const api = { _request: async () => { apiCalls++; return { status: 404, data: null }; } };
const ctx = { storage, api };
const failIds = ['wrld_fail1', 'wrld_fail2'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name} | ${detail}`); }
}

console.log('--- 用例1：首次调用（API 失败 → 写负缓存，返回兜底）---');
const r1 = await resolveWorldNames(ctx, failIds, { throttleMs: 1 });
check('返回兜底值', r1.get('wrld_fail1') === 'wrld_fail1' && r1.get('wrld_fail2') === 'wrld_fail2', JSON.stringify([...r1]));
check('API 调用 2 次', apiCalls === 2, `apiCalls=${apiCalls}`);
check('负缓存 2 条', negativeCache.size === 2, `cacheSize=${negativeCache.size}`);

console.log('--- 用例2：TTL 内二次调用（负缓存命中，不发 API——配额保护不回归）---');
const r2 = await resolveWorldNames(ctx, failIds, { throttleMs: 1 });
check('返回兜底值', r2.get('wrld_fail1') === 'wrld_fail1', JSON.stringify([...r2]));
check('API 调用不再增长', apiCalls === 2, `apiCalls=${apiCalls}`);
check('负缓存仍 2 条', negativeCache.size === 2, `cacheSize=${negativeCache.size}`);

console.log('--- 用例3：超过 TTL 后再次调用（过期条目惰性删除 + 重新解析）---');
await sleep(120); // > 50ms TTL
const r3 = await resolveWorldNames(ctx, failIds, { throttleMs: 1 });
check('重新解析返回兜底', r3.get('wrld_fail1') === 'wrld_fail1', JSON.stringify([...r3]));
check('API 调用重新增长(2+2)', apiCalls === 4, `apiCalls=${apiCalls}`);
check('负缓存重新写入 2 条', negativeCache.size === 2, `cacheSize=${negativeCache.size}`);

console.log('--- 用例4：pruneNegativeCache 清理全部过期条目 ---');
await sleep(120);
pruneNegativeCache();
check('过期条目全部清除', negativeCache.size === 0, `cacheSize=${negativeCache.size}`);

console.log('--- 用例5：pruneNegativeCache 保留未过期条目 ---');
await resolveWorldNames(ctx, ['wrld_fail3'], { throttleMs: 1 });
check('新条目已写入', negativeCache.size === 1, `cacheSize=${negativeCache.size}`);
pruneNegativeCache(); // 立即 prune（未过期）
check('未过期条目保留', negativeCache.size === 1 && negativeCache.has('wrld_fail3'), `cacheSize=${negativeCache.size}`);
await sleep(120);
pruneNegativeCache();
check('过 TTL 后 prune 清除', negativeCache.size === 0, `cacheSize=${negativeCache.size}`);

console.log(`\n结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
