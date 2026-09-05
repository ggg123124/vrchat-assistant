// resolve.js — 中文 STT 噪声鲁棒检索（纯函数模块，不依赖 api/db，可独立单测）
// 双通道归一化（汉字 + 拼音）→ 多信号打分（精确/拼音同音/token 重叠/编辑距离）→ 歧义判定。

import { pinyin } from 'pinyin-pro';

const THRESHOLD = 0.85;
const MARGIN = 0.2;
const MAX_QUERY_LEN = 200;

const CTRL_ZW_RE = /[\u200b-\u200d\uFEFF\u0000-\u001f\u007f]/g;
const FULLWIDTH_RE = /[\uFF01-\uFF5E]/g;
const KEEP_RE = /[^\u4e00-\u9fffa-z0-9]/g;
const HANZI_RE = /[\u4e00-\u9fff]/;

export { THRESHOLD, MARGIN, MAX_QUERY_LEN };

/** 汉字通道归一化：去控制/零宽 → NFC → 全角转半角 → 小写 → 去标点/空白（保留中英文/数字） */
export function normalizeHanzi(s) {
  if (typeof s !== 'string') return '';
  return s
    .replace(CTRL_ZW_RE, '')
    .normalize('NFC')
    .replace(FULLWIDTH_RE, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .toLowerCase()
    .replace(KEEP_RE, '');
}

/** 拼音通道：返回数组（每个中文字为音节串，英文/数字整词原样） */
export function toPinyinArr(s) {
  if (!s) return [];
  return pinyin(s, { toneType: 'none', type: 'array', nonZh: 'consecutive' });
}

/** 拼音连写串（无分隔、全小写；如 狐狸检查PR → hulijianchapr） */
export function toPinyinStr(s) {
  return toPinyinArr(s)
    .map((x) => String(x).toLowerCase())
    .join('');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

function isHanziChar(ch) {
  return HANZI_RE.test(ch);
}

function addToken(map, token, significant) {
  if (!token) return;
  map.set(token, significant === true || map.get(token) === true);
}

/**
 * 合并 token 集合：拼音数组每项即 token（英文/数字整词保留）+ 汉字通道单字/相邻 2-gram。
 * 返回 Map<token, significant>。显著 token = 英文 token 或长度 ≥2 的音节 token。
 */
export function tokenSet(normalized) {
  const map = new Map();
  const arr = toPinyinArr(normalized);
  let idx = 0;
  let i = 0;
  const len = normalized.length;
  while (i < len) {
    const ch = normalized[i];
    if (isHanziChar(ch)) {
      const t = String(arr[idx] ?? '').toLowerCase();
      addToken(map, t, t.length >= 2);
      idx++;
      i++;
    } else {
      let j = i;
      while (j < len && !isHanziChar(normalized[j])) j++;
      const t = String(arr[idx] ?? '').toLowerCase();
      addToken(map, t, true);
      idx++;
      i = j;
    }
  }
  const chars = [];
  for (const c of normalized) {
    if (isHanziChar(c)) chars.push(c);
  }
  for (const c of chars) addToken(map, c, false);
  for (let k = 0; k + 1 < chars.length; k++) addToken(map, chars[k] + chars[k + 1], false);
  return map;
}

function mergeTokenMaps(hanziStrings) {
  const merged = new Map();
  for (const s of hanziStrings) {
    if (!s) continue;
    for (const [t, sig] of tokenSet(s)) {
      merged.set(t, sig === true || merged.get(t) === true);
    }
  }
  return merged;
}

function prepareQuery(raw) {
  const hans = normalizeHanzi(String(raw ?? ''));
  return { hans, pinyin: toPinyinStr(hans), tokens: tokenSet(hans) };
}

function prepareItem(item) {
  const note = typeof item.note === 'string' ? item.note : '';
  const aliases = Array.isArray(item.aliases) ? item.aliases.filter((x) => typeof x === 'string') : [];
  const tags = Array.isArray(item.tags) ? item.tags.filter((x) => typeof x === 'string') : [];
  // 拼音必须对「已归一化」的字符串计算（原始文本含空格会被 pinyin-pro 并入 nonZh token）
  const noteHans = item.noteHans ?? normalizeHanzi(note);
  const aliasesHans = item.aliasesHans ?? aliases.map(normalizeHanzi);
  const tagsHans = item.tagsHans ?? tags.map(normalizeHanzi);
  return {
    emojiId: item.emojiId,
    kind: item.kind || 'custom',
    note,
    aliases,
    tags,
    noteHans,
    notePinyin: item.notePinyin ?? toPinyinStr(noteHans),
    aliasesHans,
    aliasesPinyin: item.aliasesPinyin ?? aliasesHans.map(toPinyinStr),
    tagsHans,
    tagsPinyin: item.tagsPinyin ?? tagsHans.map(toPinyinStr),
  };
}

function scorePrepared(query, item) {
  const hans = query.hans;
  const py = query.pinyin;
  const isBuiltin = item.kind === 'builtin';

  // 1. 精确/别名精确（汉字通道）——命中即止
  if (hans !== '') {
    if (hans === item.noteHans) return { confidence: 1.0, matchedBy: isBuiltin ? 'builtin_en' : 'alias' };
    if (item.aliasesHans.includes(hans)) return { confidence: 1.0, matchedBy: isBuiltin ? 'builtin_zh' : 'alias' };
    if (item.tagsHans.includes(hans)) return { confidence: 1.0, matchedBy: 'alias' };
  }

  // 2. 拼音同音匹配（同音错字主解法）
  if (py !== '' && (py === item.notePinyin || item.aliasesPinyin.includes(py) || item.tagsPinyin.includes(py))) {
    return { confidence: 0.95, matchedBy: 'pinyin' };
  }

  let best = { confidence: 0, matchedBy: null };

  // 3. token 重叠（Jaccard；交集需含 ≥1 个显著 token 才启用）
  const itemTokens = mergeTokenMaps([item.noteHans, ...item.aliasesHans, ...item.tagsHans]);
  const union = new Set([...query.tokens.keys(), ...itemTokens.keys()]);
  const inter = [];
  for (const t of query.tokens.keys()) {
    if (itemTokens.has(t)) inter.push(t);
  }
  if (union.size > 0 && inter.length > 0) {
    const significant = inter.some((t) => query.tokens.get(t) === true || itemTokens.get(t) === true);
    if (significant) {
      const overlap = inter.length / union.size;
      const c = Math.min(0.85, Math.max(0.6, 0.6 + 0.25 * overlap));
      if (c > best.confidence) best = { confidence: c, matchedBy: 'token_overlap' };
    }
  }

  // 4. 拼音串编辑距离（音近容错）
  for (const t of [item.notePinyin, ...item.aliasesPinyin, ...item.tagsPinyin]) {
    if (!t || !py) continue;
    const maxLen = Math.max(py.length, t.length);
    if (maxLen === 0) continue;
    const sim = 1 - levenshtein(py, t) / maxLen;
    if (sim >= 0.6) {
      const c = Math.min(0.8, Math.max(0.5, 0.5 + 0.3 * sim));
      if (c > best.confidence) best = { confidence: c, matchedBy: 'fuzzy_pinyin' };
    }
  }

  // 5. 汉字串编辑距离（个别字错/丢/多）
  for (const t of [item.noteHans, ...item.aliasesHans, ...item.tagsHans]) {
    if (!t || !hans) continue;
    const maxLen = Math.max(hans.length, t.length);
    if (maxLen === 0) continue;
    const sim = 1 - levenshtein(hans, t) / maxLen;
    if (sim >= 0.6) {
      const c = Math.min(0.7, Math.max(0.5, 0.5 + 0.2 * sim));
      if (c > best.confidence) best = { confidence: c, matchedBy: 'fuzzy_hanzi' };
    }
  }

  return best.confidence > 0 ? best : null;
}

/** 计算单候选与 query 的多信号最优分，返回 {confidence, matchedBy}（无信号返回 null） */
export function scoreCandidate(queryText, item) {
  return scorePrepared(prepareQuery(queryText), prepareItem(item));
}

/**
 * 鲁棒反查：query（可能带 STT 噪声的中文描述）→ 唯一高置信 emojiId 或候选列表。
 * 判定：top≥1 且 top.confidence≥THRESHOLD 且 top-second≥MARGIN → matched=true；
 * 否则 needsClarification=true，绝不擅自选第一名。
 */
export function resolve(query, corpus = [], builtinCorpus = [], { limit = 5 } = {}) {
  const raw = String(query ?? '');
  const truncated = raw.slice(0, MAX_QUERY_LEN);
  const q = prepareQuery(truncated);

  const sources = [];
  for (const c of corpus) {
    if (c) sources.push(prepareItem(c));
  }
  for (const b of builtinCorpus) {
    if (!b) continue;
    // 内置语料：英文名 → note，中文别名 → aliases（与用户语料同一管线）
    sources.push(
      prepareItem({
        emojiId: b.emojiId,
        kind: 'builtin',
        note: b.nameEn ?? b.note,
        aliases: b.aliasesZh ?? b.aliases,
      })
    );
  }

  const candidates = [];
  for (const item of sources) {
    const score = scorePrepared(q, item);
    if (!score) continue;
    candidates.push({
      emojiId: item.emojiId,
      kind: item.kind,
      name: item.note || item.aliases[0] || item.emojiId,
      note: item.note,
      aliases: item.aliases,
      confidence: score.confidence,
      matchedBy: score.matchedBy,
    });
  }

  candidates.sort((a, b) => b.confidence - a.confidence);

  // 同一 emojiId 只保留最高分（防「用户备注 + 内置静态」双条目造成假歧义）
  const seen = new Set();
  const deduped = candidates.filter((c) => {
    if (seen.has(c.emojiId)) return false;
    seen.add(c.emojiId);
    return true;
  });

  const top = deduped[0];
  const second = deduped[1];
  const matched = !!top && top.confidence >= THRESHOLD && (!second || top.confidence - second.confidence >= MARGIN);

  return {
    query: truncated,
    matched,
    emojiId: matched ? top.emojiId : null,
    kind: matched ? top.kind : null,
    confidence: matched ? top.confidence : top ? top.confidence : null,
    source: matched ? top.matchedBy : null,
    matchedBy: matched ? top.matchedBy : null,
    needsClarification: !matched,
    candidates: deduped.slice(0, Math.max(1, Number(limit) || 5)),
  };
}
