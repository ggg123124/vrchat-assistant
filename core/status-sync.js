/**
 * 动态状态引擎（Dynamic Status Sync）—— 根据在线好友数量实时更新自己的自定义状态。
 *
 * 设计（用户 2026-09-07 确认）：
 *   - **开关默认关闭**，config 表 `dynamic_status` 键存储（运行期经 MCP 工具/dashboard 可切，无需重启）；
 *   - 触发 = friend-online/offline 事件驱动（start-monitor onEvent 钩子）+ 低频定时核对兜底；
 *   - 限流内建：①状态文本**真变化**才提交 PUT /auth/user；②最小冷却间隔（默认 65s，VRChat
 *     状态更新接口频率限制留足余量）；③PUT body 保留原 status 种类（active/join me 等），
 *     只改 statusDescription（自定义状态文本），不改变在线形态；
 *   - 模板：statusDescription 文本模板，`{online}` 占位符替换为当前在线好友数（默认"在线 {online} 人"）。
 *
 * 事件高频场景（重连突发批量 online/offline）由冷却 + unchanged 早退双保险防刷 API。
 */

const CONFIG_KEY = 'dynamic_status';
const DEFAULT_TEMPLATE = '在线 {online} 人';
const MIN_INTERVAL_MS = 65_000;
const MAX_DESC_LEN = 64; // VRChat statusDescription 长度上限（保守取 64）

export class DynamicStatusSync {
  /**
   * @param ctx 全局 server-context（需 api/storage/friendState）
   * @param opts.log 日志函数
   */
  constructor(ctx, { log } = {}) {
    this.ctx = ctx;
    this.log = log || (() => {});
    this._lastSent = '';   // 最近一次成功提交的文本（进程内去重）
    this._lastAt = 0;      // 最近一次提交时间戳（冷却窗口）
  }

  /** 读配置（config 表 JSON；缺失/损坏回退默认关闭） */
  get config() {
    const raw = this.ctx.storage.getConfig(CONFIG_KEY);
    if (!raw) return { enabled: false, template: DEFAULT_TEMPLATE };
    try {
      const c = JSON.parse(raw);
      return {
        enabled: !!c.enabled,
        template: (typeof c.template === 'string' && c.template.trim()) ? c.template : DEFAULT_TEMPLATE,
      };
    } catch {
      return { enabled: false, template: DEFAULT_TEMPLATE };
    }
  }

  /** 写配置（局部合并），返回合并后的完整配置 */
  setConfig(patch = {}) {
    const next = { ...this.config, ...patch };
    next.enabled = !!next.enabled;
    next.template = (typeof next.template === 'string' && next.template.trim()) ? next.template : DEFAULT_TEMPLATE;
    this.ctx.storage.setConfig(CONFIG_KEY, JSON.stringify(next));
    return next;
  }

  /** 渲染模板：{online} → 当前在线好友数；截断按 Unicode 码点（review #166 💡：UTF-16 slice 会把 emoji 切半成替换符） */
  render(text, online) {
    const rendered = String(text).replaceAll('{online}', String(online));
    const chars = Array.from(rendered);
    return chars.length <= MAX_DESC_LEN ? rendered : chars.slice(0, MAX_DESC_LEN).join('');
  }

  /**
   * 主入口：核对在线数 → 渲染 → 与远端比对 → 冷却闸 → PUT。
   * @param force true 时绕过开关/冷却（set_dynamic_status 保存后立即生效用）
   * @returns 执行摘要 { action: 'synced'|'skipped', reason?, statusDescription?, online? }
   */
  async sync(force = false) {
    const cfg = this.config;
    if (!cfg.enabled && !force) return { action: 'skipped', reason: 'disabled' };

    const online = this.ctx.friendState ? this.ctx.friendState.getOnlineCount() : null;
    if (online == null) return { action: 'skipped', reason: 'no-friend-state' };

    const text = this.render(cfg.template, online);

    // 冷却闸前置（review #166 🟡）：冷却窗口内的事件不再各发一次 GET /auth/user，
    // 避免高峰时段事件密集时瞬时多请求触发 429；unchanged 比对改用上次发送缓存。
    const now = Date.now();
    if (!force && now - this._lastAt < MIN_INTERVAL_MS) {
      return { action: 'skipped', reason: 'cooldown', nextInMs: MIN_INTERVAL_MS - (now - this._lastAt) };
    }

    const me = await this._fetchMe();
    if (!me) return { action: 'skipped', reason: 'no-me' };

    if (!force && text === (me.statusDescription || '')) {
      this._lastAt = now; // 远端已与目标一致，同样进入冷却（防窗口内重复 GET）
      this._lastSent = text;
      return { action: 'skipped', reason: 'unchanged' };
    }

    const ok = await this._putStatus(me.id, text, me.status);
    if (ok) {
      this._lastAt = now;
      this._lastSent = text;
      this.log(`[状态] 动态状态已更新（在线 ${online} 人）: ${text}`);
      return { action: 'synced', statusDescription: text, online };
    }
    return { action: 'failed', reason: 'put-failed', detail: this._lastPutError || '', statusDescription: text, online };
  }

  /** 经 rateLimiter 串行化调用 API（review #166 🟡：与仓库其余调用同模式；无限流器时直连降级） */
  async _api(method, path, body) {
    const req = () => this.ctx.api._request(method, path, body);
    if (this.ctx.rateLimiter) return this.ctx.rateLimiter.execute(req);
    return req();
  }

  async _fetchMe() {
    try {
      const r = await this._api('GET', '/auth/user');
      return (r.status === 200 && r.data) ? r.data : null;
    } catch { return null; }
  }

  /**
   * 更新自己的自定义状态：**PUT /users/{userId}**（VRChat 现行端点；容器内实测
   * PUT /auth/user 返回 405 Method Not Allowed——该路径已不接受更新方法）。
   * 只改 statusDescription；保留原 status 种类，不改变在线形态。失败原因透传 _lastPutError。
   */
  async _putStatus(selfId, desc, keepStatus) {
    try {
      if (!selfId) { this._lastPutError = 'no self id'; return false; }
      const body = { statusDescription: desc };
      if (keepStatus) body.status = keepStatus;
      const r = await this._api('PUT', `/users/${encodeURIComponent(selfId)}`, body);
      if (r.status !== 200) this._lastPutError = `HTTP ${r.status}: ${JSON.stringify(r.data || {}).slice(0, 200)}`;
      return r.status === 200;
    } catch (e) {
      this._lastPutError = String(e.message || e).slice(0, 200);
      return false;
    }
  }
}
