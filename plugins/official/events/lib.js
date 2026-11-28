/**
 * events 插件纯函数库（无 api / 无 IO / 无网络）
 * =====================================================================
 * 抽出来只为一件事：让时区口径与 limit 截断这类「一改就影响所有输出」的逻辑
 * 能被 test/events-tz-and-truncation.test.mjs 直接 import 断言（生产同一份代码），
 * 而不是只在插件闭包里靠真实采集才能验证。
 *
 * 插件零依赖契约：本文件不得 import core/、不得读凭据、不得发请求。
 */

// ── naive（无时区标记）时间的「基准偏移」按数据源区分 ─────────────────
//   VRC Search：页面 JSON-LD 里是 `2026-10-03T13:00:00+00:00`，剥掉偏移后是 **UTC** ⇒ 0
//   RLVRC：api.rlvrc.cn 直接给北京时间且不带时区标记
//          （原始 JSON `week:"星期六"` + `time:"2026-10-03 21:00"`，2026-10-03 确为周六；
//            官方 iCal 亦为 DTSTART;TZID=Asia/Shanghai）⇒ +8
//   未知源沿用旧口径按 UTC（不能把两个源一起改成 +8，见防回归测试）。
export function naiveBaseOffsetH(src) {
  const s = String(src || '').trim().toLowerCase();
  return s.includes('rlvrc') ? 8 : 0;
}

// ── 时区判定/解析的公共形态 ───────────────────────────────────────────
//   尾随 Z 必须**锚定**：旧写法 /[zZ]/ 会把含 z 的脏串（如 `2026-10-03 13:00 zzz`）误判成 aware，
//   随后 Date.parse 失败 ⇒ 时间列整列变空（**静默丢时间**，与仓库「禁静默降级」取向相悖）。
const HAS_TZ_RE = /[zZ]$|[+-]\d{2}:?\d{2}$|[+-]\d{4}$/;

/**
 * 宽容解析 naive 串的**前导** `YYYY-MM-DD[T ]HH:MM`（容忍尾部杂物，如 `… 13:00 zzz`），
 * 再按数据源基准偏移还原真实 UTC。只有连前导时间戳都取不到时才返回 NaN。
 */
