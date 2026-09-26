import { avatarThumb, avatarOf, avatarFileId } from './img-util.js';

// 网页端在线判据（单一来源：WS friend-active 与 start-monitor 快照对账共用，防漂移）。
// 当前仅 'web'——nativemobile 语义待确认后纳入（见 _handleActive 注释与跟进 issue）。
export function isWebPresence(platform) {
  return platform === 'web';
}
import { getLogger } from './logger.js';

const log = getLogger('event');

/**
 * 从 WS 的 user 载荷取「当前模型图 URL」。
 *
 * 新版资料系统里 currentAvatarImageUrl / currentAvatarThumbnailImageUrl 已被移除，实际字段是 iconUrl ——
 * 但 **只有 bannerType === 'avatarBanner' 时它才指向模型图**。
 * bannerType 会变、各档占比也随账号与时间漂移 ⇒ **这里不写死比例**，判据只看 bannerType 本身
 * （写死的数字容易互相矛盾、也容易过期 —— 上一轮审查即指出过这一点）。
 * ⇒ 没有可信的模型图信息时【返回 undefined，不要返回空串】：
 *   空串在调用方会被当成"新值是空的"，与旧值 diff 出【空图的「更换模型」事件】、
 *   并在 upsert 里把模型图基线清空。undefined 表示"这条载荷没带模型信息"⇒ 调用方保持原值。
 */
export function avatarImageUrlFromUser(user) {
  const u = user || {};
  if (String(u.bannerType || '') === 'avatarBanner') {
    return u.iconUrl || u.currentAvatarImageUrl || undefined;
  }
  // 非 avatarBanner：iconUrl 不是模型图 ⇒ 只用仍在的旧字段兜底（不写死比例，判据同上）
  // ⇒ 只用仍在的旧字段兜底；两者都没有 ⇒ undefined
  return u.currentAvatarImageUrl || undefined;
}

// 用户图标（资料里自己设的那张方图）取值：iconUrl 优先、旧字段 userIcon 兜底。
// 与 avatarImageUrlFromUser 同一纪律：取不到返回 undefined（表示「没有信息」），不返回空串 ——
// 空串会被下游当成「有值且为空」，与真实的「字段缺失」混在一起（#251 审查抓到的形态）。
export function userIconUrlFromUser(user) {
  return user?.iconUrl || user?.userIcon || undefined;
}

// 码点安全截断（review #166：UTF-16 slice 会把 emoji 切半成 U+FFFD 替换符）。
// 仅日志展示层用，不影响落库数据。
// ── 同世界同实例的重复 location 去重 ───────────────────────────────────
// 背景：VRChat 在好友改 Avatar / 客户端重新同步时会重发 world+instance 完全相同的
// friend-location。逐条落库后，看板动态流里会呈现成「一直在换世界」（同一世界名刷屏），
// 实际并没有换——用户报障即为此（好友在 Avatar 搜索图里挑模型）。
// 开关：VRC_MONITOR_DEDUP_SAME_INSTANCE_LOCATION（默认 1=去重；0=保留逐条原始事件，排查用）
// 窗口：VRC_MONITOR_DEDUP_SAME_INSTANCE_WINDOW_SECONDS（默认 300s；窗口外的重复仍落一条心跳，
//       便于观察「长期待在同一实例」；调用时读 env，便于测试切换）
// 只影响 events 表落库与日志；好友状态（location / lastSeen）照常刷新。
function sameInstanceDedupConfig() {
  const windowRaw = Number(process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_WINDOW_SECONDS);
  return {
    enabled: Number(process.env.VRC_MONITOR_DEDUP_SAME_INSTANCE_LOCATION) !== 0,
    windowMs: Number.isFinite(windowRaw) && windowRaw > 0 ? windowRaw * 1000 : 300 * 1000,
  };
}

function truncateCodePoints(str, max) {
  const s = String(str ?? '');
  const chars = Array.from(s);
  return chars.length <= max ? s : chars.slice(0, max).join('');
}


/**
 * VRChat 好友监控系统 — 事件处理管道
 * 
 * 将 WebSocket 事件标准化并持久化到 SQLite
 */
import { trustFromTags } from './friend-refresh.js';

