const HANDLER = Symbol('clickableHandler');
const CLICK_HANDLER = Symbol('clickableClickHandler');
const MODIFIERS = Symbol('clickableModifiers');

function normalize(binding) {
  const v = binding && binding.value;
  if (typeof v === 'function') return v;
  return null;
}

function onKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
  // ⚠️ 必须只处理落在自身的事件：容器内嵌原生 <button> 时，按钮上的 Enter 会冒泡到这里，
  // 若无条件 preventDefault 会把**浏览器对 <button> 的默认 Enter 激活**一起取消
  // ⇒ 复制 ID / 取消收藏这些按钮用键盘点不动（复审 EMeowAGENT 🔴1，实测父行命中 1 次）。
  if (e.target !== this) return;
  // 空格默认会滚动页面；Enter 在 role=button 上默认什么都不做，都拦掉
  e.preventDefault();
  applyModifiers(e, this[MODIFIERS]);
  const fn = this[HANDLER];
  if (fn) fn(e);
}

// click 必须用「具名」函数并保存引用：
// 早先写成 addEventListener('click', (e) => …) 且 unmounted 只移除 keydown
// ⇒ 监听器永远留在元素上。动态流每渲染一批行就新建一批元素与闭包，
// 元素被 Vue 移除后闭包仍被监听器持有 ⇒ 内存只增不减
// （2026-11-02 用户实测浏览器 OOM「Out of Memory」）。这里把同一引用存到元素上，卸载时一并摘掉。
function onClick(e) {
  // 只处理「落在自身」的点击：容器内常有原生 <button>（复制 ID / 取消收藏 / 移动分组），
  // 子元素的 click 会冒泡上来。若不守卫，父行的 handler 会被顺带触发
  //（复审 EMeowAGENT 🔴1/🔴2：点行内按钮会同时「打开详情 / 展开行」）。
  if (e.target !== this) return;
  applyModifiers(e, this[MODIFIERS]);
  const fn = this[HANDLER];
  if (fn) fn(e);
}

// 修饰符：自定义指令不会自动套 withModifiers（那是 @click.stop 的编译行为），
// .stop/.prevent 只是 binding.modifiers 里的布尔位，必须由指令自己处理。
// 复审 🔴1 实测：缺少这一层时子元素 click 会冒泡到父行 ⇒ 「点玩家名会同时打开用户卡 + 展开父行」。
function applyModifiers(e, mods) {
  if (!mods) return;
  if (mods.stop) e.stopPropagation();
  if (mods.prevent) e.preventDefault();
}

const installed = new WeakSet();

export const clickable = {
  mounted(el, binding) {
    const fn = normalize(binding);
    if (!fn) return;
    el[HANDLER] = fn;
    el[MODIFIERS] = binding.modifiers || null;
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
    el[MODIFIERS] = binding.modifiers || null;
    const fn = normalize(binding);
    if (fn) el[HANDLER] = fn;
  },
  unmounted(el) {
    if (!el) return;
    el.removeEventListener('click', el[CLICK_HANDLER] || onClick);
    el.removeEventListener('keydown', onKeydown);
    delete el[CLICK_HANDLER];
    delete el[MODIFIERS];
    delete el[HANDLER];
    installed.delete(el);
  },
};

export default clickable;
