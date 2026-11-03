// @vitest-environment happy-dom
/**
 * clickable.test.js —— v-clickable 指令的键盘可达性回归（2026-11-02）
 *
 * 立这条用例的原因：全仓原有 51 处手写 `role="button" tabindex="0" @keydown.enter` 三件套，
 * **它们全部只支持 Enter，按空格毫无反应**（真实浏览器实测：Enter +100，Space +0）。
 * 原生 <button> 的行为是 Enter 立即触发、空格在 keyup 触发，键盘用户对此有肌肉记忆。
 *
 * 本用例直接驱动真实指令模块（不 mock 被测代码），钉住：
 *  ① mounted 时自动补 role="button" 与 tabindex="0"；
 *  ② Enter 触发 handler；
 *  ③ **Space 也触发 handler**（这是本次修复的核心，改回去就必须红）；
 *  ④ 两者都 preventDefault（否则空格会滚动页面）；
 *  ⑤ unmounted 后不再触发（避免组件销毁后仍响应键盘）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { clickable } from './clickable.js';

const mkEl = () => {
  const el = document.createElement('span');
  el.className = 'world-link';
  document.body.appendChild(el);
  return el;
};

const fire = (el, type, key) => {
  const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

describe('v-clickable', () => {
  let el;
  let hits;

  beforeEach(() => {
    hits = 0;
    el = mkEl();
  });

  afterEach(() => {
    clickable.unmounted(el);
    el.remove();
  });

  it('mounted 自动补 role 与 tabindex', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    expect(el.getAttribute('role')).toBe('button');
    expect(el.getAttribute('tabindex')).toBe('0');
  });

  it('click 触发 handler', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hits).toBe(1);
  });

  it('Enter 触发 handler 且 preventDefault', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    const e = fire(el, 'keydown', 'Enter');
    expect(hits).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('Space 也触发 handler 且 preventDefault（本次修复的核心）', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    const e = fire(el, 'keydown', ' ');
    expect(hits).toBe(1);
    expect(e.defaultPrevented).toBe(true);
  });

  it('其它键不触发也不 preventDefault', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    const e = fire(el, 'keydown', 'a');
    expect(hits).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it('updated 换 handler 后触发新的', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    clickable.updated(el, { value: () => { hits += 100; } });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hits).toBe(100);
  });

  it('unmounted 后键盘不再触发', () => {
    clickable.mounted(el, { value: () => { hits += 1; } });
    clickable.unmounted(el);
    fire(el, 'keydown', 'Enter');
    expect(hits).toBe(0);
  });

  it('handler 不是函数时静默忽略（模板里可能传 undefined）', () => {
    clickable.mounted(el, { value: undefined });
    fire(el, 'keydown', 'Enter');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hits).toBe(0);
  });

  it('已存在的 role / tabindex 不被覆盖', () => {
    el.setAttribute('role', 'option');
    el.setAttribute('tabindex', '3');
    clickable.mounted(el, { value: () => { hits += 1; } });
    expect(el.getAttribute('role')).toBe('option');
    expect(el.getAttribute('tabindex')).toBe('3');
  });


  // ── 内存泄漏护栏（2026-11-02 用户实测 OOM 后补）──
  // 事故：click 监听用匿名箭头函数且 unmounted 只移除 keydown ⇒ 监听器永远留在元素上。
  // 动态流反复渲染/卸载行时，闭包被监听器持有 ⇒ 内存只增不减 ⇒ 浏览器「Out of Memory」。
  it('unmounted 后 click 监听也必须被移除（防内存泄漏）', () => {
    let clicks = 0;
    const origAdd = el.addEventListener.bind(el);
    const origRemove = el.removeEventListener.bind(el);
    const added = new Map();
    const removed = [];
    el.addEventListener = (t, fn, o) => { added.set(t + ':' + (fn.name || 'anon'), fn); return origAdd(t, fn, o); };
    el.removeEventListener = (t, fn, o) => { removed.push(t + ':' + (fn && fn.name ? fn.name : 'anon')); return origRemove(t, fn, o); };

    clickable.mounted(el, { value: () => { clicks += 1; } });
    expect(added.has('click:onClick')).toBe(true);

    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(clicks).toBe(1);

    clickable.unmounted(el);
    // 关键断言：click 与 keydown 两个监听都必须被摘掉
    expect(removed.some((r) => r.startsWith('click:'))).toBe(true);
    expect(removed.some((r) => r.startsWith('keydown:'))).toBe(true);
  });

  it('反复 mount/unmount 不应累积监听（模拟动态流滚动）', () => {
    const counts = { add: 0, remove: 0 };
    const origAdd = el.addEventListener.bind(el);
    const origRemove = el.removeEventListener.bind(el);
    el.addEventListener = (t, fn, o) => { if (t === 'click') counts.add++; return origAdd(t, fn, o); };
    el.removeEventListener = (t, fn, o) => { if (t === 'click') counts.remove++; return origRemove(t, fn, o); };

    for (let i = 0; i < 5; i++) {
      clickable.mounted(el, { value: () => {} });
      clickable.unmounted(el);
    }
    expect(counts.add).toBe(5);
    expect(counts.remove).toBe(5);
    expect(counts.add - counts.remove).toBe(0);
  });



  // ── 复审 🔴1（2026-11-02，nixi-agent）：修饰符必须真的生效 ──
  // 事故：v-clickable.stop 迁移后只读 binding.value、从不读 binding.modifiers
  // ⇒ 子元素点击冒泡到父行 ⇒「点玩家名会同时打开用户卡 + 展开父行」。
  it('.stop 必须阻止冒泡（子元素点击不触发父元素）', () => {
    const parent = document.createElement('div');
    const child = document.createElement('span');
    parent.appendChild(child);
    document.body.appendChild(parent);

    const calls = [];
    clickable.mounted(parent, { value: () => calls.push('parent'), modifiers: {} });
    clickable.mounted(child, { value: () => calls.push('child'), modifiers: { stop: true } });

    child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(calls, '.stop 应阻止冒泡到父元素').toEqual(['child']);

    clickable.unmounted(child);
    clickable.unmounted(parent);
    document.body.removeChild(parent);
  });

  // ⚠️ 用例名原为「.stop 对键盘 Enter 也必须阻止冒泡」，**语义已不成立**
  // （复审 EMeowAGENT 第 4 轮指出）：keydown 上有意**不再应用** .stop（否则吞掉
  // document 上的全局快捷键）。这条现在能通过是因为父容器被 ownsEvent() 早退
  // ——子元素自己声明了可点，事件归它——而不是 .stop 生效。
  // 改成如实的名字，免得后来者以为 keydown 的 .stop 还在。
  it('父容器不重复处理子元素已声明的键盘事件（由 ownsEvent 保证，非 .stop）', () => {
    const parent = document.createElement('div');
    const child = document.createElement('span');
    parent.appendChild(child);
    document.body.appendChild(parent);

    const calls = [];
    clickable.mounted(parent, { value: () => calls.push('parent'), modifiers: {} });
    clickable.mounted(child, { value: () => calls.push('child'), modifiers: { stop: true } });

    child.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(calls, '事件归子元素，父容器不重复处理').toEqual(['child']);

    clickable.unmounted(child);
    clickable.unmounted(parent);
    document.body.removeChild(parent);
  });

  // ⚠️ 语义已于 2026-11-02 变更（复审 EMeowAGENT 🔴1/🔴2 后）：
  // 指令现在只处理「落在自身」的事件（e.target !== el 直接 return）。
  // 于是「父行 + 子可点元素各自 v-clickable」这种嵌套结构默认就互不干扰，
  // .stop 不再是必需品（保留它作为显式意图仍然生效）。
  // 这条用例从「冒泡应照常」改为「嵌套时各管各的」，否则会与新的正确行为冲突。
  it('嵌套时各管各的：点子元素只触发子元素（默认就不冒泡污染父行）', () => {
    const parent = document.createElement('div');
    const child = document.createElement('span');
    parent.appendChild(child);
    document.body.appendChild(parent);

    const calls = [];
    clickable.mounted(parent, { value: () => calls.push('parent'), modifiers: {} });
    clickable.mounted(child, { value: () => calls.push('child'), modifiers: {} });

    child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(calls, '子元素命中，父元素不该被冒泡触发').toEqual(['child']);

    parent.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(calls, '点在父元素本身仍要生效').toEqual(['child', 'parent']);

    clickable.unmounted(child);
    clickable.unmounted(parent);
    document.body.removeChild(parent);
  });



  // ── 复审 🔴1（2026-11-02，EMeowAGENT）：容器内原生 <button> 的键盘/点击不能被父行吞掉 ──
  // 事故：onKeydown 无条件 preventDefault ⇒ 容器内原生 <button> 的 Enter 激活被取消；
  // 且父行 handler 被冒泡顺带触发（实测命中 1 次）。修法：e.target !== el 直接 return。
  it('容器内原生 button 的 click 不应触发父行 handler', () => {
    const row = document.createElement('div');
    const btn = document.createElement('button');
    row.appendChild(btn);
    document.body.appendChild(row);

    let rowHits = 0;
    let btnHits = 0;
    clickable.mounted(row, { value: () => { rowHits += 1; }, modifiers: {} });
    btn.addEventListener('click', () => { btnHits += 1; });

    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(btnHits, '按钮自身应响应').toBe(1);
    expect(rowHits, '父行不该被冒泡触发').toBe(0);

    // 点在行本身仍要生效
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(rowHits).toBe(1);

    clickable.unmounted(row);
    document.body.removeChild(row);
  });

  it('容器内原生 button 的 Enter 不应被父行 preventDefault（否则原生激活被取消）', () => {
    const row = document.createElement('div');
    const btn = document.createElement('button');
    row.appendChild(btn);
    document.body.appendChild(row);

    let rowHits = 0;
    clickable.mounted(row, { value: () => { rowHits += 1; }, modifiers: {} });

    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented, '按钮上的 Enter 不能被父行取消默认行为').toBe(false);
    expect(rowHits, '父行不该被冒泡触发').toBe(0);

    // 在行本身按 Enter 仍要 preventDefault 且触发
    const ev2 = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    row.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(true);
    expect(rowHits).toBe(1);

    clickable.unmounted(row);
    document.body.removeChild(row);
  });



  // ── 复审 💡1（2026-11-02，Lian-Hu-Agent）：长按不应连续触发 ──
  // 事故：keydown 无 e.repeat 守卫 ⇒ 长按空格命中 5 次（原生 <button> 为 1 次），
  // .ev-row 这类 toggle 元素会来回抖动。
  it('长按（repeat=true）只应触发一次', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    let hits = 0;
    clickable.mounted(el, { value: () => { hits += 1; }, modifiers: {} });

    for (let i = 0; i < 5; i += 1) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, repeat: i > 0 }));
    }
    expect(hits, '长按应只触发一次（对齐原生 button）').toBe(1);

    clickable.unmounted(el);
    document.body.removeChild(el);
  });



  // ── 复审 💡3（Lian-Hu-Agent）：初值不是函数时，updated 必须补装监听 ──
  it('mounted 时 value 非函数、updated 才给函数：应能补装并响应', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    let hits = 0;

    clickable.mounted(el, { value: undefined, modifiers: {} });
    expect(hits, '初值非函数时不应崩').toBe(0);

    clickable.updated(el, { value: () => { hits += 1; }, modifiers: {} });
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(hits, 'updated 补装后应可点击（否则元素永久不可点且无报错）').toBe(1);

    clickable.unmounted(el);
    document.body.removeChild(el);
  });



  // ── 复审 🔴1 第二轮（2026-11-02，EMeowAGENT）：e.target !== el 守卫过严 ──
  // 事故：一律早退让「卡片内图片/文字」点击全部失效（比原 bug 更伤日常——
  // 卡片可点区域缩到只剩背景）。正确判据是「事件是否归链上某一级自己处理」。
  describe('事件归属判定（所有权链）', () => {
    const mk = (tag) => document.createElement(tag);
    const click = (el) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    it('容器内普通子元素（img/span/div）应触发父容器', () => {
      const parent = mk('div');
      const inner = mk('img');
      const label = mk('span');
      parent.appendChild(inner);
      parent.appendChild(label);
      document.body.appendChild(parent);
      let hits = 0;
      clickable.mounted(parent, { value: () => { hits += 1; }, modifiers: {} });

      click(inner);
      expect(hits, '卡片缩略图必须可点').toBe(1);
      click(label);
      expect(hits, '卡片内文字必须可点').toBe(2);

      clickable.unmounted(parent);
      document.body.removeChild(parent);
    });

    it('容器内原生 button 不触发父容器（按钮自己处理）', () => {
      const parent = mk('div');
      const btn = mk('button');
      parent.appendChild(btn);
      document.body.appendChild(parent);
      let parentHits = 0;
      let btnHits = 0;
      clickable.mounted(parent, { value: () => { parentHits += 1; }, modifiers: {} });
      btn.addEventListener('click', () => { btnHits += 1; });

      click(btn);
      expect(btnHits).toBe(1);
      expect(parentHits).toBe(0);

      clickable.unmounted(parent);
      document.body.removeChild(parent);
    });

    it('button 内的 span 也不触发父容器（链上有 button 即归它）', () => {
      const parent = mk('div');
      const btn = mk('button');
      const s = mk('span');
      btn.appendChild(s);
      parent.appendChild(btn);
      document.body.appendChild(parent);
      let hits = 0;
      clickable.mounted(parent, { value: () => { hits += 1; }, modifiers: {} });

      click(s);
      expect(hits).toBe(0);

      clickable.unmounted(parent);
      document.body.removeChild(parent);
    });

    it('容器内嵌套另一个 v-clickable 子元素：只触发子元素', () => {
      const parent = mk('div');
      const child = mk('span');
      parent.appendChild(child);
      document.body.appendChild(parent);
      let parentHits = 0;
      let childHits = 0;
      clickable.mounted(parent, { value: () => { parentHits += 1; }, modifiers: {} });
      clickable.mounted(child, { value: () => { childHits += 1; }, modifiers: {} });

      click(child);
      expect(childHits).toBe(1);
      expect(parentHits, '嵌套时父容器不该重复处理').toBe(0);

      clickable.unmounted(child);
      clickable.unmounted(parent);
      document.body.removeChild(parent);
    });

    it('容器自身仍响应', () => {
      const parent = mk('div');
      document.body.appendChild(parent);
      let hits = 0;
      clickable.mounted(parent, { value: () => { hits += 1; }, modifiers: {} });
      click(parent);
      expect(hits).toBe(1);
      clickable.unmounted(parent);
      document.body.removeChild(parent);
    });
  });



  // ── 复审 EMeowAGENT 💡2：keydown 上不得应用 .stop（否则吞掉全局快捷键）──
  it('带 .stop 的元素上按 Enter，document 仍应收到事件（不吞全局快捷键）', () => {
    const box = document.createElement('div');
    document.body.appendChild(box);
    let docSaw = 0;
    const onDoc = (e) => { if (e.key === 'Enter') docSaw += 1; };
    document.addEventListener('keydown', onDoc);

    clickable.mounted(box, { value: () => {}, modifiers: { stop: true } });
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(docSaw, 'keydown 上的 .stop 不应阻止事件到达 document').toBe(1);

    document.removeEventListener('keydown', onDoc);
    clickable.unmounted(box);
    document.body.removeChild(box);
  });

  it('click 上的 .stop 仍然生效（不能因为改 keydown 一起丢掉）', () => {
    const outer = document.createElement('div');
    const box = document.createElement('div');
    outer.appendChild(box);
    document.body.appendChild(outer);
    let outerHits = 0;
    outer.addEventListener('click', () => { outerHits += 1; });

    clickable.mounted(box, { value: () => {}, modifiers: { stop: true } });
    box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    expect(outerHits, 'click 的 .stop 必须仍然阻止冒泡').toBe(0);

    clickable.unmounted(box);
    document.body.removeChild(outer);
  });

});
