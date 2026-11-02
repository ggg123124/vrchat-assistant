// @vitest-environment happy-dom
/**
 * feed-day-label.test.js —— 动态流「今天/昨天」分组标签的边界行为（2026-11-02）
 *
 * 为什么立这条：daySepLabel 内部用 new Date() 取"现在"，而 feedRows 是 computed，
 * **只随 rows 变化重算**。于是有两个边界：
 *   ① 跨午夜：23:59 打开页面（标签「今天」），过了 0 点若不重算，标签仍写「今天」——但它已经是昨天；
 *      而 120s 全量轮询一旦刷新 feedEvents ⇒ feedRows 重算 ⇒ 同一批行突然从「今天」跳到「昨天」，
 *      整组位置跳动一次。用户什么都没做，列表自己变了。
 *   ② 时钟可注入性：原实现直接读 new Date()，测试只能靠"等到明天"才能覆盖，等于不可测。
 *
 * 修法：daySepLabel 接受可选 nowMs 参数（默认 Date.now()），并导出供测试。
 * 行为不变，但边界可以被钉住；同时 feedRows 用同一 nowMs 算「今天/昨天参考点」，
 * 保证一次渲染内所有行用同一个"现在"（否则滚动到跨秒时可能出现两组不一致）。
 */
import { describe, it, expect } from 'vitest';
import { daySepLabel } from '../utils/feed-day-label.js';

// 2026-11-02T12:00:00Z 作为"现在"
const NOW = Date.UTC(2026, 10, 2, 12, 0, 0);

describe('daySepLabel', () => {
  it('今天 / 昨天 / 更早 三种标签', () => {
    expect(daySepLabel(new Date(NOW).toISOString(), NOW)).toBe('今天');
    expect(daySepLabel(new Date(NOW - 86400000).toISOString(), NOW)).toBe('昨天');
    expect(daySepLabel(new Date(NOW - 3 * 86400000).toISOString(), NOW)).toBe('10-30');
  });

  it('跨午夜后同一行从「今天」变「昨天」——说明标签依赖"现在"，必须可重算', () => {
    const row = new Date(Date.UTC(2026, 10, 2, 23, 30, 0)).toISOString();   // 11-02 23:30
    const beforeMidnight = Date.UTC(2026, 10, 2, 23, 59, 0);
    const afterMidnight = Date.UTC(2026, 10, 3, 0, 1, 0);
    expect(daySepLabel(row, beforeMidnight)).toBe('今天');
    // 过了午夜，同一行应变成「昨天」——而不是继续显示「今天」
    expect(daySepLabel(row, afterMidnight)).toBe('昨天');
  });

  it('空值与非法时间戳返回空串（不抛、不产生假标签）', () => {
    expect(daySepLabel('', NOW)).toBe('');
    expect(daySepLabel(null, NOW)).toBe('');
    expect(daySepLabel('not-a-date', NOW)).toBe('');
  });

  it('固定 nowMs 时结果可复现（不随时间漂移）', () => {
    const row = new Date(Date.UTC(2026, 9, 20, 8, 0, 0)).toISOString();
    const a = daySepLabel(row, NOW);
    const b = daySepLabel(row, NOW);
    expect(a).toBe(b);
    expect(a).toBe('10-20');
  });
});
