/**
 * 动态状态引擎（Dynamic Status Sync）—— 根据在线好友数量实时更新自己的自定义状态。
 *
 * 两种模式（config 表 `dynamic_status` 键，运行期经 MCP 工具 / dashboard 可切，无需重启）：
 *   - `fixed`（默认，行为与历史一致）：整段 statusDescription 按模板覆盖，如「在线 {total} 人」；
 *   - `suffix`（2026-10-12 用户拍板 B）：**保留你自己写的正文，只在结尾维护我们的后缀** ——
 *     你在 VRChat 里手打「打机中」，下一轮它会变成「打机中 · 在线 5 人」；你自己改文字后
 *     我们不覆盖它，只在结尾补/更新那截后缀。
 *
 * 触发 = friend-online/offline 事件驱动（start-monitor onEvent 钩子）+ 低频定时核对兜底。
 * 防刷与防循环（suffix 模式下尤其重要）：
 *   ① 文本**真变化**才 PUT；②最小冷却 65s；③远端已与目标一致 ⇒ unchanged 早退（写回不自我触发）；
 *   ④ **后缀可识别 + 贪婪剥离**（幂等：连写 N 次不会累加成「在线 5 人 · 在线 5 人」）；
 *   ⑤ 别人刚改过 ⇒ 静默期 GRACE_MS 内不写（避免打断使用者打字）；
 *   ⑥ 同一段文字被别人反复改写 ≥3 次 ⇒ 退避 10 分钟并留一行日志（写入方抢写自保）。
 *
 * ⚠️ 同一 statusDescription 的写入方共三处：使用者本人（VRChat 客户端）、本引擎、
 * presence-status 插件。
 * **当前真实的共存机制**（2026-10-16 按审查意见改正；此前 JSDoc 声称两边通过 `composeForOther()` 共用合成规则，
 * 但生产代码里【没有任何调用方】✗ —— 那只是给其它写入方预留的公开 API，行为由测试固定）：
 *   ① 插件按自己的模板写成**裸文案**（如「挂机中」）；
 *   ② 本引擎下一轮在 suffix 模式下识别并剥离旧后缀、再补上「正文 + 分隔符 + 后缀」；
 *   ③ 插件用 `isOurText()`（相等，或以我们写过的文案开头）认出并容忍后缀，不会把它当「使用者手改」而反复重写 ✓。
 *   若将来让插件自己一步合成，请改用 `composeForOther()` 并共用同一 separator / template，否则两边会互相抹除。
 */

const CONFIG_KEY = "dynamic_status";
const DEFAULT_TEMPLATE = "在线 {total} 人";
const DEFAULT_SEPARATOR = " · ";
const MIN_INTERVAL_MS = 65_000;
const MAX_DESC_LEN = 64;
const GRACE_MS = 120_000;
// 5 次**不同的**「别人改过的文字」才退避；她自己改状态也会被算进来，3 太容易误触发
const CONFLICT_LIMIT = 5;
const CONFLICT_BACKOFF_MS = 600_000;
const SUFFIX_MAX_STRIP = 5;
// 分隔符上限（审查 💡3：API 可绕过 UI 的 maxlength；超长会走 room<=0 只剩后缀）
const MAX_SEPARATOR_LEN = 4;