export class EventPipeline {
  constructor(storage, worldCache) {
    this.storage = storage;
    this.worldCache = worldCache;
    this._eventCount = 0;
    this._lastSave = Date.now();
    this._flushTimer = null;         // 定时 flush 句柄
    this._flushInterval = 5000;      // 每 5 秒自动持久化
    // SSE 富化用 friend 行缓存：按 userId 缓存 friends 表行 + 昵称，避免每个事件都查库（活跃时段防高频 DB 负载）
    this._friendCache = new Map();   // userId -> {row, nickname, at}
    this._FRIEND_CACHE_TTL = 5000;   // 5s TTL，够覆盖一次事件风暴；超出回源查库
    this._startFlushTimer();
  }

  /** 启动定时 flush */
  _startFlushTimer() {
    if (this._flushTimer) clearInterval(this._flushTimer);
    this._flushTimer = setInterval(() => {
      if (this._eventCount > 0 && (Date.now() - this._lastSave >= this._flushInterval)) {
        this.storage.save();
        this._lastSave = Date.now();
      }
    }, this._flushInterval);
    // 不让定时器阻止进程退出
    if (this._flushTimer.unref) this._flushTimer.unref();
  }

  /**
   * 处理一个 WebSocket 事件
   */
  async process(event) {
    this._eventCount++;

    switch (event.type) {
      case 'friend-online':
        return await this._handleOnline(event);
      case 'friend-offline':
        return await this._handleOffline(event);
      case 'friend-location':
        return await this._handleLocation(event);
      case 'user-location':
        // 自己的位置事件：content 无独立 worldId 字段（只有 location 字符串），需解析
        return await this._handleUserLocation(event);
      case 'friend-update':
        return await this._handleUpdate(event);
      case 'friend-active':
        return await this._handleActive(event);
      case 'friend-add':
        return await this._handleAdd(event);
      case 'friend-delete':
        return await this._handleDelete(event);
      case 'notification':
      case 'notification-v2':
        return await this._handleNotification(event);
      default:
        // 未知事件类型，仍然存到 events 表
        return this._storeEvent(event);
    }
  }

  /** 获取统计 */
  getStats() {
    return { processed: this._eventCount };
  }

  // ── 事件处理器 ──

  async _handleOnline(event) {
    const userId = event.userId;
    const displayName = event.displayName;
    const location = event.location || '';
    const worldId = event.worldId || '';
    const worldName = await this._resolveWorldName(worldId);
    // 状态以事件携带的 user.status 为准（不再硬编码 active——2026-09-13 用户实测 bug）
    this._syncProfileFromEvent(userId, event.content && event.content.user);

    // 更新好友状态
    this.storage.upsertFriend({
      userId,
      displayName,
      isOnline: true,
      location,
      worldId,
      worldName,
      platform: event.platform,
      lastSeen: event.receivedAt,
      lastOnline: event.receivedAt,
    });

    // 存储事件（带解析到的世界名）
    this._storeEvent(event, worldName);
    // 上线是热路径（生产实测「上线+下线」合计占日志 22.3%），逐条 INFO 信噪比过低：
    // DB 事件流 / SSE / 看板不受影响（events 表照常落库），日志层无需逐条回显。
    // 排查时用 VRC_MONITOR_LOGGER_LEVEL=debug 恢复。先例：头像变更（34.5%，已降 debug）。
    log.debug(`${displayName} 上线「${worldName || worldId || location || '未知'}」`);
  }

  async _handleOffline(event) {
    const userId = event.userId;

    this.storage.upsertFriend({
      userId,
      isOnline: false,
      location: 'offline',
      lastSeen: event.receivedAt,
      lastOffline: event.receivedAt,
    });

    this._storeEvent(event);
    // 下线同属热路径（「上线+下线」合计 22.3%），降 debug 理由同 _handleOnline：
    // 事件照旧落库，VRC_MONITOR_LOGGER_LEVEL=debug 可恢复。
    log.debug(`${event.displayName || userId} 下线`);
  }

