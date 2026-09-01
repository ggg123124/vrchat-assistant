// 通知域（单一职责：未读通知计数 / 公告新标记 + 加载方法）
// 架构：状态由根 store 合并（Object.assign），方法由 store.js 包装重导出——
// 视图继续 `import { store, loadNotifCount } from '../store.js'` 零改动（行为等价）。
// 依赖注入：api.get（网络层）与 updateTitle（标题更新——计数变化时刷新未读前缀）。
import { reactive } from 'vue';

/**
 * @typedef {Object} NotifState 通知域响应式状态
 * @property {number} notifCount 未读通知数（导航徽标 + 标题前缀）
 * @property {boolean} annHasNew 有新公告（导航徽标，对比 localStorage 基线）
 */

/**
 * @typedef {Object} NotifApi 通知域对外 API
 * @property {import('vue').UnwrapNestedRefs<NotifState>} state
 * @property {() => Promise<void>} loadNotifCount 拉取未读通知数（成功后刷新标题前缀）
 * @property {() => Promise<void>} loadAnnNewFlag 对比公告基线判断是否有新公告
 */

/**
 * 创建通知域（模块级单例使用）
 * @param {Object} [deps] 依赖注入
 * @param {(path: string, opts?: Object) => Promise<any>} [deps.get] api.get（网络层）
 * @param {() => void} [deps.updateTitle] 计数变化后刷新 document.title（未读前缀）
 * @returns {NotifApi}
 */
export function useNotif({ get = async () => null, updateTitle = () => {} } = {}) {
  const state = reactive({
    notifCount: 0,
    annHasNew: false,
  });

  async function loadNotifCount() {
    try {
      const r = await get('/api/dashboard/notifications/count');
      state.notifCount = (r && r.count) || 0;
      updateTitle();
    } catch {
      /* 计数加载失败静默（保留旧值） */
    }
  }

  async function loadAnnNewFlag() {
    try {
      const r = await get('/api/dashboard/group-announcements-all?limit=1');
      const latest = (r && r.announcements && r.announcements[0] && r.announcements[0].createdAt) || '';
      let base = '';
      try { base = localStorage.getItem('ga_last_seen') || ''; } catch { /* 隐私模式 */ }
      state.annHasNew = !!latest && !!base && latest > base;
    } catch {
      state.annHasNew = false;
    }
  }

  return { state, loadNotifCount, loadAnnNewFlag };
}
