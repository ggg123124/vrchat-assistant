// 补充：成功路径（API 200）不受 PR 影响——正常解析写缓存
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const src = readFileSync(path.join(repoRoot, 'core/world-names.js'), 'utf8');
let t = src
  .replace('const negativeCache = new Map();', 'export const negativeCache = new Map();')
  .replace('function pruneNegativeCache(now = Date.now())', 'export function pruneNegativeCache(now = Date.now())')
  .replaceAll('5 * 60 * 1000', '50');
const outFile = path.join(repoRoot, 'tmp/review-0820/pr-68/world-names-success.mjs');
writeFileSync(outFile, t);
const mod = await import('file:///' + outFile.replace(/\\/g, '/'));
const { resolveWorldNames, negativeCache } = mod;

let apiCalls = 0;
const storage = { getWorldName: () => null, upsertWorld: (w) => { global.upserted = w; } };
const api = { _request: async () => { apiCalls++; return { status: 200, data: { id: 'wrld_ok1', name: '测试世界', authorId: 'usr_a', authorName: '作者', capacity: 16, favorites: 99, releaseStatus: 'public', tags: [], description: 'd', imageUrl: '' } }; } };
const ctx = { storage, api };

const r = await resolveWorldNames(ctx, ['wrld_ok1'], { throttleMs: 1 });
let pass = 0, fail = 0;
const check = (n, c, d) => { c ? pass++ : (fail++, console.log(`  FAIL ${n} | ${d}`)); };

check('成功解析返回世界名', r.get('wrld_ok1') === '测试世界', JSON.stringify([...r]));
check('写回 upsertWorld', global.upserted?.name === '测试世界', JSON.stringify(global.upserted));
check('成功条目不进负缓存', negativeCache.size === 0, `cacheSize=${negativeCache.size}`);
check('API 调用 1 次', apiCalls === 1, `apiCalls=${apiCalls}`);
console.log(`结果: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
