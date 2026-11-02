// @vitest-environment happy-dom
/**
 * modal-focus-restore.test.js —— 关闭弹窗后焦点归还（2026-11-02）
 *
 * 起因：键盘用户从列表里打开详情弹窗，按 Esc 关闭后焦点掉到 <body>，
 * 只能从头 Tab 一遍才能回到刚才那一行。原因是各 close* / Escape 分支只清 state、不还原焦点。
 *
 * 修法：open* 时记住 document.activeElement，close 与 Escape 分支里 focusOrRestore。
 * 本用例直接驱动真实 store.js（不 mock 被测模块），钉住：
 *  ① 打开 → 关闭 后，焦点回到打开前的元素；
 *  ② 打开前没有聚焦元素时，关闭不抛（不能因为还原焦点把关闭流程搞崩）；
 *  ③ 原元素已被移出 DOM 时静默跳过（不能抛、也不能把焦点硬塞给已移除节点）；
 *  ④ 连续打开两个不同弹窗，只还原最后一次记录的来源。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// store.js 在 import 时会碰 localStorage / window；happy-dom 提供了它们。
const loadStore = async () => {
  vi.resetModules();
  return await import('./store.js');
};

const mkButton = (id) => {
  const b = document.createElement('button');
  b.id = id;
  b.textContent = id;
  document.body.appendChild(b);
  return b;
};

describe('弹窗焦点归还', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('打开→关闭后焦点回到原元素', async () => {
    const m = await loadStore();
    const btn = mkButton('trigger-a');
    btn.focus();
    expect(document.activeElement.id).toBe('trigger-a');

    m.openUser('usr_01234567-0123-4123-8123-0123456789ab');
    expect(m.store.userModal).toBeTruthy();
    // 模拟弹窗自己把焦点移走（真实 Dialog 会这么做）
    const inner = mkButton('inside-dialog');
    inner.focus();
    expect(document.activeElement.id).toBe('inside-dialog');

    m.closeUser();
    expect(m.store.userModal).toBeNull();
    expect(document.activeElement.id).toBe('trigger-a');
  });

  it('打开前无聚焦元素时关闭不抛', async () => {
    const m = await loadStore();
    document.body.focus?.();
    expect(() => {
      m.openWorld('wrld_01234567-0123-4123-8123-0123456789ab');
      m.closeWorld();
    }).not.toThrow();
  });

  it('来源元素已被移除时静默跳过（不抛、焦点不乱塞）', async () => {
    const m = await loadStore();
    const btn = mkButton('trigger-b');
    btn.focus();
    m.openAvatar('avtr_01234567-0123-4123-8123-0123456789ab');
    btn.remove();                          // 打开期间来源被移除
    const idle = mkButton('elsewhere');
    idle.focus();
    expect(() => m.closeAvatar()).not.toThrow();
    // 不能把焦点塞给已移除节点；保持原样即通过
    expect(document.activeElement.id).toBe('elsewhere');
  });

  it('连续打开不同弹窗，只还原最后一次的来源', async () => {
    const m = await loadStore();
    const first = mkButton('src-1');
    first.focus();
    m.openUser({ userId: 'usr_x' });
    m.closeUser();
    expect(document.activeElement.id).toBe('src-1');

    const second = mkButton('src-2');
    second.focus();
    m.openGroup({ groupId: 'grp_x' });
    m.closeGroup();
    expect(document.activeElement.id).toBe('src-2');
  });


// ── 复审 nixi-agent 第 2 轮 ⚠️1：预览弹窗必须与父弹窗的焦点栈配对 ──
describe('预览弹窗的焦点栈配对（嵌套路径）', () => {
  it('openUser → openPreview → 关预览：焦点回弹窗内来源；再 closeUser：回列表行', async () => {
    const m = await loadStore();
    document.body.innerHTML = '';
    const row = document.createElement('button');
    row.id = 'list-row';
    document.body.appendChild(row);
    const avatar = document.createElement('div');
    avatar.id = 'avatar-card';
    avatar.tabIndex = 0;
    document.body.appendChild(avatar);

    row.focus();
    expect(document.activeElement.id).toBe('list-row');

    // 真实入口：openUser 压一档
    m.openUser('usr_01234567-0123-4123-8123-0123456789ab');
    avatar.focus();
    // 真实入口：openPreview 再压一档（这正是 UserDialog.vue:181 之前绕过的那一步）
    m.openPreview('https://example.com/a.png');
    expect(m.activeFocusStackDepth(), '两层栈').toBe(2);

    m.restoreFocusAfterModal();         // 关闭预览 → 应回到弹窗内的 avatar
    expect(document.activeElement.id, '预览关闭后焦点必须留在弹窗内').toBe('avatar-card');

    m.restoreFocusAfterModal();         // 关闭 UserDialog → 回到列表行
    expect(document.activeElement.id, '关掉 UserDialog 后回到列表行').toBe('list-row');
  });

  it('源码层：不得有绕过 openPreview 的直赋（否则栈错位）', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    // 用 fileURLToPath 而不是 new URL().pathname：Windows 下 pathname 形如 /C:/...，
    // readdirSync 会失败（复审 EMeowAGENT 💡1）。本仓既有 6 处均用 fileURLToPath，保持一致。
    const { fileURLToPath } = await import('node:url');
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const walk = (d, out = []) => {
      for (const name of readdirSync(d)) {
        const p = path.join(d, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(vue|js)$/.test(name) && !/\.test\.js$/.test(name)) out.push(p);
      }
      return out;
    };
    const offenders = [];
    for (const f of walk(dir)) {
      if (f.endsWith('store.js')) continue;
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        if (!/store\.previewUrl\s*=/.test(line)) continue;
        if (/^\s*(\/\/|\*)/.test(line)) continue;
        offenders.push(path.relative(dir, f) + ': ' + line.trim().slice(0, 70));
      }
    }
    expect(offenders, '绕过 openPreview 会破坏焦点栈配对').toEqual([]);
  });
});



// ── 复审 nixi-agent 第 2 轮 💡2：跨午夜不能只 grep 源码，要行为断言 ──
// 只匹配 dayClock / scheduleDayClock 字面量防不住「写了但没接上」（例如步骤没进 startDashboard）。
// 这里用假定时器真的把时钟推到跨午夜，验证 store.dayClock 会被更新。
describe('跨午夜 tick（行为，不是源码匹配）', () => {
  it('零点调度真的会推进 store.dayClock', async () => {
    vi.resetModules();
    const m = await import('./store.js');
    const { store, scheduleDayClock } = m;

    // 固定当前时间为本地 23:59:00，然后推进 2 秒跨过零点
    const before = new Date(2026, 10, 2, 23, 59, 0, 0).getTime();
    vi.useFakeTimers();
    vi.setSystemTime(before);

    const clockAtStart = Date.now();
    store.dayClock = clockAtStart;

    // scheduleDayClock 未导出时跳过（保持用例对实现方式不敏感）
    const sched = typeof scheduleDayClock === 'function'
      ? scheduleDayClock
      : m.__scheduleDayClockForTest;
    expect(typeof sched, 'scheduleDayClock 应可被调用（导出或测试钩子）').toBe('function');

    // 23:59:00 的「下一个零点后 1 秒」= 次日 00:00:01 ⇒ 距现在 61 秒，推进 62 秒足够
    sched();
    vi.advanceTimersByTime(62 * 1000);

    expect(store.dayClock, '跨过零点后 dayClock 必须变（否则 computed 不重算）').toBeGreaterThan(clockAtStart);
    const d = new Date(store.dayClock);
    expect(d.getDate(), '应已进入次日').toBe(3);

    vi.useRealTimers();
  });
});

});
