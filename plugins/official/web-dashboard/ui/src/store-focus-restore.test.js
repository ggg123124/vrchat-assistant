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
});
