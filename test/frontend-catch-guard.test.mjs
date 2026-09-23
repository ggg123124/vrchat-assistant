/**
 * frontend-catch-guard.test.mjs — 前端「失败不得伪装成正常结论」防回归闸门
 *
 * 规则（2026-09-22 使用者连抓 3 例后确立，见项目规矩）：
 *   catch 块里**不得**把失败写成业务结论（= false / [] / null / 0 / ''）——那会让界面显示成
 *   「确实没有数据」，而事实是「没拿到」。正确做法：保持旧值，或置错误态 + 原因 + 重试。
 *
 * 例外分两类，全部登记在下方 BASELINE：
 *   ① 换了新查询时的清空 + 同时 toast 报错（搜索结果 / 周报 / 推荐等）——空值是"对当前查询的答案" ✓
 *   ② 已另设错误态（如 loadError）或语义就是"回到登录页" ✓
 * 命中不在 BASELINE 内 ⇒ 测试失败：请按规则修，或把该行加入 BASELINE 并写明理由 ✓
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, extname, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-09-22 评审建议：ROOT 改为基于 import.meta.url 定位仓库根 ——
// 否则从别的 cwd 运行会扫到 0 个文件，而断言恒真 ⇒ 闸门静默变绿（与 #226 那条护栏同源失效）。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugins/official/web-dashboard/ui/src');
// UI 标志复位（loading/busy/... = false）属于正常收尾，不算业务结论 ✓
const FLAG = /(loading|busy|pending|saving|creating|selecting|scanning|refreshing|spinner|open|visible|searching|submitting)/i;
// 同时覆盖 `= 值` 与 `return 值`（变异自检发现只认 = 会漏掉 return [] ✗）
const NORMAL_WRITE = /(=\s*|return\s+)(false|true|\[\]|null|0|'')\s*[;)]/;

// 基线：文件 + 该行文本（去首尾空白）作为稳定键（不用行号，插入代码不会误报）✓
const BASELINE = [
  ['src/api.js', 'return null;', 'API 包装层：把失败返回给调用方由上层决定（调用方已分别处理）'],
  // 2026-09-23 维护方合并 #239 时按自检二修正两处漂移（原条目为 #228 写的基线，已被后续合并改动）：
  // ① 原 ['src/App.vue','loginView.value = true;'] 已不存在 —— #230 重写鉴权门后该赋值移入 onAuth401()，不再位于 catch 内 ⇒ 删除；
  // ② 原 ['src/store.js','return null;','readCache 的 catch…'] 已不存在（readCache 该分支已被重写）⇒ readCache 不再命中，
  //    当前 store.js 唯一命中项是 startDashboard 的 getToken() 兜底 `catch { return false; }`（保守默认：视为没取到令牌，非把失败当结论）⇒ 按实际命中项改写。
  ['src/store.js', 'return false;', 'startDashboard 的 getToken() 兜底：抛错即视为未取到令牌（保守默认，非把失败写成业务结论）'],
  ['src/components/AvatarDialog.vue', 'data.value = null;', '上方已设 loadError.value'],
  ['src/views/BoothView.vue', "if (mySeq === seq) { results.value = []; toast('搜索失败：' + (e.message || e), 'error'); }", '新查询清空 + toast 报错'],
  ['src/views/SearchView.vue', "if (mySeq === seq) { results.value = []; toast('搜索失败：' + (e.message || e), 'error'); }", '新查询清空 + toast 报错'],
  ['src/views/RecommendView.vue', "if (mySeq === seq) { data.value = null; toast('加载推荐失败：' + (e.message || e), 'error'); }", '新查询清空 + toast 报错'],
  ['src/views/TrackedView.vue', "if (mySeq === addSeq) { addResults.value = null; toast('搜索失败：' + (e.message || e), 'error'); }", '新查询清空 + toast 报错'],
  ['src/views/WeeklyReportView.vue', "if (mySeq === seq) { report.value = null; toast('加载周报失败：' + (e.message || e), 'error'); }", '新查询清空 + toast 报错'],
  ['src/views/PrintsView.vue', "if (tab.value === 'prints') prints.value = [];", '上方已设 error.value = 加载失败'],
  ['src/views/PrintsView.vue', 'else gallery.value = [];', '同上'],
];

function scan() {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!['.js', '.vue'].includes(extname(n))) continue;
      const src = readFileSync(p, 'utf8');
      const re = /\}\s*catch\s*(\([^)]*\))?\s*\{/g;
      let m;
      while ((m = re.exec(src))) {
        let i = m.index + m[0].length;
        let depth = 1;
        while (i < src.length && depth > 0) {
          if (src[i] === '{') depth++;
          else if (src[i] === '}') depth--;
          i++;
        }
        const body = src.slice(m.index + m[0].length, i - 1);
        for (const bl of body.split(/\r?\n/)) {
          const t = bl.trim();
          if (!t || t.startsWith('//')) continue;
          if (!NORMAL_WRITE.test(t)) continue;
          if (FLAG.test(t)) continue;
          // 2026-09-22：ROOT 改绝对路径后，前缀剥离必须跟着改 —— 
          // 用 path.relative(ui 目录, p) 得到 'src/xxx'（跨平台 ✓，且与 BASELINE 键一致 ✓）
          const rel = relative(join(ROOT, '..'), p).replace(/\\/g, '/');
          out.push([rel, t]);
        }
      }
    }
  };
  walk(ROOT);
  return out;
}

test('前端 catch 块不得把失败写成业务结论（基线外的任何新增都要显式登记）', () => {
  const all = scan();
  // 自检一：扫描结果必须非空 —— 否则下面的断言恒真，闸门会静默变绿
  assert.ok(all.length > 0, '扫描结果为空 => 闸门无效（检查 ROOT 是否失效: ' + ROOT + '）');
  // 自检二：每条基线都必须真的被命中 —— 否则基线腐化、后人会被误导
  const hitKeys = new Set(all.map(([f, line]) => f + ' ||| ' + line));
  const stale = BASELINE.filter(([f, line]) => !hitKeys.has(f + ' ||| ' + line));
  assert.equal(stale.length, 0, '基线里有僵尸条目（已不再命中，请删除）: ' + stale.map(([f, l]) => f + ': ' + l).join(' ; '));
  const allowed = new Set(BASELINE.map(([f, line]) => f + ' ||| ' + line));
  const fresh = scan().filter(([f, line]) => !allowed.has(f + ' ||| ' + line));
  assert.equal(
    fresh.length,
    0,
    '发现未登记的「catch 里写正常态」：\n  ' + fresh.map(([f, l]) => f + ': ' + l).join('\n  ')
      + '\n修法：失败时保持旧值，或置错误态 + 原因 + 重试；确为合法例外请加入本测试的 BASELINE 并写明理由。',
  );
});