  async _handleLocation(event) {
    const userId = event.userId;
    const displayName = event.displayName;
    const location = event.location || '';
    const worldId = event.worldId || '';
    const worldName = await this._resolveWorldName(worldId);

    this._syncProfileFromEvent(userId, event.content && event.content.user);

    const prev = this.storage.getFriend(userId);
    const prevWorldId = prev?.world_id || '';
    const prevLocation = prev?.location || '';
    const prevSeenMs = Date.parse(prev?.last_seen || '') || 0;
    const nowMs = Date.parse(event.receivedAt || '') || Date.now();
    const { enabled: dedupOn, windowMs: dedupWindowMs } = sameInstanceDedupConfig();
    const isSameInstanceRepeat = dedupOn
      && !!location && location === prevLocation
      // 用 startsWith：线上「传送中」的形态是 traveling:traveling（2026-09-25 生产实测），
      // 精确匹配会把它当成「到达某世界」，从而在这条上做世界判定并落事件。
      && location !== 'offline' && !String(location).startsWith('traveling')
      && prevSeenMs > 0 && nowMs - prevSeenMs <= dedupWindowMs;

    this.storage.upsertFriend({
      userId,
      displayName,
      location,
      worldId,
      worldName,
      platform: event.platform,
      lastSeen: event.receivedAt,
    });

    // 世界名缓存由 handleGetWorldName 的 API fallback 维护（含 TTL 过期），
    // 这里不写回缓存——否则会把陈旧的缓存名字（如世界改名前的旧名）不断刷新，
    // 导致 updated_at 永远新鲜、TTL 失效。

    if (isSameInstanceRepeat) {
      // 同世界同实例重复（典型来源：好友改 Avatar / 客户端重新同步）→ 只刷新好友状态，
      // 不落事件、不刷动态流：避免把「换模型」呈现成「一直换世界」。
      log.debug(`${displayName} 同实例重复位置，已去重: ${truncateCodePoints(location, 60)}`);
      return;
    }

    this._storeEvent(event, worldName);

    if (worldId && worldId !== 'private' && worldId !== prevWorldId) {
      // 换世界是剩余热路径里最大头（生产实测占日志 26.0%），同样降 debug：
      // DB 事件流 / SSE / 看板不受影响（events 表照常落库含世界名），
      // 排查用 VRC_MONITOR_LOGGER_LEVEL=debug 恢复。
      // 至此 INFO 日志累计压掉：换世界 26.0% + 上线/下线 22.3% + 头像变更 34.5%。
      log.debug(`${displayName} 换世界 → ${worldName || worldId}`);
    } else {
      log.debug(`${displayName} 位置更新: ${truncateCodePoints(worldName || worldId || location, 60)}`);
    }
  }

  async _handleUserLocation(event) {
    // 自己的位置变化：user-location 事件的 content 没有独立 worldId 字段，
    // 只有 location 字符串（如 "wrld_xxx:123~hidden(usr)~region(jp)"），
    // 从 location 解析 worldId 落库，便于查询自己的世界访问历史。
    const location = event.location || '';
    const worldId = location.startsWith('wrld_') ? location.split(':')[0] : '';
    const worldName = worldId ? await this._resolveWorldName(worldId) : '';
    // 仅存事件（不 upsertFriend——user-location 是自己的位置，不更新好友状态表）
    this._storeEvent({ ...event, worldId }, worldName);
    log.debug(`我的位置: ${truncateCodePoints(location, 60)}`);
    // 逛过的世界同步标记 world_kb.visited（2026-08-12 修复）：
    // 之前 visited 只在 scan_new_worlds 时更新，用户逛过但没再扫描的世界会一直标"未逛"，
    // 导致 get_new_worlds(onlyUnvisited) 把已逛的世界当新世界推荐。此处事件驱动回写，逛完即标记。
    // 同时清 backlog（2026-08-24 修复）：add_to_backlog 描述称「location 事件自动清除」，实际
    // 仅靠 pending 视图过滤（WHERE visited=0），backlog 标志从不归零，导致"已逛但仍标待逛"残留。
    // 此处只要世界在待逛列表（backlog=1）就清 backlog=0（含"已逛过、再加回待逛、再次访问"的场景）：
    // 首次访问（visited=0）置 visited=1 并刷新 visited_at；再次访问保留原 visited_at，仅清 backlog。
    if (worldId) {
      try {
        this.storage.run(
          `UPDATE world_kb SET
             visited = 1,
             visited_at = CASE WHEN visited = 0 THEN @visited_at ELSE visited_at END,
             backlog = 0
           WHERE world_id = @world_id AND (visited = 0 OR backlog = 1)`,
          { world_id: worldId, visited_at: event.receivedAt || new Date().toISOString() }
        );
      } catch {
        // world_kb 表缺失（旧库）时静默跳过，不影响事件管道
      }
    }
  }

