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

// 用户头像展示统一入口：优先用户资料里设置的图标头像(user_icon)，兜底当前模型外观缩略图(currentAvatar)。
// 背景：currentAvatarImageUrl 语义是"穿戴的3D模型外观"，常为默认机器人图而非用户真实头像，
//       user_icon 是用户主动设置的头像（XM1023 显示机器人而非金发女仆头像 bug 的根因，2026-09-01）。
export const avatarOf = (iconUrl, modelUrl) => avatarThumb(iconUrl) || avatarThumb(modelUrl);