/** 按 Unicode 码点截断（UTF-16 slice 会把 emoji 切半 ⇒ 用 Array.from） */
function cut(s, n) {
  const a = Array.from(String(s == null ? "" : s));
  return a.length <= n ? a.join("") : a.slice(0, n).join("");
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** 等价转义：VRChat 会把半角 | 存成全角 ｜（本机库 140 条样本实测）；~ 按同一规律**假设**也会被规范化（本机库暂 0 条样本，非实测）⇒ 模板里的这些字面量一并按等价类匹配 */
function escapeReEq(s) {
  return Array.from(String(s)).map((ch) => {
    if (ch === "|" || ch === "｜") return "[|｜]";
    if (ch === "~" || ch === "～") return "[~～]";
    return escapeRe(ch);
  }).join("");
}

/** VRChat 会把状态文本里的半角竖线 | 规范化成全角 ｜（2026-10-17 生产实测：PUT 半角，WS 回推是全角）。
 * 这会让「按配置里的半角分隔符剥离」失效 ⇒ 每轮都认不出自己的后缀、把它当正文再追加一次（无限累加）。
 * 因此比较与剥离都按等价字符处理。 */
export function sameStatus(a, b) {
  return normalizeStatusText(a) === normalizeStatusText(b);
}

export function normalizeStatusText(s) {
  return String(s == null ? "" : s).replace(/｜/g, "|").replace(/～/g, "~");
}

/** 把后缀模板编译成"能认出我们上次写的那截尾巴"的正则（锚定结尾，占位符→数字） */
export function suffixPattern(template) {
  const body = String(template == null ? "" : template).trim();
  if (!body) return null;
  let out = "";
  const re = /\{(online|total|webOnline|gameOnline)\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    out += escapeReEq(body.slice(last, m.index)) + "\\d{1,4}";
    last = m.index + m[0].length;
  }
  out += escapeReEq(body.slice(last));
  try { return new RegExp(out + "$"); } catch { return null; }
}

/**
 * 剥离"我们自己加的后缀"，返回使用者手写的正文（幂等 + 自愈）。
 * 只在分隔符之后（或整段就是后缀）才剥 —— 避免把使用者正文里凑巧同形的句子吃掉。
 */
export function stripSuffix(text, template, separator = DEFAULT_SEPARATOR) {
  const re = suffixPattern(template);
  let out = String(text == null ? "" : text);
  const sep = String(separator == null ? DEFAULT_SEPARATOR : separator);
  if (!re) return out.trim();
  const sepRe = sep ? new RegExp(escapeReEq(sep) + "\\s*$") : null;   // 循环外构造一次（复审 💡）
  for (let i = 0; i < SUFFIX_MAX_STRIP; i++) {
    const m = re.exec(out);
    if (!m) break;
    const before = out.slice(0, m.index);
    // 只认【我们自己写进去的那个分隔符】（含其后的空白）—— 原先还接受「任意结尾空白」✗：
    // 那会把使用者正文里凑巧同形的结尾（如「欢迎 在线 5 人」）整段吃掉（审查方独立探针实测 ✗）。
    // 分隔符里可能有被 VRChat 规范化过的字符（半角 | → 全角 ｜）⇒ 按等价类匹配
    if (m.index > 0) {
      if (!sepRe || !sepRe.test(before)) break;
      out = before.replace(sepRe, '');
    } else {
      out = '';   // 整段就是后缀 ⇒ 正文为空
    }
  }
  return out.trim();
}

/** 合成「正文 + 分隔符 + 后缀」；先保证后缀完整，空间不够时截断正文（按码点） */
export function composeStatus(base, suffixText, { separator = DEFAULT_SEPARATOR, maxLen = MAX_DESC_LEN } = {}) {
  const suffix = String(suffixText == null ? "" : suffixText).trim();
  const body = String(base == null ? "" : base).trim();
  if (!suffix) return cut(body, maxLen);
  if (!body) return cut(suffix, maxLen);
  const sep = String(separator == null ? DEFAULT_SEPARATOR : separator);
  const room = maxLen - Array.from(suffix).length - Array.from(sep).length;
  if (room <= 0) return cut(suffix, maxLen);
  return cut(body, room) + sep + suffix;
}

export class DynamicStatusSync {
  constructor(ctx, { log, now, timers } = {}) {
    this.ctx = ctx;
    this.log = log || (() => {});
    this._now = typeof now === "function" ? now : () => Date.now();
    // 定时器可注入（测试用；默认走全局 setTimeout/clearTimeout）
    this._timers = timers || {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h),
    };
    this._retryTimer = null;
    this._lastSent = "";
    this._lastAt = 0;
    this._foreignText = "";
    this._foreignAt = 0;
    this._foreignCount = 0;
    this._backoffUntil = 0;
  }

  /**
   * 静默期到点后的自动重试（2026-10-12，用户报「我手动设置状态后，要下次在线人数变更他才会加后缀」）。
   * 原来「记下别人刚改过 ⇒ 返回 grace」之后**没有任何东西会再叫醒引擎**，只能等 5 分钟定时器，
   * 或者恰好有好友上下线 ⇒ 体感就是"必须等在线人数变更"。现在当场排一次一次性重试。
   */
  _scheduleRetry(ms) {
    if (this._retryTimer != null) this._timers.clearTimeout(this._retryTimer);
    const wait = Math.max(1000, Math.round(ms));
    this._retryTimer = this._timers.setTimeout(() => {
      this._retryTimer = null;
      Promise.resolve(this.sync()).catch(() => {});
    }, wait);
    if (this._retryTimer && typeof this._retryTimer.unref === "function") this._retryTimer.unref();
    return wait;
  }

  _clearRetry() {
    if (this._retryTimer != null) { this._timers.clearTimeout(this._retryTimer); this._retryTimer = null; }
  }

  get config() {
    const raw = this.ctx.storage.getConfig(CONFIG_KEY);
    const off = { enabled: false, mode: "fixed", template: DEFAULT_TEMPLATE, separator: DEFAULT_SEPARATOR };
    if (!raw) return off;
    try {
      const c = JSON.parse(raw);
      return {
        enabled: !!c.enabled,
        mode: c.mode === "suffix" ? "suffix" : "fixed",
        template: (typeof c.template === "string" && c.template.trim()) ? c.template : DEFAULT_TEMPLATE,
        separator: (typeof c.separator === "string" && c.separator.length) ? cut(c.separator, MAX_SEPARATOR_LEN) : DEFAULT_SEPARATOR,
      };
    } catch { return off; }
  }

  setConfig(patch = {}) {
    const next = { ...this.config, ...patch };
    next.enabled = !!next.enabled;
    next.mode = next.mode === "suffix" ? "suffix" : "fixed";
    next.template = (typeof next.template === "string" && next.template.trim()) ? next.template : DEFAULT_TEMPLATE;
    next.separator = (typeof next.separator === "string" && next.separator.length) ? next.separator : DEFAULT_SEPARATOR;
    this.ctx.storage.setConfig(CONFIG_KEY, JSON.stringify(next));
    return next;
  }

  _counts() {
    try {
      const r = this.ctx.storage.query(
        "SELECT SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) AS total," +
        " SUM(CASE WHEN is_online = 1 AND platform = 'web' THEN 1 ELSE 0 END) AS web," +
        " SUM(CASE WHEN is_online = 1 AND (platform IS NULL OR platform <> 'web') THEN 1 ELSE 0 END) AS game" +
        " FROM friends")[0];
      if (!r) return null;
      return { total: Number(r.total) || 0, web: Number(r.web) || 0, game: Number(r.game) || 0 };
    } catch { return null; }
  }

  render(text, online, counts = null) {
    const c = counts || {};
    const total = Number.isFinite(c.total) ? c.total : online;
    const web = Number.isFinite(c.web) ? c.web : 0;
    const game = Number.isFinite(c.game) ? c.game : total;
    let rendered = String(text);
    for (const [k, v] of [["{online}", total], ["{total}", total],
      ["{webOnline}", web], ["{gameOnline}", game]]) {
      rendered = rendered.replaceAll(k, String(v));
    }
    return cut(rendered, MAX_DESC_LEN);
  }

  /** 供其它写入方（presence-status）复用：产出与本引擎一致的整段文字 ⇒ 不互相抹除 */
  composeForOther(baseText) {
    const cfg = this.config;
    const raw = String(baseText == null ? "" : baseText);
    if (!cfg.enabled || cfg.mode !== "suffix") return raw;
    const online = this.ctx.friendState ? this.ctx.friendState.getOnlineCount() : null;
    const counts = this._counts();
    if (online == null && !counts) return raw;
    const suffix = this.render(cfg.template, online == null ? 0 : online, counts);
    return composeStatus(stripSuffix(raw, cfg.template, cfg.separator), suffix, { separator: cfg.separator });
  }

  _targetFor(cfg, remote, online, counts) {
    if (cfg.mode !== "suffix") return { target: this.render(cfg.template, online, counts), base: null };
    const base = stripSuffix(remote, cfg.template, cfg.separator);
    const suffix = this.render(cfg.template, online, counts);
    return { target: composeStatus(base, suffix, { separator: cfg.separator }), base };
  }

  async sync(force = false, opts = {}) {
    const cfg = this.config;
    if (!cfg.enabled && !force) return { action: "skipped", reason: "disabled" };
    const online = this.ctx.friendState ? this.ctx.friendState.getOnlineCount() : null;
    if (online == null) return { action: "skipped", reason: "no-friend-state" };
    const counts = this._counts();
    const now = this._now();

    if (!force && now - this._lastAt < MIN_INTERVAL_MS) {
      const nextInMs = MIN_INTERVAL_MS - (now - this._lastAt);
      // 她刚改过状态但撞上冷却（例如前一刻刚有好友上下线触发过同步）⇒ 冷却一过就自动核对，
      // 否则这次核对会被冷却挡掉、又不排重试 ⇒ 又要干等下一次事件/5 分钟定时器
      if (opts.hint === "self-edit") this._scheduleRetry(nextInMs + 2_000);
      return { action: "skipped", reason: "cooldown", nextInMs };
    }
    if (!force && now < this._backoffUntil) {
      return { action: "skipped", reason: "writer-conflict-backoff", nextInMs: this._backoffUntil - now };
    }

    const me = await this._fetchMe();
    if (!me) return { action: "skipped", reason: "no-me" };
    const remote = typeof me.statusDescription === "string" ? me.statusDescription : "";
    const { target } = this._targetFor(cfg, remote, online, counts);

    // 与「未变化」判定同口径：按规范化比较（VRChat 会把 | 存成 ｜）；裸比较会把自己的写入误判成「别人在打字」
    if (cfg.mode === "suffix" && this._lastSent && !sameStatus(remote, this._lastSent) && !sameStatus(remote, target)) {
      // 与其它比较同口径：宽度差异（| vs ｜）不算「不同的文字」，否则同一次冲突会被数成两笔
      if (!sameStatus(this._foreignText, remote)) {
        this._foreignText = remote;
        this._foreignAt = now;
        this._foreignCount += 1;
      }
      if (this._foreignCount >= CONFLICT_LIMIT) {
        this._backoffUntil = now + CONFLICT_BACKOFF_MS;
        this._foreignCount = 0;
        this.log("[状态] 同一段状态文字被反复改写（" + CONFLICT_LIMIT + " 次），退避 10 分钟（可能有其它写入方，或你正在手改）");
        return { action: "skipped", reason: "writer-conflict", nextInMs: CONFLICT_BACKOFF_MS };
      }
      if (!force && now - this._foreignAt < GRACE_MS) {
        // 静默期到点后**自己叫醒一次**，不再干等 5 分钟定时器 / 好友上下线事件
        const retryInMs = this._scheduleRetry(this._foreignAt + GRACE_MS - now + 5_000);
        return { action: "skipped", reason: "grace", statusDescription: target, online, retryInMs };
      }
    }

    // 规范化后相等 ⇒ 视为未变化（否则 VRChat 把 | 规范化成 ｜ 后，我们每轮都误判成「变了」并重写）
    if (!force && sameStatus(target, remote)) {
      this._lastAt = now;
      this._lastSent = target;
      return { action: "skipped", reason: "unchanged" };
    }

    const ok = await this._putStatus(me.id, target, me.status);
    if (ok) {
      this._lastAt = now;
      this._lastSent = target;
      this._foreignCount = 0;
      this._clearRetry();
      this._foreignText = target;
      this.log("[状态] 动态状态已更新（在线 " + online + " 人）: " + target);
      return { action: "synced", statusDescription: target, online, mode: cfg.mode };
    }
    return { action: "failed", reason: "put-failed", detail: this._lastPutError || "", statusDescription: target, online };
  }

  async _api(method, path, body) {
    const req = () => this.ctx.api._request(method, path, body);
    if (this.ctx.rateLimiter) return this.ctx.rateLimiter.execute(req);
    return req();
  }

  async _fetchMe() {
    try {
      const r = await this._api("GET", "/auth/user");
      return (r.status === 200 && r.data) ? r.data : null;
    } catch { return null; }
  }

  /** PUT /users/{userId}（VRChat 现行端点；PUT /auth/user 实测 405）。只改 statusDescription。 */
  async _putStatus(selfId, desc, keepStatus) {
    try {
      if (!selfId) { this._lastPutError = "no self id"; return false; }
      const body = { statusDescription: desc };
      if (keepStatus) body.status = keepStatus;
      const r = await this._api("PUT", "/users/" + encodeURIComponent(selfId), body);
      if (r.status !== 200) this._lastPutError = "HTTP " + r.status + ": " + JSON.stringify(r.data || {}).slice(0, 200);
      return r.status === 200;
    } catch (e) {
      this._lastPutError = String(e.message || e).slice(0, 200);
      return false;
    }
  }
}