  async _handleUpdate(event) {
    const userId = event.userId;
    const displayName = event.displayName;

    // 好友资料变更追踪（2026-08-19）：friend-update 推送完整 user 对象
    // （currentAvatarImageUrl/bio/statusDescription/userIcon/pronouns 等），
    // 与 friends 表当前快照 diff，变化写入 events（type 与 VRCX 迁移脚本一致：
    // 顶层 friend-update + content_json.type=avatar/status/bio/user_icon/pronouns）。
    // 无历史快照（首次采集）或字段无基线值时只初始化，不误报变更。
    const userObj = event.content && event.content.user ? event.content.user : null;
    if (userObj) {
      // trust 在此层计算：diff 与最终 upsertFriend 都用（tags 优先，见 friend-refresh.js 头注释）
      // 用户 2026-09-22 报「信任等级 … 天天刷」根因：WS 的 user 载荷**可能缺 tags**，
      // 此时若回落到载荷里的 trust_level 字段（VRChat 的部分/过时字段），会把权威值
      // （逐好友 GET /users/{id} → tags 推导，见 friend-refresh.js）覆盖回旧等级，
      // 于是「升级 → 被覆盖 → 下次轮询再报升级」振荡（生产实证：晴天时雨/无敌只因哥哥
      // 库里停在 Known User，而事件里已升 Trusted User）。⇒ 只认 tags 推导；无 tags 视为
      // 未知：既不 diff 也不回写，避免把好数据写坏。
      const trust = trustFromTags(userObj.tags) || '';
      // 新版资料系统：currentAvatar* 已被上游移除，实际字段是 iconUrl（bannerType=avatarBanner 时指向模型图）
      // ⇒ 用旧字段会让 avatarChanged 恒假、永远没有模型变动事件。注意 bannerType 会变：非 avatarBanner 时视为无模型信息。
      let newAvatarUrl = avatarImageUrlFromUser(userObj);   // let：重分类路径要把它置为同文件的模型图 URL（写回基线用）
      const prev = this.storage.getFriend(userId);
      if (prev && prev.user_id) {
        const changes = [];
        // ⭐ 2026-09-26（审查 🔴 同类问题）：同一个文件的不同 URL 形态（…/1/256 ↔ …/1/512）不应算作「换了模型」——
        //   否则每次推送都会再产一条 avatar 事件 ⇒ 优先按 file id 比较；解析不出 id 时才退回字符串比较（不放大语义）。
        const prevAvatarFileId = avatarFileId(prev.avatar_image_url || '');
        const newAvatarFileId = avatarFileId(newAvatarUrl || '');
        const avatarChanged = newAvatarUrl !== undefined && prev.avatar_image_url
          && (newAvatarFileId && prevAvatarFileId
            ? newAvatarFileId !== prevAvatarFileId
            : (prev.avatar_image_url || '') !== newAvatarUrl);
        if (avatarChanged) {
          changes.push({ type: 'avatar', payload: {
            avatarName: userObj.currentAvatarName || '',
            avatarImageUrl: newAvatarUrl,
            avatarThumbnailUrl: userObj.currentAvatarThumbnailImageUrl || '',
            previousAvatarImageUrl: prev.avatar_image_url || '',
            // previousAvatarThumbnailUrl 省略：缩略图无独立存储列，无法取到正确旧缩略图，
            // 用完整图 URL 冒充会语义错误（PR #56 审查指出）
          }});
        }
        const bioChanged = prev.bio
          && (prev.bio || '') !== (userObj.bio || '');
        if (bioChanged) {
          changes.push({ type: 'bio', payload: { bio: userObj.bio || '', previousBio: prev.bio || '' } });
        }
        const statusChanged = (prev.status && (prev.status || '') !== (userObj.status || ''))
          || (prev.status_description && (prev.status_description || '') !== (userObj.statusDescription || ''));
        if (statusChanged) {
          changes.push({ type: 'status', payload: {
            status: userObj.status || '',
            statusDescription: userObj.statusDescription || '',
            previousStatus: prev.status || '',
            previousStatusDescription: prev.status_description || '',
          }});
        }
        // 同 newAvatarUrl：用纯函数取值，undefined = 没有图标信息（不产出事件）
        // 不能 diff 上游已移除的 userIcon 字段 —— 它恒 undefined，
        // 基线一旦非空就会每次推送都判为「图标变了」（#251 第二轮审查的阻断项）
        // 载荷里 iconUrl / userIcon 都没有 ⇒ 这条推送【没带图标信息】⇒ 不产出事件（也不动基线）。
        // 若把这种情况当成「图标被移除」，会产出空图事件并把已存的图标基线清空（#259 复审的防御性缺口）。
        const newUserIcon = userIconUrlFromUser(userObj);
        // ⭐ 用户 2026-09-26 定案：「换模型就显示换模型啊。只有只换头像才显示换头像」——
        //   实测（生产 id 17146/17147 同一秒）**换模型**时本层会同时产出 avatar 与 user_icon 两条事件，
        //   且 user_icon 携带的 `userIcon` 与 avatar 的 `avatarImageUrl` **是同一个文件** ⇒ 动态流显示成
        //   「更新了头像图标」（用户截图里的错行）。#263 的 `!isAvatarBanner` 门禁只覆盖 avatarBanner 那一档，
        //   而 `bannerType` 非 avatarBanner 时 `iconUrl` 仍可能是模型图 ⇒ 罩不住。
        //   ⇒ 判据改为【按文件同一性】：本次 `iconUrl` 与任一「模型图字段」指向同一文件时，它是模型图、不是用户图标。
        const iconFileId = avatarFileId(newUserIcon || '');
        const modelFileIds = [
          avatarFileId(newAvatarUrl || ''),
          avatarFileId(userObj.currentAvatarImageUrl || ''),
          avatarFileId(userObj.currentAvatarThumbnailImageUrl || ''),
        ].filter(Boolean);
        const iconIsModelImage = !!iconFileId && modelFileIds.includes(iconFileId);
        // ⭐ 同一条定案的另一半：图标其实就是模型图（同文件）但模型图基线当时为空 ⇒ 该次换模型原本【一条事件都没有】
        //   （只有那条错的「更新了头像图标」）⇒ 这里按【模型变更】补一条 avatar 事件，标签才是「模型变动」✓。
        //   仅在「本次图标与已存模型图基线不同」时补；**判据必须也是【文件级】**（审查 🔴 实测：分类按 file id 而去重按字符串 ⇒
        //   同一文件换 URL 形态（…/1/256 ↔ …/1/512）连推时会每次多补一条）⇒ 用 avatarFileId 比较 ✓。
        //   ⚠️ 已知局限（审查 ⚠️ 要求写明）：文件同一性只能由【模型图字段】建立 ——
        //   若 bannerType 非 avatarBanner **且载荷不带任何 currentAvatar***，仅凭 iconUrl 无法判定它是不是模型图 ⇒
        //   该形态仍会记成 user_icon（本层无更强证据，宁可按字段名语义处理，不猜）。
        //   与 iconChanged 的关系：两者共用 iconIsModelImage —— 这里把「同源图标变化」升格为模型变更，
        //   iconChanged 那边则据此排除它，语义互补、不会双记 ✓。
        if (!avatarChanged && iconIsModelImage && avatarFileId(prev.avatar_image_url || '') !== iconFileId) {
          newAvatarUrl = newUserIcon;   // ★ 写回基线：同一文件的下一次推送不再重复补事件（审查 🔴）
          changes.push({ type: 'avatar', payload: {
            avatarName: userObj.currentAvatarName || '',
            avatarImageUrl: newUserIcon,
            avatarThumbnailUrl: userObj.currentAvatarThumbnailImageUrl || '',
            previousAvatarImageUrl: prev.avatar_image_url || '',
          }});
        }
        // bannerType === 'avatarBanner' 时 iconUrl 指向的【就是当前模型图】（新版资料系统）——
        // 换模型必然改它 ⇒ 若这里再判一次，换一次模型会同时产出「更换模型」+「更新了头像图标」
        // 两条事件，且后者前后常是同一张图（用户实测截图里出现过「更新了头像图标 🍮 → 🍮」）。
        // 该形态下图标变化已由 avatarChanged 覆盖，故不在此重复判。
        const isAvatarBanner = String(userObj.bannerType || '') === 'avatarBanner';
        // 取舍（2026-09-25 审查 💡 指出，如实记录）：本门禁比「同载荷已报 avatar 才跳过」更宽 ——
        //   只要 bannerType=avatarBanner 就永不产 user_icon，副作用是该档下【真实用户图标变更】也不报；
        //   且若 prev.avatar_image_url 基线为空，该次换模型连 avatar 事件也没有（要等基线补上后的下一次才触发）。
        // 为何仍选更宽的判据：该档 iconUrl 与模型图【同源】，本层无法区分「用户改了图标」与「换模型」；
        //   而误报（每次换模型都多一条「更新了头像图标」）是用户明确报障，误漏（改图标不报）无用户可见影响。
        const iconChanged = !isAvatarBanner && !iconIsModelImage
          && prev.user_icon
          && newUserIcon !== undefined
          && (prev.user_icon || '') !== newUserIcon;
        if (iconChanged) {
          changes.push({ type: 'user_icon', payload: { userIcon: newUserIcon, previousUserIcon: prev.user_icon || '' } });
        }
        const pronounsChanged = prev.pronouns
          && (prev.pronouns || '') !== (userObj.pronouns || '');
        if (pronounsChanged) {
          changes.push({ type: 'pronouns', payload: { pronouns: userObj.pronouns || '', previousPronouns: prev.pronouns || '' } });
        }

        // 信任等级（2026-09-15 用户报障）：此前五类资料变更都跟踪、唯独漏了 trust_level——
        // 且回写也不带 trustLevel → 好友等级变化既无事件、基线也永远不更新（生产实证：
        // XIAOFANG小芳已升 Trusted User，库内仍停 Known User）。VRChat 的 user 对象
        // 携带 trust_level（LimitedUser 字段），与其它字段同源 diff 即可。
        const trustChanged = prev.trust_level && trust
          && (prev.trust_level || '') !== trust;
        if (trustChanged) {
          changes.push({ type: 'trust_level', payload: {
            trustLevel: trust,
            previousTrustLevel: prev.trust_level || '',
          }});
        }
        for (const c of changes) {
          this.storage.insertEvent({
            type: 'friend-update',
            userId,
            displayName,
            contentJson: { userId, displayName, type: c.type, ...c.payload },
            worldId: '',
            worldName: '',
            createdAt: event.receivedAt,
            source: 'websocket',
          });

          switch (c.type) {
            case 'avatar': {
              // 头像变更是热路径（实测单好友 5 分钟窗口最多 26 条 ≈ 12 秒一条、2 天 683 条，
              // 占日志 34.5%），逐条 INFO 信噪比过低；且 DB 事件流已完整记录
              // （get_friend_profile_changes / 看板「Avatar/头像变更」页可查全量含新旧图 URL），
              // 日志层无需逐条回显。需要排查时用 VRC_MONITOR_LOGGER_LEVEL=debug 打开。
              // 先例：core/http-server.js:13「MCP 协议层请求日志默认降为 debug 级避免 ping/keepalive 刷屏」。
              log.debug(`${displayName} 头像变更`);
              break;
            }
            case 'bio': {
              const prevBio = truncateCodePoints(c.payload.previousBio, 40);
              const newBio = truncateCodePoints(c.payload.bio, 40);
              log.info(`${displayName} bio变更: ${prevBio} → ${newBio}`);
              break;
            }
            case 'status': {
              const prevSt = truncateCodePoints(`${c.payload.previousStatus || ''} ${c.payload.previousStatusDescription || ''}`.trim(), 80);
              const newSt = truncateCodePoints(`${c.payload.status || ''} ${c.payload.statusDescription || ''}`.trim(), 80);
              log.info(`${displayName} 状态变更: ${prevSt || '(无)'} → ${newSt || '(无)'}`);
              break;
            }
            case 'user_icon': {
              log.info(`${displayName} 头像框变更`);
              break;
            }
            case 'pronouns': {
              const prevPr = c.payload.previousPronouns || '';
              const newPr = c.payload.pronouns || '';
              log.info(`${displayName} 代词变更: ${prevPr} → ${newPr}`);
              break;
            }
            case 'trust_level': {
              log.info(`${displayName} 等级变更: ${c.payload.previousTrustLevel || '(无)'} → ${c.payload.trustLevel || '(无)'}`);
              break;
            }
          }
        }
      }

      this.storage.upsertFriend({
        userId,
        displayName,
        status: userObj.status || '',
        statusDescription: userObj.statusDescription || '',
        ...(newAvatarUrl ? { avatarImageUrl: newAvatarUrl } : {}),   // 取不到就不写该列（partial，不清空已存基线）；重分类时上面已把 newAvatarUrl 置为模型图 ⇒ 幂等
        bio: userObj.bio || '',
        ...(userObj.iconUrl || userObj.userIcon ? { userIcon: userObj.iconUrl || userObj.userIcon } : {}),
        pronouns: userObj.pronouns || '',
        ...(trust ? { trustLevel: trust } : {}),
        lastSeen: event.receivedAt,
      });
    } else {
      this.storage.upsertFriend({
        userId,
        displayName,
        lastSeen: event.receivedAt,
      });
    }
    // diff 之后回写权威资料（只补非空字段，幂等；顺序关键——先 diff 再写，否则基线被覆盖丢变更）。
    // 注：上方 L297 已写过同批字段，此处为防御性补漏——若将来主写入路径收窄/字段缺项，
    // 非空字段仍会被补齐（无 user 对象时跳过，不影响既有值）。
    this._syncProfileFromEvent(userId, userObj);

    this._storeEvent(event);
  }

