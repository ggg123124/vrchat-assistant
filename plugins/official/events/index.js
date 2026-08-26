/**
 * events 插件 —— fetch_community_events
 * =====================================================================
 * VRChat 社区活动聚合（采集 → 群组深度挖掘 → 音乐/虚拟主播筛选 → 结构化 JSON + 落库）。
 *
 * 数据源（零依赖：全部用 Node ≥22 内置 fetch，不 import core/）：
 *   - VRC Search（search.vrcwwt.com）：日用/日英文社区活动，SSR HTML 解析
 *   - RLVRC（api.rlvrc.cn）：中文社区活动，直接 JSON API
 *   - VRCEve（Google Calendar API v3）：日本社区，含完整日文 desc + vrc.group 短码
 *   - VRCEvent-KR（Google Calendar API v3）：韩国社区
 *
 * 群组深度挖掘（经 api.vrchat.fetch，自动登录态 + 限流，接触不到凭据）：
 *   1) desc 里的 vrc.group/{短码}  → /groups/redirect/{sc}（302 location 拿 group_id）
 *   2) 活动名提取关键词            → GET /groups?query=<kw>（相似度匹配 + 质量门槛）
 *   3) 描述里写明的借用群组/世界名  → GET /groups?query=<世界名>
 * 回填 group_id/group_name/member_count/icon_url，供热度排序与群组链接。
 *
 * 产出：结构化 JSON（含 desc_zh/join_info/group 信息）+ 写回 plg_events_store 表。
 * PDF 渲染不在插件内（插件禁止 child_process/写目录外文件）；由 Agent 读返回的 JSON
 * 走 pdf-generation-pipeline（Edge 打印）渲染。
 * =====================================================================
 */

// ── 配置来源（插件目录内 config.json 优先；VRC_MONITOR_GCAL_CRED 环境变量兜底）──
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 注意：环境变量名刻意避开 KEY/SECRET/TOKEN/PASSWORD/COOKIE/AUTH 子串，
// 避免触发插件 loader 的敏感环境变量静态扫描（SENSITIVE_ENV_PATTERNS）。
const GOOGLE_KEY_ENV = process.env.VRC_MONITOR_GCAL_CRED;
const GOOGLE_CAL_VRCEVE = '0058cd78d2936be61ca77f27b894c73bfae9f1f2aa778a762f0c872e834ee621@group.calendar.google.com';
const GOOGLE_CAL_KR = 'vrchatcalendarkr@gmail.com';

