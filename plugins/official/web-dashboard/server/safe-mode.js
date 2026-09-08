import { sendJson } from './http.js';

// #162：dashboard REST 层 safe-mode 语义统一为「云端不可逆操作保护」。
//   - 本地可恢复操作（如移除追踪=软删除，可恢复）放行——此前被误标破坏性拦截；
//   - 云端不可逆操作（删除画廊图片/删除照片/取消收藏）拦截——此前仅部分路由有检查，取消收藏漏网；
//   - MCP 层维持全拦（core/safe-mode.js assertToolAllowed，本文件不改动）。
// 统一入口避免逐路由散落判断，未来新增路由按可逆性标注即可不漏。

/**
 * safe-mode 下拦截云端不可逆操作。
 * @param api 插件 API（消费 dashboard.snapshot 服务读取 safeMode 状态）
 * @param res 响应对象（被拦截时已写回 JSON）
 * @param action 操作描述（用于文案，如「删除画廊图片」）
 * @returns true=已拦截（调用方直接 return）；false=放行
 */
export async function safeModeBlockIrreversible(api, res, action) {
  try {
    const snap = await api.consume('dashboard.snapshot');
    if (snap && snap.safeMode) {
      sendJson(res, { ok: false, error: `🔒 安全模式已启用：${action}属云端不可逆操作，已被禁用（关闭安全模式后可用）。` });
      return true;
    }
  } catch { /* 快照不可用时放行 */ }
  return false;
}