  /**
   * 事件携带的 user 对象 → friends 表资料回写（只写非空字段，避免部分 upsert 清空既有值）。
   * 2026-09-13 用户实测 bug：_handleOnline 曾硬编码 status:'active'，好友上线事件把状态
   * 无条件重置为「在线」(绿灯)——实际状态 ask me(橙) 被覆盖；而 friend-update 只记录变更
   * 事件、不落库（当 user 对象缺失时）。事件里的 user 对象是权威当前快照，必须落库。
   */
  _syncProfileFromEvent(userId, userObj) {
    if (!userObj || typeof userObj !== 'object') {
      log.debug(`[资料回写] 跳过（事件无 user 对象）: ${userId}`);
      return;
    }
    const patch = { userId };
    const put = (key, val) => { if (val !== undefined && val !== null && val !== '') patch[key] = val; };
    put('displayName', userObj.displayName);
    put('status', userObj.status);
    put('statusDescription', userObj.statusDescription);
    put('bio', userObj.bio);
    // 同上：新版资料系统用 iconUrl（bannerType=avatarBanner 时指向模型图），旧字段已被上游移除
    const syncAvatarUrl = avatarImageUrlFromUser(userObj)
      || userObj.currentAvatarThumbnailImageUrl || '';
    put('avatarImageUrl', syncAvatarUrl);
    put('userIcon', userObj.iconUrl || userObj.userIcon);
    put('pronouns', userObj.pronouns);
    if (Object.keys(patch).length > 1) {
      try {
        this.storage.upsertFriend(patch);
        const fields = Object.keys(patch).filter((k) => k !== 'userId').join('/');
        log.debug(`[资料回写] ${String(patch.displayName || userId)}: ${fields}`);
      } catch (e) {
        // 降级路径留痕：回写属增强，失败不阻断主流程但必须可见
        log(`[资料回写] 失败（不影响主流程）: ${userId} ${String((e && e.message) || e)}`);
      }
    }
  }

