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
  // 键盘事件只处理落在自身（或容器内无自己声明的普通子元素）的情况。
  if (ownsEvent(this, e.target)) return;
  // 长按会以 repeat=true 连续触发 keydown（原生 <button> 是 keyup 触发一次）。
  // 不加这道守卫时，.ev-row 这类 toggle 元素长按空格会来回抖动（复审 Lian-Hu 💡1，实测命中 5 次）。
  if (e.repeat) return;
  // 空格默认会滚动页面；Enter 在 role=button 上默认什么都不做，都拦掉
  e.preventDefault();
  // ⚠️ keydown 上**不应用** .stop：那会让全局快捷键（document 上的 Esc / Ctrl+K 之类）
  // 收不到事件。复审 EMeowAGENT 💡2 实测：在带 .stop 的元素上按 Enter，document 收到 0 次。
  // .prevent 仍需生效（阻止空格滚动），所以这里只传 prevent。
  applyModifiers(e, this[MODIFIERS] && { prevent: this[MODIFIERS].prevent });
  const fn = this[HANDLER];
  if (fn) fn(e);
}

// click 必须用「具名」函数并保存引用：
// 早先写成 addEventListener('click', (e) => …) 且 unmounted 只移除 keydown
// ⇒ 监听器永远留在元素上。动态流每渲染一批行就新建一批元素与闭包，
// 元素被 Vue 移除后闭包仍被监听器持有 ⇒ 内存只增不减
// （2026-11-02 用户实测浏览器 OOM「Out of Memory」）。这里把同一引用存到元素上，卸载时一并摘掉。
// 判定「这个事件是否该由容器自己处理」（复审 EMeowAGENT 第二轮 🔴1）：
// 不能在 e.target !== el 时一律早退 —— 冒泡上来的不只是 <button>，还有卡片内的
// <img>/<span>/<div>/<b>（缩略图、好友名、时间列），它们本就没有自己的可点声明，
// 原本正是**靠冒泡**触发父容器的动作。一律早退会让「整张卡片点不动」。
// 正确判据：从 target 往容器方向走，只要链上某一级**自己声明了可点**（有 v-clickable）
// 或是原生可交互元素（button/a/input/...），事件就归它，容器不重复处理。
const INTERACTIVE = /^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL)$/;
function ownsEvent(container, target) {
  for (let n = target; n && n !== container; n = n.parentElement) {
    if (n[CLICK_HANDLER] || (n.tagName && INTERACTIVE.test(n.tagName))) return true;
    // aria 语义上的可点元素（role=button 且不是本容器）也视为它自己处理
    if (n !== container && n.getAttribute && n.getAttribute('role') === 'button') return true;
  }
  return false;
}

function onClick(e) {
  if (ownsEvent(this, e.target)) return;
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
    if (!fn) return;
    el[HANDLER] = fn;
    // 复审 Lian-Hu 💡3：mounted 时 value 还不是函数（例如父组件数据未就绪）会直接 return，
    // 之后 updated 只更新 handler、从不补装监听 ⇒ 该元素**永久不可点且无任何报错**（实测命中 0）。
    // 这里检测「尚未安装」并补装。
    if (!installed.has(el)) {
      installed.add(el);
      el[CLICK_HANDLER] = onClick;
      el.addEventListener('click', onClick);
      el.addEventListener('keydown', onKeydown);
    }
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