export function naiveUtcMs(raw, src) {
  const s = String(raw || '').trim().replace(' ', 'T');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!m) return NaN;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`);
  if (isNaN(ms)) return NaN;
  return ms - naiveBaseOffsetH(src) * 3600 * 1000;
}

// ── 数据后处理：双列时区（活动本地时间 + 北京时间）──────────────────
//   naive（无时区）：先按 naiveBaseOffsetH(src) 还原真实 UTC 时刻，再按社团语言判本地偏移；
//   aware（带偏移，如 VRCEve +09:00=JST）：直接用自带偏移；
//   aware 形态但解析失败（坏偏移/尾随杂物）⇒ **回落 naive 分支**，不把整列留空。
export function eventTzInfo(e) {
  const out = { start_local: '', start_bj: '', tz_label: '', tz_offset: 0 };
  const t = e && e.start;
  if (!t) return out;
  const BJ_OFF = 8 * 3600 * 1000;
  try {
    const raw = String(t);
    const s = raw.trim();
    const iso = s.replace(' ', 'T');
    const awareMs = HAS_TZ_RE.test(s) ? Date.parse(iso) : NaN;
    if (!isNaN(awareMs)) {
      // aware: 自带偏移。北京=偏移→UTC再+8；本地=原时区字段
      const oz = iso.match(/[+-](\d{2}):?(\d{2})$/);
      const offH = oz ? (+oz[1] + (+oz[2] / 60)) : 0;
      out.start_local = rawLocal(iso);                    // 本地=原时区字段
      out.start_bj = fmtDtUtc(awareMs + BJ_OFF);          // 北京=UTC+8
      out.tz_offset = offH;
      out.tz_label = tzName(offH, e);
    } else {
      // naive，或 aware 串解析失败 → 按源基准偏移还原（RLVRC 的 naive 是北京时间，不是 UTC）
      const utcMs = naiveUtcMs(raw, e.src);
      if (!isNaN(utcMs)) {
        const offH = localOffsetHs(e);
        out.start_local = fmtDtUtc(utcMs + offH * 3600 * 1000);
        out.start_bj = fmtDtUtc(utcMs + BJ_OFF);
        out.tz_offset = offH;
        out.tz_label = tzName(offH, e);
      }
    }
  } catch (err) {}
  const js = String(t);
  // 用 Google Calendar 权威 timeZone 区分 KST/JST（同偏移 +09:00，但名不同）；默认按偏移
  const tz = String(e.time_zone || '');
  if (tz.includes('Seoul')) { out.tz_label = 'KST'; out.tz_offset = 9; }
  else if (tz.includes('Tokyo')) { out.tz_label = 'JST'; out.tz_offset = 9; }
  else if (js.includes('+09:00') || js.includes('+0900')) { out.tz_label = (String(e.lang) === 'ko') ? 'KST' : 'JST'; out.tz_offset = 9; }
  else if (js.includes('+08:00')) { out.tz_label = '北京时间'; out.tz_offset = 8; }
  else if (js.includes('+00:00') || js.endsWith('Z')) { out.tz_label = 'UTC'; out.tz_offset = 0; }
  return out;
}

// 按社团语言推断「本地时区」偏移（活动举办地的口径，与 naive 基准偏移无关）
export function localOffsetHs(e) {
  const langs = (e.languages || []).join(' ') + ' ' + String(e.lang || '').toLowerCase();
  const dl = langs.toLowerCase();
  if (/日本語|japanese|jpn|ja\b/.test(dl)) return 9;
  if (/korean|ko\b|한국/.test(dl)) return 9;
  if (/chine|zh\b|中文/.test(dl)) return 8;
  if (/russian|rus|ukr/.test(dl)) return 3;
  if (/english|eng|英语|en\b/.test(dl)) return -4;
  return -4; // 默认国际美东
}

export function tzName(offH, e) {
  // JST/KST 同偏移 +09:00，靠 e.lang/time_zone 区分（韩国日历应标 KST）
  if (offH === 9) return (String((e && e.time_zone) || '').includes('Seoul') || String(((e || {}).lang || '')) === 'ko') ? 'KST' : 'JST';
  return { '-4': 'ET', 3: 'MSK', 8: '北京时间' }[offH] || `UTC${offH >= 0 ? '+' : ''}${offH}`;
}

// 按 UTC 字段格式化时间戳(millis)，不依赖服务器本地时区（跨平台约束 §3.6）
export function fmtDtUtc(ms) {
  if (!ms || isNaN(ms)) return '';
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 原样显示 aware ISO 的本地时段（去掉偏移部分，如 2026-08-25T12:00:00+09:00 → 08-25 12:00）
export function rawLocal(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return String(iso).slice(0, 16).replace('T', ' ');
  const [_, y, mo, d, h, mi] = m;
  if (y === '0001') return '';
  return `${mo}-${d} ${h}:${mi}`;
}

// 事件开始时刻 → UTC 纪元毫秒（与 eventTzInfo 同一口径；无法解析返回 NaN）
//   aware 形态但解析失败（坏偏移/尾随杂物）同样回落 naive 分支，避免「有前导时间戳却判成无法解析」。
export function eventStartMs(e) {
  const raw = String((e && e.start) || '').trim();
  if (!raw) return NaN;
  if (HAS_TZ_RE.test(raw)) {
    const ms = Date.parse(raw.replace(' ', 'T'));
    if (Number.isFinite(ms)) return ms;
  }
  const ms2 = naiveUtcMs(raw, e && e.src);
  return Number.isFinite(ms2) ? ms2 : NaN;
}

// ── VRC Search 分类 → 中文名（落库 category 列用 zh）──────────────────
export const CAT_ZH = { music:'音乐',dance:'舞蹈',hangout:'聚会',gaming:'游戏',roleplaying:'角色扮演',performance:'演出',education:'教育' };

// ── HTML 实体/标签清洗（原 index.js 模块级实现，原样迁出供解析器共用）──
export function decodeEntities(s) {
  const map = { amp:'&', lt:'<', gt:'>', quot:'"', '#39':"'", apos:"'", '#x27':"'" };
  return String(s || '').replace(/&(#?\w+);/g, (m, ent) => {
    const k = ent.toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m;
  });
}

export function stripHtml(s) {
  return decodeEntities(String(s || ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/</g, ' ').replace(/>/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// data-starts/data-ends 实测形如 `2026-11-26T00:00:00.000Z`。
// VRC Search 的 naive 口径是 **UTC**（naiveBaseOffsetH=0），故剥成「无 Z 无毫秒」的
// YYYY-MM-DDTHH:MM:SS：留着 Z 会走 eventTzInfo 的 aware 分支，本地时间列语义失真。
function toNaiveUtc(raw) {
  const m = String(raw || '').trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4] || '00'}` : '';
}

/**
 * 解析 VRC Search（search.vrcwwt.com）SSR 页面里的活动卡片。
 *
 * 站点 2026-11 改版后卡片从 `article.list-group-item.result-row-event` 换成
 * `article.event-card`（class 还带 `is-live` 等修饰，故切分串**不能带闭合引号**），
 * 数据改由 data-* 属性承载。旧解析器零匹配；本函数按新结构取字段，
 * 单卡异常 continue，一页坏卡不影响其余卡片。
 *
 * @param {string} page 页面 HTML
 * @param {string} category 目标分类（music/dance/…）
 * @param {string} win 窗口（保留旧签名，解析本身不依赖）
 * @param {string} lang 页面语言标记
 * @returns {Array<object>} 字段与旧实现一致（含 icon_url，落库/前端只认它）
 */