  async _handleActive(event) {
    const userId = event.userId;
    this._syncProfileFromEvent(userId, event.content && event.content.user);

    // 网页端在线（2026-09-10 用户实测：好友转网页在线时 VRChat 不发 friend-offline，
    // 只发 platform=web 的 friend-active；REST 快照同口径 location='offline'+platform='web'）。
    // 不清位置的话 friends 表残留最后进房的世界 → dashboard 仍显示在某世界（假在线位置）。
    // nativemobile 语义待确认（#181 审查：审查方部署 7 天 592 条/我方 0 样本，盲扩有误清
    // 真实位置风险）→ 跟进 issue 单独核实后再纳入 isWebPresence。
    this.storage.upsertFriend({
      userId,
      isOnline: true,
      lastSeen: event.receivedAt,
      ...(isWebPresence(event.platform) ? { platform: 'web', location: 'offline', worldId: '', worldName: '' } : {}),
    });

    this._storeEvent(event);
  }

  async _handleAdd(event) {
    this._storeEvent(event);
    // 加好友联动：该人已是好友 → 从非好友追踪移出（软删除 removed_at 标记）。
    // 与 _handleDelete 的重新激活成对：加好友移出、删好友激活，tracked 列表始终只含"非好友"。
    // 不在 tracked 则无操作（好友不需要追踪条目）。
    try {
      if (event.userId && String(event.userId).startsWith('usr_')) {
        this.storage.run(
          `UPDATE tracked_non_friends SET removed_at = datetime('now') WHERE user_id = $u AND removed_at = ''`,
          { $u: event.userId });
      }
    } catch { /* 联动失败不影响事件记录 */ }
  }

