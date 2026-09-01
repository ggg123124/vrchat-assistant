// 弹窗域（单一职责：详情弹窗/预览的打开与关闭）
// 架构：状态由根 store 合并（Object.assign），方法由 store.js 包装重导出——
// 视图继续 `import { store, openUser } from '../store.js'` 零改动（行为等价）。
// 依赖注入：open 前的 UI 副作用（移动端收起好友抽屉）与字符串 id 补全查询
// 由 store.js 组合时传入，避免本模块反向依赖 store（循环依赖）。
import { reactive } from 'vue';

/**
 * @typedef {Object} UserSummary 用户摘要（弹窗最小展示数据）
 * @property {string} userId 用户 ID（usr_ 前缀）
 * @property {string} [displayName] 显示名（未知时回退为 userId）
 * @property {boolean} [isOnline] 在线标记（未知时 false）
 * @property {string} [avatarUrl] 头像 URL（可选）
 * @property {string} [platform] 平台（可选）
 */

/**
 * @typedef {Object} WorldSummary 世界摘要
 * @property {string} worldId 世界 ID（wrld_ 前缀）
 * @property {string} [name] 世界名（可选）
 */

/**
 * @typedef {Object} ModalApi 弹窗域对外 API
 * @property {import('vue').UnwrapNestedRefs<ModalState>} state 响应式弹窗状态（合并进根 store）
 * @property {(u: string|UserSummary|null|undefined) => void} openUser 打开用户弹窗
 * @property {() => void} closeUser 关闭用户弹窗
 * @property {(wid: string|WorldSummary|null|undefined) => void} openWorld 打开世界弹窗
 * @property {() => void} closeWorld 关闭世界弹窗
 * @property {(aid: string|Object|null|undefined) => void} openAvatar 打开模型弹窗
 * @property {() => void} closeAvatar 关闭模型弹窗
 * @property {(g: string|Object|null|undefined) => void} openGroup 打开群组弹窗
 * @property {() => void} closeGroup 关闭群组弹窗
 * @property {(loc: string|null|undefined) => void} openInstance 打开实例弹窗
 * @property {() => void} closeInstance 关闭实例弹窗
 * @property {(url: string|null|undefined) => void} openPreview 打开图片预览
 */

/**
 * @typedef {Object} ModalState 弹窗响应式状态
 * @property {UserSummary|null} userModal
 * @property {WorldSummary|null} worldModal
 * @property {Object|null} avatarModal
 * @property {Object|null} groupModal
 * @property {{location: string}|null} instanceModal
 * @property {string|null} previewUrl
 */

/**
 * 创建弹窗域（模块级单例使用；也可在组件内调用获得独立实例）
 * @param {Object} [deps] 依赖注入
 * @param {() => void} [deps.onBeforeOpen] 打开前副作用（移动端收起好友抽屉）
 * @param {(id: string) => UserSummary|undefined} [deps.resolveUser] 字符串 userId → 用户摘要（好友表补全）
 * @returns {ModalApi}
 */
export function useModal({ onBeforeOpen = () => {}, resolveUser = () => undefined } = {}) {
  const state = reactive({
    userModal: null,
    worldModal: null,
    avatarModal: null,
    groupModal: null,
    instanceModal: null,
    previewUrl: null,
  });

  function openUser(u) {
    if (!u) return; // 防御：空值直接忽略
    onBeforeOpen();
    if (typeof u === 'string') {
      // 字符串 userId：优先从好友列表补全展示信息，找不到回退最小对象（仍可打开）
      const found = resolveUser(u);
      state.userModal = found || { userId: u, displayName: u, isOnline: false };
    } else {
      state.userModal = u;
    }
  }
  const closeUser = () => { state.userModal = null; };

  function openWorld(wid) {
    if (!wid) return;
    onBeforeOpen();
    state.worldModal = typeof wid === 'string' ? { worldId: wid } : wid;
  }
  const closeWorld = () => { state.worldModal = null; };

  function openAvatar(aid) {
    if (!aid) return;
    onBeforeOpen();
    state.avatarModal = typeof aid === 'string' ? { avatarId: aid } : aid;
  }
  const closeAvatar = () => { state.avatarModal = null; };

  function openGroup(g) {
    if (!g) return;
    onBeforeOpen();
    state.groupModal = typeof g === 'string' ? { groupId: g } : g;
  }
  const closeGroup = () => { state.groupModal = null; };

  function openInstance(loc) {
    if (!loc) return;
    onBeforeOpen();
    state.instanceModal = { location: loc };
  }
  const closeInstance = () => { state.instanceModal = null; };

  function openPreview(url) {
    if (!url) return;
    onBeforeOpen();
    state.previewUrl = url;
  }

  return { state, openUser, closeUser, openWorld, closeWorld, openAvatar, closeAvatar, openGroup, closeGroup, openInstance, closeInstance, openPreview };
}
