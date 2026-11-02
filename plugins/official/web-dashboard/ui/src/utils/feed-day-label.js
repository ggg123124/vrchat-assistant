/**
 * feed-day-label.js —— 动态流「今天 / 昨天 / MM-DD」分组标签（纯函数，无 Vue 依赖）
 *
 * 为什么单独抽出来（2026-11-02）：
 *   ① 它原本写在 FeedView.vue 的 <script setup> 里，**外部无法 import** ⇒ 跨午夜边界只能
 *      「等到明天」才能验证，等于不可测。抽成纯模块后可以直接喂 nowMs 覆盖边界。
 *   ② 原实现每行都调 new Date() 取「现在」；同一次渲染里逐行取时若跨秒/跨刻，理论上会出现
 *      两行用不同「现在」的不一致。现在由调用方传入统一的 nowMs。
 *
 * 边界（本模块存在的理由）：feedRows 是 computed，只随 rows 变化重算。23:59 打开页面时
 * 标签是「今天」，过了零点若不重算就一直是「今天」（其实已是昨天）；而 120s 全量轮询一旦
 * 刷新 feedEvents 就会让它突然跳成「昨天」，整组位置晃动一次。把「现在」变成显式入参，
 * 才能既保证一次渲染内一致、又能测住这个跳变。
 */

/** @param {string|number|Date|null|undefined} iso 行时间戳 @param {number} nowMs 「现在」 @returns {string} */
export function daySepLabel(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = new Date(nowMs);
  const yest = new Date(today.getTime() - 86400000);
  const same = (a, b) => a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
  if (same(d, today)) return '今天';
  if (same(d, yest)) return '昨天';
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export default daySepLabel;