  async _handleDelete(event) {
    this._storeEvent(event);
    // issue #127 补漏：friend-delete 只存事件不移除好友 → 解友的用户（如维护者删除某人）残留在
    // friends 表，继续显示在 dashboard 好友列表（名字常为空显示 '?'）。friend-delete 应同步从
    // friends 表移除该好友（事件历史/同屏数据在 events 表，不受影响；若日后重新加好友，friend-add 会重建）。
    try {
      if (event.userId) this.storage.run('DELETE FROM friends WHERE user_id = $u', { $u: event.userId });
    } catch { /* 移除失败不影响事件记录 */ }
    // 删好友联动：被删好友即时进入非好友追踪（此前需等重启自动导入，运行期存在追踪空窗）。
    // ① 从未 tracked → 新增；② 手动移除过（removed_at != ''）→ 重新激活（重新成为"历史非好友"）。
    // display_name 用事件携带值，后续定时刷新会以 /users/{id} 资料覆盖。
    try {
      if (event.userId && String(event.userId).startsWith('usr_')) {
        this.storage.run(
          `INSERT INTO tracked_non_friends (user_id, display_name) VALUES ($u, $d)
           ON CONFLICT(user_id) DO UPDATE SET removed_at = '', fail_count = 0`,
          { $u: event.userId, $d: event.displayName || '' });
      }
    } catch { /* 联动失败不影响事件记录 */ }
  }

