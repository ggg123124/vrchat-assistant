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
import { join, extname } from 'node:path';

const ROOT = 'plugins/official/web-dashboard/ui/src';
// UI 标志复位（loading/busy/... = false）属于正常收尾，不算业务结论 ✓
const FLAG = /(loading|busy|pending|saving|creating|selecting|scanning|refreshing|spinner|open|visible|searching|submitting)/i;
// 同时覆盖 `= 值` 与 `return 值`（变异自检发现只认 = 会漏掉 return [] ✗）
const NORMAL_WRITE = /(=\s*|return\s+)(false|true|\[\]|null|0|'')\s*[;)]/;

// 基线：文件 + 该行文本（去首尾空白）作为稳定键（不用行号，插入代码不会误报）✓
const BASELINE = [
  ['src/App.vue', 'loginView.value = true;', '语义就是"回到登录页"，不是数据结论'],
  ['src/api.js', 'return null;', 'API 包装层：把失败返回给调用方由上层决定（调用方已分别处理）'],
  ['src/store.js', 'return null;', 'readCache 的 catch：缓存不可用 ⇒ 当作没有缓存（语义正确）'],
  ['src/views/BoothView.vue', "if (mySeq === seq) { results.value = []; toast('搜索失败：' + (e.message || e), 'error'); }", '新查询清空 + toast 报错'],
  ['src/views/SearchView.vue', "if (mySeq === seq) { results.value = []; toast('搜索失败：' + (e.message || e), 'error'); }", '新查询清空 + toast 报错'],
  ['src/views/RecommendView.vue', "if (mySeq === seq) { data.value = null; toast('加载推荐失败：' + (e.message || e), 'error'); }", '新查询清空 + toast 报错'],
  ['src/views/TrackedView.vue', "if (mySeq === addSeq) { addResults.value = null; toast('搜索失败：' + (e.message || e), 'error'); }", '新查询清空 + toast 报错'],
  ['src/views/WeeklyReportView.vue', "if (mySeq === seq) { report.value = null; toast('加载周报失败：' + (e.message || e), 'error'); }", '新查询清空 + toast 报错'],
  ['src/views/PrintsView.vue', "if (tab.value === 'prints') prints.value = [];", '上方已设 error.value = 加载失败'],
  ['src/views/PrintsView.vue', 'else gallery.value = [];', '同上'],
  ['src/components/AvatarDialog.vue', 'data.value = null;', '上方已设 loadError.value'],
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
          // 2026-09-22 修（Windows CI 实测）：先把路径分隔符统一成 '/'，再做前缀剥离 ✓
          // 否则 Windows 上键是 'plugins\\official\\…' ⇒ 与基线（'src/…'）全不匹配 ⇒ 每条基线都被当成未登记 ⇒ 必红 ✗
          const rel = String(p).replace(/\\/g, '/').replace(/^plugins\/official\/web-dashboard\/ui\//, '');
          out.push([rel, t]);
        }
      }
    }
  };
  walk(ROOT);
  return out;
}

test('前端 catch 块不得把失败写成业务结论（基线外的任何新增都要显式登记）', () => {
  const allowed = new Set(BASELINE.map(([f, line]) => f + ' ||| ' + line));
  const fresh = scan().filter(([f, line]) => !allowed.has(f + ' ||| ' + line));
  assert.equal(
    fresh.length,
    0,
    '发现未登记的「catch 里写正常态」：\n  ' + fresh.map(([f, l]) => f + ': ' + l).join('\n  ')
      + '\n修法：失败时保持旧值，或置错误态 + 原因 + 重试；确为合法例外请加入本测试的 BASELINE 并写明理由。',
  );
});
