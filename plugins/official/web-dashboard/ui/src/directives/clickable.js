const HANDLER = Symbol('clickableHandler');
const CLICK_HANDLER = Symbol('clickableClickHandler');

function normalize(binding) {
  const v = binding && binding.value;
  if (typeof v === 'function') return v;
  return null;
}

function onKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  // 空格默认会滚动页面；Enter 在 role=button 上默认什么都不做，都拦掉
  e.preventDefault();
  const fn = this[HANDLER];
  if (fn) fn(e);
}

// click 必须用「具名」函数并保存引用：
// 早先写成 addEventListener('click', (e) => …) 且 unmounted 只移除 keydown
// ⇒ 监听器永远留在元素上。动态流每渲染一批行就新建一批元素与闭包，
// 元素被 Vue 移除后闭包仍被监听器持有 ⇒ 内存只增不减
// （2026-11-02 用户实测浏览器 OOM「Out of Memory」）。这里把同一引用存到元素上，卸载时一并摘掉。
function onClick(e) {
  const fn = this[HANDLER];
  if (fn) fn(e);
}

const installed = new WeakSet();

export const clickable = {
  mounted(el, binding) {
    const fn = normalize(binding);
    if (!fn) return;
    el[HANDLER] = fn;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    // 同一个元素可能被 v-if 复用后又重新 mounted —— WeakSet 防重复绑监听
    if (installed.has(el)) return;
    installed.add(el);
    el[CLICK_HANDLER] = onClick;
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKeydown);
  },
  updated(el, binding) {
    const fn = normalize(binding);
    if (fn) el[HANDLER] = fn;
  },
  unmounted(el) {
    if (!el) return;
    el.removeEventListener('click', el[CLICK_HANDLER] || onClick);
    el.removeEventListener('keydown', onKeydown);
    delete el[CLICK_HANDLER];
    delete el[HANDLER];
    installed.delete(el);
  },
};

export default clickable;