  async _handleNotification(event) {
    // 通知只存储，不更新好友状态
    this._storeEvent(event);
  }

  // ── 辅助方法 ──

  _storeEvent(event, worldName = '') {
    this.storage.insertEvent({
      type: event.type,
      userId: event.userId || '',
      displayName: event.displayName || '',
      contentJson: event.content || {},
      worldId: event.worldId || '',
      worldName: worldName || '',
      createdAt: event.receivedAt,
      source: 'websocket',
    });

    // 每 100 个事件持久化一次
    if (this._eventCount % 100 === 0) {
      this.storage.save();
    }

    // SSE 实时推送：事件已落库。富化 DTO——补上头像/昵称/状态/位置等前端渲染所需字段，
    // 让前端收到即可增量更新，不必再全量拉 /events /friends /me（2026-09-01 SSE 增量改造）。
    if (typeof this.onStoredEvent === 'function') {
      try {
        const dto = {
          type: event.type,
          userId: event.userId || '',
          displayName: event.displayName || '',
          worldId: event.worldId || '',
          worldName: worldName || '',
          createdAt: event.receivedAt,
        };
        if (event.updateType) dto.updateType = event.updateType;
        // 富化：好友资料行（头像/状态/平台/信任等级/在线）+ 昵称
        const fr = this._getFriendEnriched(dto.userId);
        if (fr) {
          dto.avatarUrl = avatarOf(fr.userIcon, fr.avatar_image_url) || '';
          dto.userIcon = avatarThumb(fr.userIcon) || '';
          dto.status = fr.status || '';
          dto.statusDescription = fr.status_description || '';
          dto.platform = fr.platform || '';
          dto.trustLevel = fr.trust_level || '';
          dto.isOnline = !!fr.is_online;
          dto.memo = fr.memo || '';
          dto.bio = fr.bio || '';
          dto.pronouns = fr.pronouns || '';
          dto.nickname = fr._nickname || '';
        }
        this.onStoredEvent(dto);
      } catch {
        // 广播失败不能影响主流程
      }
    }
  }

  async _resolveWorldName(worldId) {
    if (!worldId || worldId === 'private') return '';
    
    // 查缓存
    const cached = this.storage.getWorldName(worldId);
    if (cached) return cached.name;

    return '';  // 名字通过外部 API 按需查
  }

  // 取好友资料行（供 SSE 富化 DTO）+ 昵称，带 5s 内存缓存避免高频事件时反复查库。
  // 返回 { row 字段..., _nickname }；非好友/无记录返回 null。
  _getFriendEnriched(userId) {
    if (!userId) return null;
    const now = Date.now();
    const hit = this._friendCache.get(userId);
    if (hit && (now - hit.at) < this._FRIEND_CACHE_TTL) return hit.row;
    try {
      const row = this.storage.getFriend(userId);
      if (!row) return null;
      let nickname = '';
      try {
        const nk = this.storage.getNicknames({ userId });
        if (nk && nk[0]) nickname = nk[0].nickname || '';
      } catch { /* 昵称查不到不影响 */ }
      const enriched = { ...row, _nickname: nickname };
      this._friendCache.set(userId, { row: enriched, at: now });
      return enriched;
    } catch { return null; }
  }

  /** 保存到磁盘 */
  flush() {
    this.storage.save();
  }
}
