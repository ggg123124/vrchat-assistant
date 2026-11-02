// @vitest-environment happy-dom
/**
 * feed-day-label.test.js —— 动态流「今天/昨天」分组标签的边界行为（2026-11-02）
 *
 * 为什么立这条：daySepLabel 按**本地日历日**比较（getFullYear/getMonth/getDate），
 * 而 feedRows 是 computed，只随 rows 变化重算。于是有跨午夜边界：
 * 23:59 打开页面（标签「今天」），过了 0 点若不重算，标签仍写「今天」——但它已经是昨天。
 *
 * 构造时刻必须用**本地时间**（new Date(y,m,d,h,mi)），不能用 Date.UTC：
 * 复审（nixi-agent）实测 Date.UTC 版本在 TZ=Asia/Shanghai 下 1 failed
 * ——UTC 23:30 在 UTC+8 已是次日 07:30，所谓「跨午夜」根本不在午夜附近。
 * CI（ubuntu 默认 UTC）会绿、维护者本机必红，属典型的环境依赖测试。
 */
import { describe, it, expect } from 'vitest';
import { daySepLabel } from '../utils/feed-day-label.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// 本地时间 2026-11-02 12:00（与运行时区无关，永远是"中午"）
const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime();

describe('daySepLabel', () => {
  it('今天 / 昨天 / 更早 三种标签', () => {
    expect(daySepLabel(new Date(NOW).toISOString(), NOW)).toBe('今天');
    expect(daySepLabel(new Date(NOW - 86400000).toISOString(), NOW)).toBe('昨天');
    expect(daySepLabel(new Date(NOW - 3 * 86400000).toISOString(), NOW)).toBe('10-30');
  });

  it('跨午夜后同一行从「今天」变「昨天」——说明标签依赖"现在"，必须可重算', () => {
    // 本地 11-02 23:30 这一行；分别用本地 23:59 与本地次日 00:01 作为「现在」
    const row = new Date(2026, 10, 2, 23, 30, 0).toISOString();
    const beforeMidnight = new Date(2026, 10, 2, 23, 59, 0).getTime();
    const afterMidnight = new Date(2026, 10, 3, 0, 1, 0).getTime();
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
    const row = new Date(2026, 9, 20, 8, 0, 0).toISOString();
    const a = daySepLabel(row, NOW);
    const b = daySepLabel(row, NOW);
    expect(a).toBe(b);
    expect(a).toBe('10-20');
  });

  it('同一行与其自身时刻比较恒为「今天」（与运行时区无关）', () => {
    const cases = ['2026-11-02T12:00:00', '2026-11-02T00:00:00', '2026-11-01T23:59:59'];
    for (const iso of cases) {
      const t = new Date(iso).getTime();
      expect(daySepLabel(iso, t)).toBe('今天');
    }
  });


// ── 复审 💡2（nixi-agent）：跨午夜必须真的重算，而不只是「变可测」 ──
describe('跨午夜重算（用户可见缺陷，不只看函数可注入）', () => {
  it('store.dayClock 必须是响应式字段（否则 computed 不会重算）', async () => {
    const { reactive, computed, nextTick } = await import('vue');
    const store = reactive({ dayClock: new Date(2026, 10, 2, 23, 59, 0).getTime() });
    const rows = computed(() => daySepLabel(new Date(2026, 10, 2, 23, 30, 0).toISOString(), store.dayClock));
    expect(rows.value).toBe('今天');
    // 推到零点之后：真实页面靠 scheduleDayClock 做这一步
    store.dayClock = new Date(2026, 10, 3, 0, 0, 1).getTime();
    await nextTick();
    expect(rows.value, 'dayClock 变化后 computed 必须重算，标签改判「昨天」').toBe('昨天');
  });

  it('store.js 里确实声明了 dayClock 且有零点调度（防止只改 FeedView 不改时钟）', () => {
    const src = readFileSync(path.join(here, '..', 'store.js'), 'utf8');
    expect(src).toMatch(/dayClock:\s*Date\.now\(\)/);
    expect(src).toMatch(/function scheduleDayClock/);
    expect(src).toMatch(/store\.dayClock = Date\.now\(\)/);
    // 必须是「下一个本地零点」而不是固定间隔轮询
    expect(src).toMatch(/getDate\(\) \+ 1, 0, 0, 1, 0/);
  });
});

});