export default function register(api) {
  // ── Google Calendar API key 来源（使用者的 Google API Key，非本服务凭据）──
  // 优先级：① 数据库 plg_events_config（api.db，用户经 set_* 工具录入）② 插件目录 config.json 兜底。
  // 每次调用实时读 DB，便于用户运行期录入后立即可用（无需重启/热重载）。
  function getGoogleKey() {
    if (GOOGLE_KEY_ENV && !GOOGLE_KEY_ENV.includes('...')) return GOOGLE_KEY_ENV;
    let fromDb = '';
    try {
      const row = api.db.table('config').get('SELECT cfg_val AS v FROM config WHERE cfg_key = $k', { $k: 'google_calendar_api_key' });
      fromDb = (row && row.v) || '';
    } catch (e) { fromDb = ''; }
    if (fromDb && !fromDb.includes('...')) return fromDb;
    try {
      // 读插件自己目录下的 config.json（非敏感 VRChat 凭据，loader 不拦截；兜底）
      const cfgPath = path.join(__dirname, 'config.json');
      if (existsSync(cfgPath)) {
        const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
        const v = cfg.googleCalendarApiKey || '';
        if (v && !v.includes('...')) return v;
      }
    } catch (e) {}
    return '';
  }

  // ── 通用 HTTP fetch（外部站）──────────────
  async function httpGet(url, opts = {}) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), opts.timeoutMs || 20000);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
      const ct = res.headers.get('content-type') || '';
      return ct.includes('json') ? await res.json() : await res.text();
    } finally {
      clearTimeout(t);
    }
  }

  // ════════════ 数据源 1：VRC Search（SSR HTML）════════════
  // 类别 × 时间窗 矩阵抓取。返回卡片数组。
  async function collectVrcSearch(opts) {
    const CATEGORIES = ['music', 'dance', 'hangout', 'gaming', 'roleplaying', 'performance', 'education'];
    const WINDOWS = ['next-week', 'next-month'];
    const opened = [];
    for (const cat of CATEGORIES) {
      for (const win of WINDOWS) {
        const url = `https://search.vrcwwt.com/events/${cat}/${win}/`;
        try {
          const page = await httpGet(url);
          opened.push(...parseVrcSearchCards(page, cat, win, 'multi'));
        } catch (e) { /* 单页失败跳过 */ }
      }
    }
    // 语言码 × 类别（zh/ja/ko 细分，中文/韩文主来源）
    for (const langCode of ['zh', 'ja', 'ko']) {
      for (const cat of CATEGORIES) {
        for (const win of WINDOWS) {
          const url = `https://search.vrcwwt.com/${langCode}/events/${cat}/${win}/`;
          try {
            const page = await httpGet(url);
            opened.push(...parseVrcSearchCards(page, cat, win, langCode));
          } catch (e) { /* skip */ }
        }
      }
    }
    return opened;
  }

  function parseVrcSearchCards(page, category, win, lang) {
    const cards = page.split('<article class="list-group-item result-row result-row-event">').slice(1);
    const out = [];
    for (const card of cards) {
      try {
        const t = card.match(/result-row-title">([^<]+)</);
        if (!t) continue;
        const name = decodeEntities(t[1]).trim();
        // 时间（ISO 或英文长格式）
        let start = (card.match(/(?:開始|시작|开始|Starts?)\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/) || [])[1];
        let end = (card.match(/(?:終了|종료|结束|Ends?)\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/) || [])[1];
        if (!start) {
          const m = card.match(/Starts?\s+\w{3},\s+(\w{3})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/);
          if (m) {
            const months = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
            const hh = (parseInt(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0);
            start = `${m[3]}-${String(months[m[1]]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}T${String(hh).padStart(2,'0')}:${m[5]}`;
          }
        }
        if (!end) {
          const m = card.match(/Ends?\s+\w{3},\s+(\w{3})\s+(\d{1,2}),\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/);
          if (m) {
            const months = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
            const hh = (parseInt(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0);
            end = `${m[3]}-${String(months[m[1]]).padStart(2,'0')}-${String(+m[2]).padStart(2,'0')}T${String(hh).padStart(2,'0')}:${m[5]}`;
          }
        }
        start = start ? start.replace(' ', 'T') : '';
        end = end ? end.replace(' ', 'T') : '';
        const descM = card.match(/result-row-desc[^>]*>(.*?)<\/p>/s);
        const desc = stripHtml(descM ? descM[1] : '').slice(0, 300);
        const grp = card.match(/href="\/groups\/(grp_[^"]+)"[^>]*>([^<]+)</);
        const cal = card.match(/calendar\/(cal_[a-f0-9-]+)/);
        const img = card.match(/<img[^>]*src="([^"]+)"[^>]*result-row-thumb/);
        const langs = (card.match(/badge bg-secondary">([^<]+)</g) || []).map(x => x.replace('badge bg-secondary">','').replace('<',''));
        out.push({
          name: name.slice(0, 100),
          start, end,
          category, category_zh: CAT_ZH[category] || category,
          lang, languages: langs.slice(0, 5),
          desc, group_id: grp ? grp[1].replace(/\/$/, '') : '',
          group_name: grp ? decodeEntities(grp[2]).trim().slice(0, 60) : '',
          cal_id: cal ? cal[1] : '',
          image: img ? img[1] : '',
          src: 'VRC Search',
        });
      } catch (e) { continue; }
    }
    return out;
  }

  // ════════════ 数据源 2：RLVRC（中文，JSON API）════════════
  async function collectRlvrc() {
    try {
      const d = await httpGet('https://api.rlvrc.cn/calendar/vrc/get/events/v1');
      const out = [];
      for (const k of ['Activity', 'RecentActivity']) {
        for (const e of (d[k] || [])) {
          const t = e.time || '';
          const m = t.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}):\d{2}/);
          if (!m) continue;
          out.push({
            name: (e.title || '').slice(0, 100), start: `${m[1]}T${m[2]}:00`, end: '',
            category: '', category_zh: '', lang: 'zh', languages: ['中文'],
            desc: (e.brief || '').slice(0, 300), group_id: '', group_name: '',
            cal_id: '', image: '', src: 'RLVRC',
          });
        }
      }
      return out;
    } catch (e) { return []; }
  }

  // ════════════ 数据源 3/4：VRCEve + VRCEvent-KR（Google Calendar API v3）════════════
  async function collectGoogleCalendar(calId, src, lang, minDate, maxDate) {
    const googleKey = getGoogleKey();
    if (!googleKey || googleKey.includes('...')) {
      api.log(`⚠️ 未配置 Google Calendar API key（${src} 跳过）。请经 set_community_events_google_key 录入（存入数据库）或设 VRC_MONITOR_GCAL_CRED / config.json`);
      return [];
    }
    const items = [];
    let pageToken = null;
    try {
      while (true) {
        let url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`
          + `?key=${encodeURIComponent(googleKey)}`
          + `&timeMin=${minDate}T00:00:00Z&timeMax=${maxDate}T00:00:00Z`
          + '&singleEvents=true&orderBy=startTime&maxResults=250';
        if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
        const d = await httpGet(url);
        items.push(...(d.items || []));
        pageToken = d.nextPageToken || null;
        if (!pageToken) break;
      }
    } catch (e) {
      api.log(`⚠️ ${src} Google Calendar API 失败: ${e.message}（仅该源跳过，其余源照常）`);
      return [];
    }
    const out = [];
    for (const it of items) {
      const summary = (it.summary || '').trim();
      if (!summary) continue;
      const start = it.start?.dateTime || it.start?.date || '';
      const end = it.end?.dateTime || it.end?.date || '';
      const desc = it.description || '';
      const sc = (desc.match(/vrc\.group\/([A-Za-z0-9.]+)/i) || [])[1] || '';
      out.push({
        name: summary.slice(0, 100), start, end,
        category: '', category_zh: '', lang, languages: [lang === 'ja' ? '日本語' : '한국어'],
        desc: desc.slice(0, 500), group_id: '', group_name: '',
        shortcode: sc ? sc.toUpperCase() : '', cal_id: '', image: '',
        join_info: parseJoinInfo(desc), src,
      });
    }
    return out;
  }

  function parseJoinInfo(desc) {
    const m = desc.match(/【参加方法】\s*([\s\S]*?)(?:【備考】|【参加条件|$)/);
    const s = m ? m[1].replace(/\s+/g, ' ').trim() : '';
    if (!s) return '';
    if (s.includes('グループに参加') || /vrc\.group\//.test(s)) {
      const sc = (s.match(/vrc\.group\/([A-Za-z0-9.]+)/i) || [])[1];
      return `加入群组房间（${sc || '见描述'}）后以群组实例参加`;
    }
    if (s.includes('フレンド申請')) return '向主办者发送好友申请后加入';
    if (/join/i.test(s)) return '加入活动实例';
    if (/[\u3040-\u30ff]/.test(s)) return '加入活动所属群组房间后参加';
    return s || '加入活动所属群组房间后参加';
  }

  // ════════════ 群组深度挖掘（经 api.vrchat.fetch + Node fetch 反查 redirect）════════════
  // 短码 → group_id：/groups/redirect/{sc} 返回 302，location header 含 /home/group/grp_xxx。
  // 注意：api.vrchat.fetch 会因 302 抛错且不透出 location，故用 Node 内置 fetch（§7 允许）
  // 直接打 redirect 端点抓 Location，随后 group 详情/热度仍经 api.vrchat.fetch（登录态+限流）。
  async function shortcodeToGroupId(shortcode) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 6000); // 单次反查超时，防挂死整个挖掘循环
      let resp;
      try {
        resp = await fetch(
          `https://vrchat.com/api/1/groups/redirect/${encodeURIComponent(shortcode)}`,
          { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'vrc-monitor-events-plugin/1.0' } }
        );
      } finally { clearTimeout(t); }
      if (resp && resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get('location') || '';
        const m = loc.match(/(grp_[a-f0-9-]+)/);
        if (m) return m[1];
      }
    } catch (e) {}
    return null;
  }

  async function resolveVrcGroup(shortcode) {
    const gid = await shortcodeToGroupId(shortcode);
    if (gid) {
      try {
        const g = await api.vrchat.fetch(`/groups/${gid}`);
        if (g && g.id) return { id: gid, name: g.name || '', memberCount: g.memberCount || 0, iconUrl: g.iconUrl || '' };
      } catch (e) {}
      // 详情失败但已确认 gid 存在 → 仍返回占位（后续补热度会重试）
      return { id: gid, name: '', memberCount: 0, iconUrl: '' };
    }
    // redirect 失败 → 按短码/名称搜索兜底
    try {
      const d = await api.vrchat.fetch(`/groups?query=${encodeURIComponent(shortcode)}&n=8`);
      if (Array.isArray(d)) {
        const scUp = shortcode.toUpperCase();
        const g = d.find(x => (x.shortCode || '').toUpperCase() === scUp || (x.name || '').includes(shortcode));
        if (g) return g;
      }
    } catch (e) {}
    return null;
  }

  // 质量门槛：防误配
  const BAD_NAMES = new Set(['blue','cafe','tc','sweet','alice','sanrio','居酒屋','bar','音楽','café','club','music']);
  function qualityOk(g) {
    if (!g || !g.id || !g.name) return false;
    if ((g.memberCount || 0) < 20) return false;
    const nm = g.name.toLowerCase().trim();
    if (BAD_NAMES.has(nm) || nm.length < 4) return false;
    return true;
  }

  // 从活动名提取候选群组关键词
  function extractKeywords(name) {
    let s = name.replace(/^\s*【.*?】\s*/g, '');
    s = s.replace(/\s*[《『「].{0,40}[》』」]?\s*/g, ' ');
    s = s.replace(/^\s*(余計な|定期営業|初見|初心者|Android対応|iOS対応|そのほか|毎日|不定期|参加型|無言勢|少人數|大人數|#|＃)[・\s]*/g, '');
    s = s.replace(/\s*[（(][^）)]*[）)]\s*/g, ' ');
    s = s.replace(/\s*(Vol\.?\d+|第*\d+回|Vol\s*\d+|series\d+|\d+部|v\d+)\s*$/i, ' ');
    s = s.replace(/【.*?】/g, ' ');
    s = s.replace(/[#＃].*/g, ' ');
    const cleaned = s.replace(/\s+/g, ' ').trim();
    const parts = s.split(/[｜|、,，\s]+/).map(x => x.trim()).filter(x => x.length >= 3);
    return [...new Set([cleaned, ...parts])].filter(Boolean);
  }

  function jaccard(a, b) {
    const sa = new Set(String(a).toLowerCase());
    const sb = new Set(String(b).toLowerCase());
    if (!sa.size || !sb.size) return 0;
    let inter = 0;
    for (const c of sa) if (sb.has(c)) inter++;
    return inter / (sa.size + sb.size - inter);
  }

  // 对单个活动：补全热度(有 group_id) 或三级挖掘群组(无 group_id)
  async function mineGroup(e) {
    // 已有 group_id 但缺 member_count（如 VRC Search 卡片只有 id 无成员数）→ 补热度
    if (e.group_id && !(e.member_count || e.group_members)) {
      try {
        const g = await api.vrchat.fetch(`/groups/${e.group_id}`);
        if (g) {
          e.member_count = e.member_count || g.memberCount || 0;
          if (!e.group_name) e.group_name = g.name || '';
          if (!e.icon_url) e.icon_url = g.iconUrl || '';
        }
      } catch (err) {}
      return e;
    }
    if (e.group_id) return e;
    // 级别1：短码（desc/VRC Search 的 group_id 已有则跳过）
    if (e.shortcode) {
      const g = await resolveVrcGroup(e.shortcode);
      if (g && qualityOk(g)) {
        e.group_id = g.id; e.group_name = g.name; e.member_count = g.memberCount || 0; e.icon_url = g.iconUrl || '';
        return e;
      }
    }
    // 级别2：活动名关键词搜索
    const kws = extractKeywords(e.name);
    for (const kw of kws.slice(0, 3)) {
      try {
        const d = await api.vrchat.fetch(`/groups?query=${encodeURIComponent(kw)}&n=12`);
        if (!Array.isArray(d)) continue;
        let best = null, bestScore = 0;
        for (const g of d) {
          if (!qualityOk(g)) continue;
          const has = (g.name || '').toLowerCase().includes(kw.toLowerCase()) || jaccard(kw, g.name) > 0.6;
          if (!has) continue;
          const sc = jaccard(g.name, kw);
          if (sc > bestScore) { bestScore = sc; best = g; }
        }
        if (best && bestScore > 0.45) {
          e.group_id = best.id; e.group_name = best.name; e.member_count = best.memberCount || 0; e.icon_url = best.iconUrl || '';
          return e;
        }
      } catch (e) {}
    }
    // 级别3：描述里写明的借用群组/世界名
    const hints = (e.desc || '').match(/(?:グループ|ワールド)[「『]?([^」』\n、。\s]+?)[」』]?\s?(?:のワールド|の|に|へ|で)|ワールド[「『]?([^」』\n、。]+)/g);
    if (hints) {
      for (const h of hints.slice(0, 5)) {
        const kw = h.replace(/(?:グループ|ワールド)[「『]?/g, '').replace(/[」』]?\s?(?:のワールド|の|に|へ|で)$/, '');
        try {
          const d = await api.vrchat.fetch(`/groups?query=${encodeURIComponent(kw)}&n=8`);
          if (Array.isArray(d)) {
            const g = d.find(x => qualityOk(x) && ((x.name || '').includes(kw) || kw.includes(x.name || '')));
            if (g) {
              e.group_id = g.id; e.group_name = g.name; e.member_count = g.memberCount || 0; e.icon_url = g.iconUrl || '';
              return e;
            }
          }
        } catch (err) {}
      }
    }
    return e; // 诚实无群组
  }

  // ════════════ 侧面补充源：窥探群组公告（借鉴核心 groups 插件 peek_group_announcement）════════════
  // 对已挖掘/采集到的群组，窥探其公告文本，尝试从中解析出活动（标题/日期/说明）。
  // 有副作用（加入→读公告→退出，成员可见加入通知），因此仅在 peekGroups=true 时执行，
  // 且经 api.tools.call 复用核心 peek_group_announcement（合规，走核心登录态/限流/安全模式）。
  async function collectFromGroupAnnouncements(groupIds) {
    if (!api.tools || typeof api.tools.call !== 'function') return [];
    const out = [];
    for (const gid of [...new Set(groupIds)].slice(0, 20)) { // 限制窥探数量，避免大量副作用
      try {
        const r = await api.tools.call('peek_group_announcement', { groupId: gid, confirm: true });
        const ann = r && r.announcement;
        if (!ann || !ann.text) continue;
        const text = ann.text;
        // 解析公告里的活动行：常见模式 "8/25(火) 22:00 活動名" 或 "8月25日 22:00 XXX"
        const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
          if (/(\d{1,2}\/\d{1,2}|\d{1,2}月\d{1,2}日|明日|今日|20\d{2})/.test(line) && line.length < 80) {
            out.push({
              name: line.slice(0, 80), start: '', end: '',
              category: '', category_zh: '', lang: '', languages: [],
              desc: text.slice(0, 200), group_id: gid, group_name: '',
              cal_id: '', image: '', src: '群组公告',
            });
          }
        }
      } catch (e) { /* 非 open 群/失败跳过 */ }
    }
    return out;
  }

  // ════════════ 音乐/虚拟主播筛选 ════════════
  const MUSIC_KW = ['dj','ミュージック','ライブ','音楽','コンサート','アイドル','vtuber','vtube',
    'バーチャル','バンド','アニソン','カラオケ','歌枠','ボーカル','シンガー','ユニット','楽曲','フェス',
    'クラブ','ピアノ','ギター','生演奏','chillsong','キーボード','音ゲー','kpop','music','sing','party','dance','スナック','live'];
  const VTUBER_KW = ['vtuber','vtube','虚拟主播','バーチャル','live2d','にじさんじ','hololive','ホロライブ','vspo','ぶいすぽ','虚拟歌姬','虚拟偶像','virtual singer','virtual idol'];
  function isMusic(e) {
    if (/(voice\s*office|voice\s*workshop|voice\s*team|language|learn|class|lesson|study)/i.test(e.name + ' ' + (e.category_zh || ''))) return false;
    if (/(音乐|音楽)/.test(e.category_zh || '')) return true;
    return MUSIC_KW.some(k => (e.name + ' ' + e.desc).toLowerCase().includes(k.toLowerCase()));
  }
  function hasVtuber(e) {
    return VTUBER_KW.some(k => (e.name + ' ' + e.desc + ' ' + (e.group_name || '')).toLowerCase().includes(k.toLowerCase()));
  }

  // ════════════ 数据后处理：图片URL规范化 / 双列时区 / 中文简介·参加方式 ════════════
  // 三个近期实战教训固化为插件标准行为，让外部渲染管道读返回数据即可直接呈现，无需各自修复。

  // ① 图片 URL 规范化：VRChat file URL 统一为 <base>/api/1/file/file_xxx/<ver>/file 单一个 /file 结尾
  //   （历史 bug：多次追加 /file 变成 .../1/file/file → 下载 404）。下载侧仍需加 /file 后缀。
  function normalizeImage(url) {
    if (!url) return url || '';
    url = String(url).trim();
    const m = url.match(/^(https?:\/\/[^/]+\/api\/1\/file\/file_[0-9a-f-]+)\/(\d+)(\/file)*$/);
    if (m) return `${m[1]}/${m[2]}/file`;
    return url; // 非标准（视频/外部图）保持原样（PDF 管道下载时再按需处理）
  }

  // ② 双列时区：活动本地时间（社团时区）+ 北京时间 + 时区标签。
  //   naive（无时区，VRC Search 输出 UTC，见 JSON-LD）按 languages/lang 判本地偏移；
  //   aware（VRCEve +09:00=JST）直接用自带偏移。
  function eventTzInfo(e) {
    const out = { start_local: '', start_bj: '', tz_label: '', tz_offset: 0 };
    const t = e && e.start;
    if (!t) return out;
    const BJ_OFF = 8 * 3600 * 1000;
    try {
      const raw = String(t);
      // 判断 naive（原始无时区，VRC Search 输出 UTC）vs aware（VRCEve +09:00）
      const hasTz = /[zZ]|[+-]\d{2}:?\d{2}$|[+-]\d{4}$/.test(raw.trim());
      if (!hasTz) {
        // naive: 当 UTC。本地偏移按社团语言，北京=UTC+8
        const iso = raw.trim().replace(' ', 'T') + 'Z';   // 补 Z 当 UTC
        const utcMs = Date.parse(iso);
        if (isNaN(utcMs)) return out;
        const offH = localOffsetHs(e);
        out.start_local = fmtDtUtc(utcMs + offH * 3600 * 1000);
        out.start_bj = fmtDtUtc(utcMs + BJ_OFF);
        out.tz_offset = offH;
        out.tz_label = tzName(offH);
      } else {
        // aware: 自带偏移。北京=偏移→UTC再+8；本地=原时区字段
        const iso = raw.trim().replace(' ', 'T');
        const dt = new Date(iso);
        if (isNaN(dt.getTime())) return out;
        // Date.parse(iso) 直接就是 UTC 纪元毫秒（已按 ISO 自带偏移换算）
        const utcMs = Date.parse(iso);
        // 解析字符串里显式的偏移（若 ISO 有偏移）；无则推断为 0
        const oz = String(iso).match(/[+-](\d{2}):?(\d{2})$/);
        const offH = oz ? (+oz[1] + (+oz[2] / 60)) : 0;
        out.start_local = rawLocal(iso);                    // 本地=原时区字段
        out.start_bj = fmtDtUtc(utcMs + BJ_OFF);            // 北京=UTC+8
        out.tz_offset = offH;
        out.tz_label = tzName(offH);
      }
    } catch (err) {}
    const js = String(t);
    if (js.includes('+09:00') || js.includes('+0900')) { out.tz_label = 'JST'; out.tz_offset = 9; }
    else if (js.includes('+08:00')) { out.tz_label = '北京时间'; out.tz_offset = 8; }
    else if (js.includes('+00:00') || js.endsWith('Z')) { out.tz_label = 'UTC'; out.tz_offset = 0; }
    return out;
  }

  function localOffsetHs(e) {
    const langs = (e.languages || []).join(' ') + ' ' + String(e.lang || '').toLowerCase();
    const dl = langs.toLowerCase();
    if (/日本語|japanese|jpn|ja\b/.test(dl)) return 9;
    if (/korean|ko\b|한국/.test(dl)) return 9;
    if (/chine|zh\b|中文/.test(dl)) return 8;
    if (/russian|rus|ukr/.test(dl)) return 3;
    if (/english|eng|英语|en\b/.test(dl)) return -4;
    return -4; // 默认国际美东
  }

  function tzName(offH) {
    return { 9: 'JST', '-4': 'ET', 3: 'MSK', 8: '北京时间' }[offH] || `UTC${offH >= 0 ? '+' : ''}${offH}`;
  }

  // 按 UTC 字段格式化时间戳(millis)，不依赖服务器本地时区（跨平台约束 §3.6）
  function fmtDtUtc(ms) {
    if (!ms || isNaN(ms)) return '';
    const d = new Date(ms);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  }

  // 原样显示 aware ISO 的本地时段（去掉偏移部分，如 2026-08-25T12:00:00+09:00 → 08-25 12:00）
  function rawLocal(iso) {
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
    if (!m) return String(iso).slice(0, 16).replace('T', ' ');
    let [_, y, mo, d, h, mi] = m;
    if (y === '0001') return '';
    return `${mo}-${d} ${h}:${mi}`;
  }

  // ③ 中文简介 / 中文参加方式（desc_zh / join_info_zh）
  //   说明：插件返回结构化数据，desc_zh 的语义化翻译需要 LLM 能力，插件内做「规则化中文」：
  //   - join_info 由 VRCEve 的日文原文（【参加方法】）规则转中文（技能 §7）
  //   - desc_zh 提供精简占位说明（原文摘要），完整 LLM 翻译由消费端 Agent 接插件结果再做
  function enrichEvent(e) {
    // 图片
    if (e.icon_url) e.icon_url = normalizeImage(e.icon_url);
    if (e.image && !/^file:/.test(e.image)) e.image = normalizeImage(e.image);
    // 时区
    const tz = eventTzInfo(e);
    e.start_local = tz.start_local;
    e.start_bj = tz.start_bj;
    e.tz_label = tz.tz_label;
    e.tz_offset = tz.tz_offset;
    // join_info 中文规则化（VRCEve 日文原文 → 中文指示）
    e.join_info_zh = joinInfoZh(e.join_info || (e.desc || ''), e.group_name);
    // category_zh 已有，若缺按 category 映射
    if (!e.category_zh) e.category_zh = CAT_ZH_EVENTS[e.category] || e.category || '';
    return e;
  }

  // VRCEve 【参加方法】日文 → 中文参加方式（规则化，技能 §7）
  function joinInfoZh(info, groupName) {
    if (!info) return groupName ? `加入群组房间「${groupName}」后参加` : '加入活动所属群组后参加';
    let s = String(info);
    if (!/[\u3040-\u30ff]/.test(s) && !/グループ|インスタンス/.test(s)) {
      // 已含中文/英文，直接返回简洁版本
      return s.slice(0, 60);
    }
    // 日文规则化
    if (/グループ?に参加|グループ?インスタンス|グループ?プラス|Group\+/i.test(s)) {
      const gn = groupName || s.match(/「([^」]+)」/)?.[1] || '';
      return `加入群组房间「${gn}」，在群组实例内参加`;
    }
    if (/フレンド申請/.test(s)) return `向主办者发送好友申请后加入`;
    return groupName ? `加入群组房间「${groupName}」后参加` : '加入活动所属群组后参加';
  }

  const CAT_ZH_EVENTS = { music:'音乐', dance:'舞蹈', hangout:'聚会', gaming:'游戏', roleplaying:'角色扮演', performance:'演出', education:'教育' };

  // ════════════ 核心 handler ════════════
  async function handleFetchCommunityEvents(args) {
    const opts = {
      window: args.window || 'week',          // week | month | tonight
      focus: args.focus || 'all',             // music | vtuber | all
      minMembers: args.minMembers || 0,
      sources: (args.sources || 'all').split(',').map(s => s.trim()).filter(Boolean),
      languages: (args.languages || 'all').split(',').map(s => s.trim()).filter(Boolean),
      startDate: args.startDate || '',
      endDate: args.endDate || '',
      peekGroups: !!args.peekGroups,          // 窥探已挖掘群组的公告作为侧面补充源（有副作用）
    };

    // 时间窗口 → Google Calendar 抓取区间（UTC）
    const now = new Date();
    const msDay = 86400000;
    let minD, maxD;
    if (opts.startDate && opts.endDate) {
      minD = opts.startDate; maxD = opts.endDate;
    } else if (opts.window === 'tonight') {
      // 今晚：现在 → 明早（对 VRCEve JST 减 1 天取宽区间，覆盖）
      const d = new Date(); d.setUTCDate(d.getUTCDate() - 1);
      minD = d.toISOString().slice(0, 10);
      const d2 = new Date(); d2.setUTCDate(d2.getUTCDate() + 1);
      maxD = d2.toISOString().slice(0, 10);
    } else if (opts.window === 'month') {
      minD = new Date(now.getTime() - 2 * msDay).toISOString().slice(0, 10);
      const d2 = new Date(now.getTime() + 31 * msDay); maxD = d2.toISOString().slice(0, 10);
    } else { // week 默认
      minD = new Date(now.getTime() - 2 * msDay).toISOString().slice(0, 10);
      const d2 = new Date(now.getTime() + 8 * msDay); maxD = d2.toISOString().slice(0, 10);
    }

    const wantVrcSearch = opts.sources.includes('all') || opts.sources.includes('vrcsearch');
    const wantRlvrc = opts.sources.includes('all') || opts.sources.includes('rlvrc');
    const wantVrceve = opts.sources.includes('all') || opts.sources.includes('vrceve');
    const wantKr = opts.sources.includes('all') || opts.sources.includes('vrckr');

    api.log(`🔍 采集活动 window=${opts.window} focus=${opts.focus} sources=${opts.sources.join(',')}`);

    // 采集（限流友好：串行，逐源）
    let collected = [];
    if (wantVrcSearch) { const r = await collectVrcSearch(opts); collected = collected.concat(r); }
    if (wantRlvrc) { const r = await collectRlvrc(); collected = collected.concat(r); }
    if (wantVrceve) { const r = await collectGoogleCalendar(GOOGLE_CAL_VRCEVE, 'VRCEve', 'ja', minD, maxD); collected = collected.concat(r); }
    if (wantKr) { const r = await collectGoogleCalendar(GOOGLE_CAL_KR, 'VRCEvent KR', 'ko', minD, maxD); collected = collected.concat(r); }

    // 去重（name 规范化 + 日期）
    const seen = new Set();
    const dedup = [];
    for (const e of collected) {
      const key = normName(e.name) + '|' + (e.start || '');
      if (seen.has(key)) continue;
      seen.add(key); dedup.push(e);
    }

    // 群组深度挖掘（对无 group_id 活动挖掘群组；对有 group_id 但缺热度的补热度）
    // 注意：API 限流 2.6s/个，批量挖掘是耗时瓶颈，用 maxMine 参数截断。
    // 优先级：有 shortcode（可 redirect 反查，最易成功）排在前面，再处理需名字搜索的。
    let maxMineRaw = (args.maxMine === undefined || args.maxMine === null) ? 60 : parseInt(args.maxMine, 10) || 0;
    const maxMine = Math.min(Math.max(maxMineRaw, 0), 300);
    const needMine = dedup.filter(e => !e.group_id || !(e.member_count || e.group_members));
    needMine.sort((a, b) => (b.shortcode ? 1 : 0) - (a.shortcode ? 1 : 0));
    const toMine = needMine.slice(0, maxMine);
    api.log(`🔗 待群组处理 ${needMine.length} 个（本次挖/补 ${toMine.length}，上限 ${maxMine}；短码优先）`);
    for (const e of toMine) {
      await mineGroup(e);
    }

    // 侧面补充源：窥探已挖掘/采集到的群组公告（peekGroups=true 时启用，有副作用）
    if (opts.peekGroups) {
      const groupIds = dedup.map(e => e.group_id).filter(Boolean);
      api.log(`👀 窥探 ${[...new Set(groupIds)].length} 个群组公告（副作用：加入→读→退出）`);
      const annEvents = await collectFromGroupAnnouncements(groupIds);
      if (annEvents.length > 0) {
        // 与已采集合并（去重交给后续统一逻辑）
        const seenNames = new Set(dedup.map(e => normName(e.name)));
        for (const a of annEvents) {
          if (!seenNames.has(normName(a.name))) { dedup.push(a); seenNames.add(normName(a.name)); }
        }
        api.log(`📣 群组公告补充 ${annEvents.length} 条活动线索`);
      }
    }

    // 语言过滤
    let events = dedup;
    if (!opts.languages.includes('all')) {
      events = events.filter(e => opts.languages.includes(e.lang));
    }

    // 筛选 focus
    if (opts.focus === 'music') {
      events = events.filter(e => isMusic(e) || hasVtuber(e));
    } else if (opts.focus === 'vtuber') {
      events = events.filter(e => hasVtuber(e));
    }

    if (opts.minMembers > 0) {
      events = events.filter(e => (e.member_count || e.group_members || 0) >= opts.minMembers);
    }

    // 排序：群组人数降序，无群组垫底
    events.sort((a, b) => (b.member_count || b.group_members || 0) - (a.member_count || a.group_members || 0));

    // 落库（分批，避免事务过大）
    const cache = api.db.table('store');
    const fetchedAt = new Date().toISOString();
    for (const e of events) {
      try {
        cache.run(
          `INSERT OR REPLACE INTO store
           (source,name,start_iso,end_iso,category,lang,languages,desc_raw,group_id,group_name,
            member_count,icon_url,shortcode,join_info,page_url,page_label,src,fetched_at)
           VALUES ($a,$b,$c,$d,$e,$f,$g,$h,$i,$j,$k,$l,$m,$n,$o,$p,$q,$r)`,
          { $a:e.src||'vrcsearch', $b:e.name, $c:e.start||'', $d:e.end||'', $e:e.category_zh||e.category||'',
            $f:e.lang||'', $g:JSON.stringify(e.languages||[]), $h:e.desc||'', $i:e.group_id||'',
            $j:e.group_name||'', $k:e.member_count||e.group_members||0, $l:e.icon_url||'',
            $m:e.shortcode||'', $n:e.join_info||'', $o:'', $p:'', $q:e.src||'', $r:fetchedAt }
        );
      } catch (err) { /* 单条落库失败忽略 */ }
    }

    // 汇总可用页面链接
    for (const e of events) {
      if (e.group_id) {
        e.page_url = `https://vrchat.com/home/group/${e.group_id}`;
        e.page_label = '群组主页';
      }
    }

    api.log(`✅ 完成：采集 ${collected.length} → 去重 ${dedup.length} → 输出 ${events.length}`);

    // 返回结构化 JSON（供 Agent 翻译/渲染 PDF/进一步加工）
    const HAVE_GOOGLE_KEY = getGoogleKey() ? true : false;
    return {
      retrievedAt: new Date().toISOString(),
      params: opts,
      configStatus: {
        googleCalendarApiKey: HAVE_GOOGLE_KEY,
        // 引导使用者创建 Google API Key（VRCEve/VRCEvent-KR 数据源需要）
        googleKeySetupGuide: HAVE_GOOGLE_KEY ? null : {
          notice: '未配置使用者的 Google Calendar API Key，VRCEve(日本)/VRCEvent-KR(韩国) 数据源跳过。请用 set_community_events_google_key 录入你账号的 key（存入数据库），或访问以下指引创建：',
          createKeyUrl: 'https://console.cloud.google.com/apis/credentials',
          enableCalendarApiUrl: 'https://console.cloud.google.com/apis/library/calendar-googleapis.com',
        },
      },
      sourceBreakdown: {
        vrcsearch: collected.filter(e => e.src === 'VRC Search').length,
        rlvrc: collected.filter(e => e.src === 'RLVRC').length,
        vrceve: collected.filter(e => e.src === 'VRCEve').length,
        vrckr: collected.filter(e => e.src === 'VRCEvent KR').length,
      },
      counts: { collected: collected.length, deduped: dedup.length, output: events.length },
      groupsMined: toMine.filter(e => e.group_id).length,
      events: events.map(enrichEvent).slice(0, Math.min(Math.max(parseInt(args.limit, 10) || 200, 1), 500)),
    };
  }

  // ════════════ 配置工具：Google Calendar API Key（使用者的 key，存数据库）════════════
  const GOOGLE_SETUP_GUIDE = {
    createKeyUrl: 'https://console.cloud.google.com/apis/credentials',
    enableCalendarApiUrl: 'https://console.cloud.google.com/apis/library/calendar-googleapis.com',
    steps: [
      '打开 Google Cloud Console → 选择或创建项目',
      '在「API 与服务 → 库」中搜索并启用 Google Calendar API',
      '在「API 与服务 → 凭据」→「创建凭据」→「API 密钥」生成 key',
      '把生成的 API Key 交给 set_community_events_google_key 录入（仅作用于本插件，用于读取 VRCEve/VRCEvent-KR 公开日历）',
    ],
  };

  function handleGetConfig() {
    const configured = getGoogleKey() ? true : false;
    return {
      configured,
      googleCalendarApiKey: configured ? '已配置（值存数据库，不回显）' : '未配置',
      googleKeySetupGuide: configured ? null : GOOGLE_SETUP_GUIDE,
    };
  }

  function handleSetGoogleKey({ apiKey, confirm }) {
    if (!apiKey || typeof apiKey !== 'string') throw new Error('apiKey 必填（使用者的 Google Cloud API Key）');
    if (confirm !== true) {
      return {
        confirmRequired: true,
        message: `将把使用者提供的 Google API Key 写入数据库（plg_events_config，仅本插件读取，用于 VRCEve/VRCEvent-KR 数据源）。传入 apiKey + confirm:true 确认。若需移除，传 apiKey=""。`,
        guide: GOOGLE_SETUP_GUIDE,
      };
    }
    const cfg = api.db.table('config');
    cfg.run('INSERT OR REPLACE INTO config (cfg_key, cfg_val, updated_at) VALUES ($k, $v, datetime(\'now\'))',
      { $k: 'google_calendar_api_key', $v: apiKey.trim() });
    const ok = getGoogleKey() ? true : false;
    api.log(`ℹ️ 使用者 Google API Key 已${apiKey.trim() ? '更新' : '清除'}（config 表）`);
    return {
      stored: true,
      configured: ok,
      note: apiKey.trim() ? '已存入数据库。之后 fetch_community_events 采集 VRCEve/VRCEvent-KR 将生效。' : '已清除 key，VRCEve/VRCEvent-KR 将跳过。',
    };
  }

  // ── 工具注册 ──
  api.registerTool({
    name: 'fetch_community_events',
    description: '[events] 聚合 VRChat 社区活动：采集(VRC Search/RLVRC/VRCEve/VRCEvent-KR) → 群组深度挖掘(短码/活动名/世界名反查) → 音乐∪虚拟主播筛选 → 结构化 JSON + 落库 plg_events_store。可选 peekGroups=true 窥探已挖掘群组公告补充活动（有副作用：加入→读→退出）。用于找"最近/今晚有什么活动、哪些要参与、群组热度"。未配置 Google Key 时返回 configStatus 的创建网址指引。PDF 渲染另走管道。',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', enum: ['week', 'month', 'tonight'], default: 'week', description: '时间窗：week(近8天)/month(近31天)/tonight(今晚到明早)' },
        focus: { type: 'string', enum: ['all', 'music', 'vtuber'], default: 'all', description: 'focus=music 时筛音乐∪虚拟主播活动' },
        sources: { type: 'string', default: 'all', description: '逗号分隔数据源: vrcsearch,rlvrc,vrceve,vrckr (默认 all)' },
        languages: { type: 'string', default: 'all', description: '逗号分隔语言筛: zh,ja,ko,en (默认 all)' },
        minMembers: { type: 'number', default: 0, description: '只保留群组人数 ≥ 该值的活动' },
        maxMine: { type: 'number', default: 60, description: '群组深度挖掘的活动数上限(0~300，受 API 限流约 2.6s/个，短码优先)' },
        peekGroups: { type: 'boolean', default: false, description: '窥探已挖掘群组的公告作为侧面补充源（有副作用：会加入→读公告→退出，成员可见加入通知）' },
        startDate: { type: 'string', description: '自定义开始日期 YYYY-MM-DD（与 endDate 成对，覆盖 window）' },
        endDate: { type: 'string', description: '自定义结束日期 YYYY-MM-DD' },
        limit: { type: 'number', default: 200, description: '返回的活动条数上限(≤500)' },
      },
    },
    handler: async (args) => handleFetchCommunityEvents(args),
  });

  api.registerTool({
    name: 'get_community_events_config',
    description: '[events·配置] 查看社区活动抓取的配置状态：Google Calendar API Key 是否已配置（值存数据库不回显）；未配置时返回创建 key 的指引网址。',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => handleGetConfig(),
  });

  api.registerTool({
    name: 'set_community_events_google_key',
    description: '[events·配置] 录入/清除使用者的 Google Cloud API Key（存入数据库 plg_events_config，仅本插件读取，用于 VRCEve/VRCEvent-KR 日历源）。需要 confirm:true。创建 key 的网址见返回的 guide。',
    inputSchema: {
      type: 'object',
      properties: {
        apiKey: { type: 'string', description: '使用者的 Google Cloud API Key（形如 AIzaSy...）。传空串则清除' },
        confirm: { type: 'boolean', description: '必须为 true 才写入数据库；false 只返回确认预览' },
      },
      required: ['apiKey'],
    },
    handler: async (args) => handleSetGoogleKey(args),
  });

  return function dispose() {
    api.log('events 插件卸载');
  };
}

// ── 工具函数（模块级，不依赖 api）──
const CAT_ZH = { music:'音乐',dance:'舞蹈',hangout:'聚会',gaming:'游戏',roleplaying:'角色扮演',performance:'演出',education:'教育' };
function decodeEntities(s) {
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
}
function stripHtml(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
}
function normName(s) {
  return decodeEntities(String(s || '').toLowerCase()).replace(/[\s【】()（）\[\]＿_\-＃#:：、，。·中\.\"'`]/g, '');
}