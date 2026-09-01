/**
 * 世界推荐主题配置 — theme → 关键词正则
 *
 * 内置默认主题关键词表（中文/日文/英文），config 表 recommend_theme_config
 * （JSON: {theme: [keywords...]}）可扩展覆盖：默认 ∪ 用户覆盖，运行时每次读取生效。
 */

import { ctx } from './server-context.js';

export const DEFAULT_THEME_CONFIG = {
  sleep: ['寝', '眠', '睡眠', 'sleep', 'quiet', '静か', 'relax', 'リラックス', '安らぎ', '癒し', 'meditation', '冥想', 'cozy', 'ゆったり'],
  chat: ['talk', 'chat', '交流', '雑談', 'cafe', 'カフェ', 'coffee', '喫茶'],
  onsen: ['温泉', 'onsen', '風呂', 'hot spring', '銭湯'],
  game: ['game', 'ゲーム', '麻雀', '競馬', 'driving', 'racing'],
  horror: ['horror', '恐怖', 'ホラー', 'scary', '怖い'],
  dance: ['dance', 'ダンス', 'club', 'クラブ', 'disco', 'ディスコ'],
};

/** 合并默认主题表与 config 表覆盖（默认 ∪ 用户覆盖；解析失败按默认） */
function loadThemeConfig() {
  const merged = { ...DEFAULT_THEME_CONFIG };
  try {
    const raw = ctx?.storage?.getConfig('recommend_theme_config');
    if (raw) {
      const user = JSON.parse(raw);
      if (user && typeof user === 'object') {
        for (const [theme, kws] of Object.entries(user)) {
          if (Array.isArray(kws)) {
            merged[theme] = [...new Set([...(merged[theme] || []), ...kws])];
          }
        }
      }
    }
  } catch (e) { /* 配置缺失/解析失败按默认 */ }
  return merged;
}

/**
 * 返回指定主题的关键词正则数组（无该主题返回 []）
 * @param {string} theme sleep/chat/onsen/game/horror/dance
 * @returns {RegExp[]}
 */
export function getThemeRegex(theme) {
  const keywords = loadThemeConfig()[theme] || [];
  const regexes = [];
  for (const kw of keywords) {
    if (typeof kw !== 'string' || !kw.trim()) continue;
    try { regexes.push(new RegExp(kw, 'i')); } catch (e) { /* 非法正则跳过 */ }
  }
  return regexes;
}