export function parseVrcSearchCards(page, category, win, lang) {
  const cards = String(page || '').split('<article class="event-card').slice(1);
  const out = [];
  for (const card of cards) {
    try {
      const titleM = card.match(/<h3 class="ec-title">([\s\S]*?)<\/h3>/);
      if (!titleM) continue;
      const name = stripHtml(titleM[1]).slice(0, 100);

      // 时间是硬字段：缺失/不可解析 → 整卡跳过（start_iso 是 PK 组成部分）
      const start = toNaiveUtc((card.match(/data-starts="([^"]*)"/) || [])[1]);
      if (!start) continue;
      const end = toNaiveUtc((card.match(/data-ends="([^"]*)"/) || [])[1]);

      // group_id / cal_id 首选 data-result-id="grp_x/cal_y"；形态变了再从 href 兜底
      let group_id = '', cal_id = '';
      const rid = (card.match(/data-result-id="([^"]+)"/) || [])[1] || '';
      for (const part of rid.split('/')) {
        const v = part.trim();
        if (!group_id && /^grp_/.test(v)) group_id = v;
        else if (!cal_id && /^cal_/.test(v)) cal_id = v;
      }
      if (!group_id) {
        const g = card.match(/href="\/groups\/(grp_[^"\/]+)/);
        if (g) group_id = g[1];
      }
      if (!cal_id) {
        const c = card.match(/calendar\/(cal_[^"\/]+)/);
        if (c) cal_id = c[1];
      }

      const hostM = card.match(/<a class="ec-host-name"[^>]*>([\s\S]*?)<\/a>/);
      const group_name = hostM ? stripHtml(hostM[1]).slice(0, 60) : '';

      // 中文页常见整段缺 .ec-lang：必须容忍缺失（[] 而不是抛错）
      const languages = [];
      for (const m of card.matchAll(/<span class="ec-lang"[^>]*>([\s\S]*?)<\/span>/g)) {
        const v = stripHtml(m[1]);
        if (v && !languages.includes(v)) languages.push(v);
      }

      const descM = card.match(/<p class="ec-desc">([\s\S]*?)<\/p>/);
      const desc = descM ? stripHtml(descM[1]).slice(0, 300) : '';
      const iconM = card.match(/<span class="ec-host-icon"[^>]*>[\s\S]*?<img[^>]*?src="([^"]+)"/);

      out.push({
        name,
        start, end,
        category, category_zh: CAT_ZH[category] || category,
        lang, languages: languages.slice(0, 5),
        desc,
        group_id,
        group_name: group_name || group_id || '',
        cal_id,
        icon_url: iconM ? iconM[1] : '',
        src: 'VRC Search',
      });
    } catch (e) { continue; }
  }
  return out;
}

/**
 * limit 截断：窗口内活动上千场时，「按现有顺序 slice(0,limit)」会把未来几天整段砍掉
 * （排序主键是群组人数，与时间无关）。故超限时**优先保留未开始/刚开头的活动**，
 * 不足额再用最近的过去事件补齐。
 *
 * @param {Array} events 已 enrich 的事件（顺序即展示顺序）
 * @param {number} limit 返回条数上限
 * @param {number} nowMs 当前时刻（注入以便测试；默认 Date.now()）
 * @returns {{picked:Array, truncated:boolean, dropped:number}}
 *   不超限 → 原样返回（顺序不变）；超限 → 未来/进行中优先（保持现有顺序），
 *   再用过去事件按 start 降序（最近的先）补齐。start 缺失/不可解析视作「未开始」保留。
 */
export function selectWithinLimit(events, limit, nowMs = Date.now()) {
  const list = Array.isArray(events) ? events : [];
  const cap = Math.max(1, Math.floor(Number(limit)) || 1);
  if (list.length <= cap) {
    return { picked: list.slice(), truncated: false, dropped: 0 };
  }
  const JUST_STARTED_GRACE_MS = 30 * 60 * 1000;  // 开始后 30 分钟内仍算「进行中」，不当过去事件挤掉
  const upcoming = [];
  const past = [];
  for (const e of list) {
    const ms = eventStartMs(e);
    if (!Number.isFinite(ms) || ms + JUST_STARTED_GRACE_MS > nowMs) upcoming.push(e);
    else past.push(e);
  }
  const picked = upcoming.slice(0, cap);
  if (picked.length < cap && past.length) {
    const sortedPast = past
      .map(e => ({ e, ms: eventStartMs(e) }))
      .sort((a, b) => b.ms - a.ms)               // 降序：最近的过去事件排前面
      .slice(0, cap - picked.length)
      .map(x => x.e);
    picked.push(...sortedPast);
  }
  const kept = new Set(picked);
  const dropped = list.filter(e => !kept.has(e)).length;
  return { picked, truncated: picked.length < list.length, dropped };
}
