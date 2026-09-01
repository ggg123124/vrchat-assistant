// 导航域（单一职责：视图切换 / 移动端抽屉 / 快速搜索 / URL hash 同步 / 标题更新）
// 架构：状态由根 store 合并（Object.assign），setView 由 store.js 包装重导出——
// 视图继续 `import { setView } from '../store.js'` 零改动（行为等价）。
// 依赖注入：标题更新（依赖 notifCount/viewMap）与 URL 筛选序列化（依赖 feed 筛选状态）
// 由 store.js 组合时传入，避免本模块反向依赖 store（循环依赖）。
import { reactive } from 'vue';

/** 视图名 → 中文标题（导航/标题栏共用） */
export const VIEW_LABELS = {
  feed: '动态', friends: '好友', tracked: '非好友追踪', favorites: '收藏', logs: '日志', players: '玩家',
  notifications: '通知', avatars: '模型', worlds: '足迹', xworlds: 'X推荐', recommend: '推荐', groups: '群组',
  events: '活动', charts: '图表', report: '周报', moderation: '屏蔽', tools: '工具', search: '搜索', open: '直接打开',
};

/**
 * @typedef {Object} NavState 导航响应式状态
 * @property {string} view 当前视图（VIEW_LABELS 的 key）
 * @property {boolean} isMobile 移动端布局标记
 * @property {boolean} navOpen 移动端导航抽屉
 * @property {boolean} friendsOpen 移动端好友抽屉
 * @property {boolean} quickSearchOpen 快速搜索弹窗（Ctrl+K）
 */

/**
 * @typedef {Object} NavApi 导航域对外 API
 * @property {import('vue').UnwrapNestedRefs<NavState>} state
 * @property {(view: string) => void} setView 切换视图（滚动回顶 + URL hash + 标题）
 * @property {() => void} closeMobileDrawers 移动端收起所有抽屉（弹窗打开前调用）
 */

/**
 * 创建导航域（模块级单例使用）
 * @param {Object} [deps] 依赖注入
 * @param {(view: string) => void} [deps.updateTitle] 切换视图后更新 document.title
 * @param {() => { filter: string[], fav: boolean }} [deps.serializeFilter] 读取当前 feed 筛选（URL 序列化）
 * @returns {NavApi}
 */
export function useNav({ updateTitle = () => {}, serializeFilter = () => ({ filter: [], fav: false }) } = {}) {
  const state = reactive({
    view: 'feed',
    isMobile: false,
    navOpen: false,
    friendsOpen: false,   // 移动端右侧好友抽屉（桌面右侧栏在手机上改由抽屉打开）
    quickSearchOpen: false, // 快速搜索弹窗（Ctrl+K / 头部按钮）
  });

  function setView(view) {
    state.view = view;
    state.navOpen = false;
    state.quickSearchOpen = false;
    // 视图切换后滚动回顶部（下次渲染生效；避免从长列表底部切到新视图从底部开始）
    requestAnimationFrame(() => {
      const el = document.querySelector('.main-viewport');
      if (el) el.scrollTo({ top: 0 });
    });
    const { filter = [], fav = false } = serializeFilter();
    const q = new URLSearchParams();
    q.set('view', view);
    if (filter && filter.length) q.set('filter', filter.join(','));
    if (fav) q.set('fav', '1');
    history.replaceState(null, '', location.pathname + location.search + '#' + q.toString());
    updateTitle(view);
  }

  function closeMobileDrawers() {
    if (state.isMobile && state.friendsOpen) state.friendsOpen = false;
  }

  return { state, setView, closeMobileDrawers };
}
