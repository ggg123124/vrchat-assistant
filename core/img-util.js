/**
 * 图片 URL 处理共享工具（core 跨模块复用）
 *
 * dashboard-services.js 与 event-pipeline.js 都需要把 VRChat 图片 URL 转换成本地代理/缩略图。
 * 抽到独立模块供两者 import，避免各写一份（2026-09-01 SSE 增量富化改造时抽出）。
 */
// 把 VRChat CDN 图片 URL 改写成本地图片代理（浏览器经服务端缓存拉取，避免国内直连 CDN 被墙/慢）
export const imgProxy = (u) => {
  if (!u) return u;
  if (!/^https:\/\/(api\.vrchat\.cloud|d348imysud55la\.cloudfront\.net|assets\.vrchat\.com|files\.vrchat\.cloud)\//.test(String(u))) return u;
  return '/api/dashboard/image-proxy?url=' + encodeURIComponent(u);
};

// VRChat 完整头像图(file 5MB) → 256px 缩略图(image)，列表显示用缩略图（代理/缓存秒载）
// URL 规则（VRChat 真实缩略图）：/file/{file_id}/[version]/[/file|/] → /image/{file_id}/1/256
// 注意：VRChat file URL 结尾有 /1/file、/1、/1/ 等变体（user_icon 常为 /1 或 /1/ 结尾），
//       legacy 只匹配 /1/file 导致 user_icon 无法转缩略图 → 放宽为匹配 /file/{file_id}/ 前缀。
//       生成缩略图固定 version=/1/256（曾错用 /3/256 导致部分 file 404）。
//       已是 /image/ 缩略图则原样走代理。
export const avatarThumb = (u) => {
  if (!u) return u;
  const s = String(u);
  const m = s.match(/\/file\/(file_[a-f0-9-]+)\//);
  const thumbUrl = m ? `https://api.vrchat.cloud/api/1/image/${m[1]}/1/256` : s;
  return imgProxy(thumbUrl);
};

// 从（可能已 imgProxy 代理改写的）URL 提取 VRChat file id（file_xxx）。
// 背景：imgProxy 把原始 URL encodeURIComponent 进 /api/dashboard/image-proxy?url=...，
// 其中 /file/ 被编码成 %2Ffile%2F，直接正则匹配会失败（#122 引入 img-util 后曾导致
// 模型名解析全部失配，dashboard 显示"未知模型"）。此处先还原代理 URL 再匹配。
// 接受原始 URL 或代理 URL，均返回 file id；无法提取返回 null。
export const avatarFileId = (u) => {
  if (!u) return null;
  let s = String(u);
  const pm = s.match(/^\/api\/dashboard\/image-proxy\?url=(.+)$/);
  if (pm) { try { s = decodeURIComponent(pm[1]); } catch { /* 保持原样 */ } }
  // VRChat 模型图有两种 URL 形态：/file/file_XXX/1/file 与 /image/file_XXX/1/256 —— 段名分别是 file / image。
  // 本机实测（413 好友 / 4615 条 avatar 事件，2026-09-22）：好友记录里 image 占 234/413（57%）、
  // 动态补名 job 里 image 占 833/8165（10%）⇒ 两种形态都真实存在，不能只认一种。
  // 旧正则只认 /file/ ⇒ image 形态一律返回 null ⇒ 上层 `if (!fileId) continue` **静默跳过** ⇒ 模型名永不补齐
  //（这才是本 PR 修的那一半；注意**不是**「日志里连续 404」—— 旧代码根本不会发出请求）。
  // ⚠️ 另注：`avimg:*` 映射恒空**与本正则无关** ✗ —— 写侧有 `if (fm && f.currentAvatar)` 守卫，而现代 VRChat API
  // 已从 User 对象移除 `currentAvatar`（见 docs/DASHBOARD-DEV-STATUS.md:348），该映射属「API 恢复字段即自动生效」的预留。
  const fm = s.match(/\/(?:file|image)\/(file_[a-f0-9-]+)/);
  return fm ? fm[1] : null;
};

// 用户头像展示统一入口：优先用户资料里设置的图标头像(user_icon)，兜底当前模型外观缩略图(currentAvatar)。
// 背景：currentAvatarImageUrl 语义是"穿戴的3D模型外观"，常为默认机器人图而非用户真实头像，
//       user_icon 是用户主动设置的头像（XM1023 显示机器人而非金发女仆头像 bug 的根因，2026-09-01）。
export const avatarOf = (iconUrl, modelUrl) => avatarThumb(iconUrl) || avatarThumb(modelUrl);
