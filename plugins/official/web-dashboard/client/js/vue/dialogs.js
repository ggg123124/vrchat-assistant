// Vue 弹窗组件库：对齐官方 VRCX UserDialog / WorldDialog / AvatarDialog / GroupDialog / QuickSearch / ImagePreview / Toast
(function () {
  if (typeof Vue === 'undefined') return;

  // ── 1. UserDialog (玩家详细资料弹窗，完全对齐 VRCX 1:1 用户卡片) ──
  const UserDialog = {
    template: `<div v-if="store.userModal" class="modal-mask" @click.self="close">
      <div class="modal user-dialog-vrcx">
        <div class="modal-head">
          <b class="modal-title">{{ user.displayName || '玩家详情' }}</b>
          <button class="icon-btn" @click="close" title="关闭">✕</button>
        </div>

        <div class="modal-tabs">
          <button :class="{ active: curTab === 'info' }" @click="switchTab('info')">信息</button>
          <button :class="{ active: curTab === 'activity' }" @click="switchTab('activity')">活动记录</button>
          <button :class="{ active: curTab === 'pair' }" @click="switchTab('pair')">同屏统计</button>
          <button :class="{ active: curTab === 'groups' }" @click="switchTab('groups')">所属群组 ({{ userGroups.length || (user.representedGroup ? 1 : 0) }})</button>
          <button :class="{ active: curTab === 'worlds' }" @click="switchTab('worlds')">创建的世界 ({{ authorWorlds.length }})</button>
          <button :class="{ active: curTab === 'changes' }" @click="switchTab('changes')">资料变化</button>
          <button :class="{ active: curTab === 'json' }" @click="switchTab('json')">原始 JSON</button>
        </div>

        <div class="modal-body" style="max-height: calc(85vh - 120px); overflow-y: auto">
          <!-- ─── 顶部全景资料卡片 (1:1 VRCX 标准) ─── -->
          <div class="user-profile-header-card">
            <!-- 左侧大头像 -->
            <div class="uph-avatar-wrap" :style="{ borderColor: trustColor(user.trustLevel) }" @click="openPreview(user.avatarImageUrl || user.userIcon)">
              <img class="uph-avatar zoomable" :src="user.avatarImageUrl || user.userIcon" @error="handleError" alt="">
            </div>

            <!-- 主文本信息 -->
            <div class="uph-main">
              <!-- 名字、代词、国旗 -->
              <div class="uph-name-line">
                <span class="uph-name" :style="{ color: trustColor(user.trustLevel) }">{{ user.displayName || '未知玩家' }}</span>
                <span v-if="user.pronouns" class="uph-pronouns">{{ user.pronouns }}</span>
                <div class="uph-flags">
                  <span v-for="flag in languageFlags" :key="flag" :title="flag">{{ flag }}</span>
                </div>
              </div>

              <!-- 徽章行 (信任等级, 18+, 平台, 好友) -->
              <div class="uph-badges-row">
                <span class="trust-badge" :class="trustBadgeClass(user.trustLevel)">{{ trustLabel(user.trustLevel) }}</span>
                <span v-if="user.ageVerified || isAgeGated" class="trust-badge tb-blue">🔞 18+</span>
                <span v-if="user.lastPlatform" class="trust-badge tb-gray">{{ platformLabel(user.lastPlatform) }}</span>
                <span v-if="user.isFriend" class="trust-badge tb-green">好友</span>
              </div>

              <!-- 在线状态指示灯、状态描述 / 签名与当前所在世界 -->
              <div class="uph-status-desc">
                <i class="status-dot-inline" :class="'sd-' + statusOf(user)"></i>
                <span>{{ user.statusDescription || statusStateName(user) }}</span>
                <span v-if="user.worldName && user.isOnline" class="uph-status-loc">
                  · 在 <b style="color: var(--accent); cursor: pointer" @click="openWorld(user.worldId)">{{ user.worldName }}</b>
                  <span v-if="user.instanceId" class="instance-chip">#{{ user.instanceId }}</span>
                </span>
              </div>

              <!-- 玩家官方勋章展示 (Badges) -->
              <div v-if="userBadges.length" class="user-badges-container">
                <div v-for="b in userBadges" :key="b.badgeId || b.badgeName" class="user-badge-pill" :title="b.badgeDescription || b.badgeName">
                  <img v-if="b.badgeImageUrl" :src="b.badgeImageUrl" @error="handleError" alt="">
                  <span>🏅 {{ b.badgeName }}</span>
                </div>
              </div>

              <!-- 模型与展示群组 -->
              <div class="uph-sub-info">
                <div class="uph-sub-item">
                  <span>正在使用的模型:</span>
                  <b style="color: var(--text-main); cursor: pointer" @click="openAvatarPreview(user)">{{ avatarName }} {{ user.allowAvatarCopying ? '🔓' : '🔒' }}</b>
                </div>
                <div v-if="user.representedGroup" class="uph-sub-item" @click="openGroup(user.representedGroup.id)" style="cursor: pointer">
                  <span>展示群组:</span>
                  <b style="color: var(--accent)">{{ user.representedGroup.name }} {{ user.representedGroup.memberCount ? '(' + user.representedGroup.memberCount + ')' : '' }}</b>
                </div>
              </div>

              <!-- 当前所在房间深度卡片 (房主、人数、同房好友) -->
              <div v-if="user.isOnline && (user.worldName || user.location)" class="user-room-instance-box">
                <div class="user-room-meta-row">
                  <span>🏷 房间模式: <b style="color: var(--text-main)">{{ instanceInfo.instanceType || 'Public' }}</b> ({{ instanceInfo.region || 'US' }})</span>
                  <span v-if="instanceInfo.creatorId">👑 房主: <b style="color: var(--accent); cursor: pointer" @click="openUser(instanceInfo.creatorId)">{{ creatorDisplayName }}</b></span>
                </div>
                <!-- 房间内其他好友 -->
                <div v-if="inRoomFriends.length" class="in-room-friends-row">
                  <span>👫 房间内好友 ({{ inRoomFriends.length }}人):</span>
                  <div v-for="rf in inRoomFriends" :key="rf.userId" class="in-room-friend-chip" @click="openUser(rf.userId)" :title="'点击查看 ' + rf.displayName">
                    <img :src="rf.userIcon || rf.currentAvatarImageUrl" @error="handleError" alt="">
                    <b :style="{ color: trustColor(rf.trustLevel) }">{{ rf.displayName }}</b>
                  </div>
                </div>
              </div>
            </div>

            <!-- 右侧头像展示图与快捷操作 -->
            <div class="uph-right-actions">
              <img v-if="user.profilePicOverride || user.currentAvatarImageUrl" class="uph-pic-override zoomable" :src="user.profilePicOverride || user.currentAvatarImageUrl" @error="handleError" @click="openPreview(user.profilePicOverride || user.currentAvatarImageUrl)" alt="">
              <button class="btn-xs" @click="editNickname(user.userId)" title="修改本地备注">✏ 备注</button>
              <button v-if="user.isFriend" class="btn-xs" @click="requestInvite(user.userId)" title="请求邀请">✉ 请求邀请</button>
            </div>
          </div>

          <!-- ─── TAB 1: 信息 (Info) ─── -->
          <div v-if="curTab === 'info'">
            <!-- 个人简介 (Terminal 绿色框高亮) -->
            <div class="user-bio-section">
              <div class="user-bio-head">个人简介 (Bio)</div>
              <div v-if="user.bio" class="user-bio-content">{{ user.bio }}</div>
              <div v-else class="text-xs text-muted" style="padding: 4px 0">该玩家未设置个人简介</div>

              <!-- 外部社交链接 -->
              <div v-if="user.bioLinks && user.bioLinks.length" class="user-bio-links mt-2">
                <a v-for="link in user.bioLinks" :key="link" :href="link" target="_blank" rel="noopener" class="bio-link-pill">
                  <span>🔗 {{ formatLinkName(link) }}</span>
                </a>
              </div>
            </div>

            <!-- 8格数据指标矩阵 (最后见面/相遇次数/游玩时长/离线时长/注册时间/添加好友时间/克隆权限) -->
            <div class="user-stats-matrix">
              <div class="us-stat-card">
                <span>最后见面时间</span>
                <b>{{ lastSeenText }}</b>
              </div>
              <div class="us-stat-card">
                <span>见面的次数</span>
                <b>{{ (pairData && pairData.matchCount) || (user.pairStats && user.pairStats.matchCount) || user.timesMet || 0 }} 次</b>
              </div>
              <div class="us-stat-card">
                <span>一起游玩的时长</span>
                <b>{{ playTimeText }}</b>
              </div>
              <div class="us-stat-card">
                <span>离线时长</span>
                <b>{{ offlineDurationText }}</b>
              </div>
              <div class="us-stat-card">
                <span>最后活动时间</span>
                <b>{{ lastActivityText }}</b>
              </div>
              <div class="us-stat-card">
                <span>账号创建日期</span>
                <b>{{ formatDate(user.dateJoined || user.createdAt) }}</b>
              </div>
              <div class="us-stat-card">
                <span>添加为好友的时间</span>
                <b>{{ friendAddedText }}</b>
              </div>
              <div class="us-stat-card">
                <span>是否允许克隆模型</span>
                <b>{{ user.allowAvatarCopying ? '允许克隆' : '不允许克隆' }}</b>
              </div>
            </div>

            <!-- 玩家 ID 复制栏 -->
            <div class="user-id-bar">
              <div class="uid-text">
                <span>玩家 ID:</span>
                <code>{{ user.userId || user.id }}</code>
              </div>
              <button class="btn-xs" @click="copyId(user.userId || user.id)">📋 复制 ID</button>
            </div>
          </div>

          <!-- ─── TAB 2: 活动记录 (Activity) ─── -->
          <div v-else-if="curTab === 'activity'">
            <div v-if="activityLoading" class="empty">正在加载活动记录…</div>
            <div v-else-if="activities.length" class="history-list">
              <div v-for="ev in activities" :key="ev.id || ev.created_at" class="hl-item">
                <span class="hl-type-pill" :class="'type-' + (ev.type || 'info')">{{ typeName(ev.type) }}</span>
                <span class="hl-time">{{ formatTime(ev.created_at || ev.createdAt) }}</span>
                <span class="hl-desc">
                  <span v-if="ev.worldName">在 <b style="color: var(--accent); cursor: pointer" @click="openWorld(ev.worldId)">{{ ev.worldName }}</b></span>
                  <span v-if="ev.avatarName">更换模型为 <b style="color: var(--text-main)">{{ ev.avatarName }}</b></span>
                  <span v-if="!ev.worldName && !ev.avatarName">{{ ev.description || ev.content || '状态更新' }}</span>
                </span>
              </div>
            </div>
            <div v-else class="empty">暂无该玩家活动记录</div>
          </div>

          <!-- ─── TAB 3: 同屏统计与灯色分布 (Pair Screen & Status Lights) ─── -->
          <div v-else-if="curTab === 'pair'">
            <div v-if="pairLoading" class="empty">正在统计同屏与灯色数据…</div>
            <div v-else-if="pairData">
              <!-- 灯色分布卡片 (Status Breakdown) -->
              <div v-if="pairData.statusBreakdown" class="status-breakdown-card">
                <div style="display: flex; justify-content: space-between; align-items: center">
                  <b style="font-size: 12px; color: var(--text-main)">🌈 历史状态与灯色分布</b>
                  <span style="font-size: 11px; color: var(--text-dim)">基于近期动态采样</span>
                </div>
                <!-- 进度条 -->
                <div class="status-breakdown-bar">
                  <div class="status-bar-seg s-active" :style="{ width: (pairData.statusBreakdown.active || 0) + '%' }" :title="'在线 (Active): ' + pairData.statusBreakdown.active + '%'"></div>
                  <div class="status-bar-seg s-joinme" :style="{ width: (pairData.statusBreakdown.joinme || 0) + '%' }" :title="'加入我 (Join Me): ' + pairData.statusBreakdown.joinme + '%'"></div>
                  <div class="status-bar-seg s-askme" :style="{ width: (pairData.statusBreakdown.askme || 0) + '%' }" :title="'问问我 (Ask Me): ' + pairData.statusBreakdown.askme + '%'"></div>
                  <div class="status-bar-seg s-busy" :style="{ width: (pairData.statusBreakdown.busy || 0) + '%' }" :title="'忙碌 (Busy): ' + pairData.statusBreakdown.busy + '%'"></div>
                  <div class="status-bar-seg s-offline" :style="{ width: (pairData.statusBreakdown.offline || 0) + '%' }" :title="'离线 (Offline): ' + pairData.statusBreakdown.offline + '%'"></div>
                </div>
                <!-- 图例说明 -->
                <div class="status-breakdown-legend">
                  <span class="status-legend-item"><i style="background: var(--s-active)"></i> 在线 {{ pairData.statusBreakdown.active }}%</span>
                  <span class="status-legend-item"><i style="background: var(--s-joinme)"></i> 加入我 {{ pairData.statusBreakdown.joinme }}%</span>
                  <span class="status-legend-item"><i style="background: var(--s-askme)"></i> 问问我 {{ pairData.statusBreakdown.askme }}%</span>
                  <span class="status-legend-item"><i style="background: var(--s-busy)"></i> 忙碌 {{ pairData.statusBreakdown.busy }}%</span>
                  <span class="status-legend-item"><i style="background: var(--s-offline)"></i> 离线 {{ pairData.statusBreakdown.offline }}%</span>
                </div>
              </div>

              <!-- 统计数值面板 -->
              <div class="user-stats-matrix mb-3">
                <div class="us-stat-card">
                  <span>相遇次数</span>
                  <b style="color: var(--accent)">{{ pairData.matchCount || 0 }} 次</b>
                </div>
                <div class="us-stat-card">
                  <span>累计游玩时长</span>
                  <b style="color: #52c41a">{{ formatMins(pairData.totalMinutes) }}</b>
                </div>
                <div class="us-stat-card">
                  <span>共同走过世界数</span>
                  <b>{{ (pairData.worlds && pairData.worlds.length) || 0 }} 个</b>
                </div>
              </div>

              <!-- 共同足迹世界列表 -->
              <div v-if="pairData.worlds && pairData.worlds.length" class="history-list">
                <div v-for="pw in pairData.worlds" :key="pw.worldId || pw.worldName" class="hl-item">
                  <span class="hl-time">{{ pw.lastVisit ? formatTime(pw.lastVisit) : '曾一起游玩' }}</span>
                  <span class="hl-desc">
                    在 <b style="color: var(--accent); cursor: pointer" @click="openWorld(pw.worldId)">{{ pw.worldName }}</b>
                    <span v-if="pw.minutes"> (累计 {{ formatMins(pw.minutes) }})</span>
                  </span>
                </div>
              </div>
              <div v-else class="empty">暂无共同游玩记录</div>
            </div>
            <div v-else class="empty">暂无同屏统计数据</div>
          </div>

          <!-- ─── TAB 4: 所属群组 (Groups) ─── -->
          <div v-else-if="curTab === 'groups'">
            <div v-if="groupsLoading" class="empty">正在加载群组列表…</div>
            <div v-else-if="userGroups.length" class="fav-grid">
              <div v-for="g in userGroups" :key="g.id || g.groupId" class="fav-card" @click="openGroup(g.id || g.groupId)">
                <img class="fav-cover" :src="g.bannerUrl || g.iconUrl" @error="handleError" alt="">
                <div class="fc-body">
                  <b>{{ g.name || g.groupId }}</b>
                  <small>{{ g.memberCount ? g.memberCount + ' 成员' : '' }} {{ g.shortCode ? ' · #' + g.shortCode : '' }}</small>
                </div>
              </div>
            </div>
            <div v-else class="empty">该玩家暂无公开群组</div>
          </div>

          <!-- ─── TAB 5: 创建的世界 (Author Worlds) ─── -->
          <div v-else-if="curTab === 'worlds'">
            <div v-if="worldsLoading" class="empty">正在查询该玩家创建的世界…</div>
            <div v-else-if="authorWorlds.length" class="author-worlds-grid">
              <div v-for="w in authorWorlds" :key="w.worldId || w.id" class="author-world-card" @click="openWorld(w.worldId || w.id)">
                <img :src="w.imageUrl || w.thumbnailImageUrl" @error="handleError" alt="" loading="lazy">
                <div class="aw-body">
                  <b>{{ w.name }}</b>
                  <small>⭐ {{ w.favorites || 0 }} 收藏 · 👥 {{ w.capacity ? w.capacity + '人' : '' }}</small>
                </div>
              </div>
            </div>
            <div v-else class="empty">该玩家尚未发布公开世界</div>
          </div>

          <!-- ─── TAB 6: 资料变化 (Profile Changes) ─── -->
          <div v-else-if="curTab === 'changes'">
            <div v-if="changesLoading" class="empty">正在加载资料历史…</div>
            <div v-else-if="changes.length" class="history-list">
              <div v-for="c in changes" :key="c.id || c.created_at" class="hl-item">
                <span class="hl-time">{{ formatTime(c.created_at || c.createdAt) }}</span>
                <span class="hl-desc">{{ c.description || c.type || '资料变更' }}</span>
              </div>
            </div>
            <div v-else class="empty">暂无该玩家资料变更记录</div>
          </div>

          <!-- ─── TAB 7: 原始 JSON ─── -->
          <div v-else-if="curTab === 'json'">
            <pre class="json-box"><code>{{ JSON.stringify(user, null, 2) }}</code></pre>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        curTab: 'info',
        fullUser: null,
        userLoading: false,
        activities: [],
        activityLoading: false,
        pairData: null,
        pairLoading: false,
        changes: [],
        changesLoading: false,
        userGroups: [],
        groupsLoading: false,
        authorWorlds: [],
        worldsLoading: false,
        instanceInfo: {},
      };
    },
    computed: {
      user() {
        const u = this.store.userModal || {};
        return { ...u, ...(this.fullUser || {}) };
      },
      userBadges() {
        return Array.isArray(this.user.badges) ? this.user.badges : [];
      },
      languageFlags() {
        const tags = this.user.tags || [];
        const flags = [];
        for (const t of tags) {
          if (t === 'language_zho' || t === 'language_chi') flags.push('🇨🇳');
          else if (t === 'language_eng') flags.push('🇺🇸');
          else if (t === 'language_jpn') flags.push('🇯🇵');
          else if (t === 'language_kor') flags.push('🇰🇷');
          else if (t === 'language_fra') flags.push('🇫🇷');
          else if (t === 'language_deu') flags.push('🇩🇪');
          else if (t === 'language_rus') flags.push('🇷🇺');
          else if (t === 'language_spa') flags.push('🇪🇸');
        }
        return flags;
      },
      avatarName() {
        if (this.user.currentAvatarName && this.user.currentAvatarName !== '当前模型') {
          return this.user.currentAvatarName;
        }
        const uid = this.user.userId || this.user.id;
        const evs = (window.__store && window.__store.feedEvents) || [];
        const found = evs.find((e) => (e.userId === uid || e.user_id === uid) && (e.avatarName || e.avatar_name));
        if (found && (found.avatarName || found.avatar_name)) {
          return found.avatarName || found.avatar_name;
        }
        const tags = this.user.currentAvatarTags || [];
        const authorTag = tags.find((t) => t && !t.startsWith('system_'));
        if (authorTag) return authorTag.replace(/^author_tag_/, '');
        return this.user.currentAvatarImageUrl ? '自建模型' : '默认模型';
      },
      creatorDisplayName() {
        if (!this.instanceInfo.creatorId) return '';
        const cid = this.instanceInfo.creatorId;
        const friends = (window.__store && window.__store.friends) || [];
        const f = friends.find((x) => x.userId === cid || x.id === cid);
        return f ? f.displayName : cid;
      },
      inRoomFriends() {
        return this.instanceInfo.inRoomFriends || [];
      },
      isAgeGated() {
        const tags = this.user.tags || [];
        return tags.some((t) => t.includes('age') || t.includes('18'));
      },
      lastSeenText() {
        const t = this.user.lastLogin || this.user.last_login;
        return t ? new Date(t).toLocaleString('zh-CN') : '—';
      },
      playTimeText() {
        const mins = (this.pairData && this.pairData.totalMinutes) || (this.user.pairStats && this.user.pairStats.totalMinutes) || 0;
        return this.formatMins(mins);
      },
      offlineDurationText() {
        if (this.user.isOnline) return '当前在线';
        const t = this.user.lastLogin || this.user.last_login;
        if (!t) return '—';
        const diffMs = Date.now() - new Date(t).getTime();
        if (diffMs < 0) return '刚刚';
        const diffMins = Math.floor(diffMs / 60000);
        const d = Math.floor(diffMins / 1440);
        const h = Math.floor((diffMins % 1440) / 60);
        const m = diffMins % 60;
        if (d > 0) return `${d}天 ${h}小时`;
        if (h > 0) return `${h}小时 ${m}分钟`;
        return `${m}分钟`;
      },
      lastActivityText() {
        const t = this.user.lastActivity || this.user.lastLogin || this.user.last_login;
        if (!t) return '—';
        const diffMs = Date.now() - new Date(t).getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const d = Math.floor(diffMins / 1440);
        const h = Math.floor((diffMins % 1440) / 60);
        const m = diffMins % 60;
        if (d > 0) return `${d}天前`;
        if (h > 0) return `${h}小时前`;
        return `${m}分钟前`;
      },
      friendAddedText() {
        const t = (this.user.pairStats && this.user.pairStats.friendAddedAt) || this.user.dateJoined || this.user.createdAt;
        return t ? new Date(t).toLocaleDateString('zh-CN') : '—';
      },
    },
    watch: {
      'store.userModal': {
        immediate: true,
        handler(val) {
          if (val) {
            this.curTab = 'info';
            this.fullUser = null;
            this.activities = [];
            this.pairData = null;
            this.changes = [];
            this.userGroups = [];
            this.authorWorlds = [];
            this.instanceInfo = {};
            this.fetchUserDetails();
          }
        },
      },
    },
    methods: {
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      close() { this.store.userModal = null; },
      switchTab(t) {
        this.curTab = t;
        if (t === 'activity' && !this.activities.length) this.fetchActivities();
        if (t === 'pair' && !this.pairData) this.fetchPair();
        if (t === 'changes' && !this.changes.length) this.fetchChanges();
        if (t === 'groups' && !this.userGroups.length) this.fetchGroups();
        if (t === 'worlds' && !this.authorWorlds.length) this.fetchAuthorWorlds();
      },
      formatMins(mins) {
        if (!mins) return '0分钟';
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return h > 0 ? `${h}小时 ${m}分钟` : `${m}分钟`;
      },
      async fetchUserDetails() {
        const uid = this.user.userId || this.user.id;
        if (!uid) return;
        this.userLoading = true;
        try {
          const [u, p] = await Promise.allSettled([
            window.__get(`/api/dashboard/user?userId=${encodeURIComponent(uid)}`),
            window.__get(`/api/dashboard/pair-screen?userId=${encodeURIComponent(uid)}&days=90`),
          ]);
          if (u.status === 'fulfilled' && u.value && (u.value.userId || u.value.id)) {
            this.fullUser = u.value;
            // 如果玩家在线且有 location，获取房间深度信息
            if (this.fullUser.location || this.user.location) {
              const loc = this.fullUser.location || this.user.location;
              window.__get(`/api/dashboard/user-instance?userId=${encodeURIComponent(uid)}&location=${encodeURIComponent(loc)}`)
                .then((inst) => { if (inst) this.instanceInfo = inst; })
                .catch(() => {});
            }
          }
          if (p.status === 'fulfilled' && p.value) {
            this.pairData = p.value;
          }
        } catch {}
        finally { this.userLoading = false; }
      },
      async fetchActivities() {
        const uid = this.user.userId || this.user.id;
        if (!uid) return;
        this.activityLoading = true;
        try {
          const d = await window.__get(`/api/dashboard/friend-events?userId=${encodeURIComponent(uid)}&limit=50`);
          this.activities = (d && d.events) || [];
        } catch { this.activities = []; }
        finally { this.activityLoading = false; }
      },
      async fetchPair() {
        const uid = this.user.userId || this.user.id;
        if (!uid) return;
        this.pairLoading = true;
        try {
          const d = await window.__get(`/api/dashboard/pair-screen?userId=${encodeURIComponent(uid)}&days=90`);
          this.pairData = d;
        } catch { this.pairData = null; }
        finally { this.pairLoading = false; }
      },
      async fetchChanges() {
        const uid = this.user.userId || this.user.id;
        if (!uid) return;
        this.changesLoading = true;
        try {
          const d = await window.__get(`/api/dashboard/profile-changes?userId=${encodeURIComponent(uid)}&limit=30`);
          this.changes = (d && (d.changes || d.events)) || [];
        } catch { this.changes = []; }
        finally { this.changesLoading = false; }
      },
      async fetchGroups() {
        const uid = this.user.userId || this.user.id;
        if (!uid) return;
        this.groupsLoading = true;
        try {
          const d = await window.__get(`/api/dashboard/groups?userId=${encodeURIComponent(uid)}`);
          this.userGroups = (d && d.groups) || [];
        } catch { this.userGroups = []; }
        finally { this.groupsLoading = false; }
      },
      async fetchAuthorWorlds() {
        const uid = this.user.userId || this.user.id;
        if (!uid) return;
        this.worldsLoading = true;
        try {
          const d = await window.__get(`/api/dashboard/user-worlds?userId=${encodeURIComponent(uid)}`);
          this.authorWorlds = (d && d.worlds) || [];
        } catch { this.authorWorlds = []; }
        finally { this.worldsLoading = false; }
      },
      copyId(id) {
        if (!id) return;
        navigator.clipboard.writeText(id).then(() => {
          if (window.__toast) window.__toast('已复制玩家 ID');
        }).catch(() => {});
      },
      openPreview(img) {
        if (img && window.openImageModal) window.openImageModal(img);
      },
      openAvatarPreview(u) {
        const img = u.currentAvatarImageUrl || u.avatarImageUrl || u.userIcon;
        if (img) this.openPreview(img);
      },
      openWorld(wid) {
        if (wid && window.openWorld) window.openWorld(wid);
      },
      openUser(uid) {
        if (uid && window.openUser) window.openUser(uid);
      },
      openGroup(gid) {
        if (gid && window.openGroup) window.openGroup(gid);
      },
      editNickname(uid) {
        const n = prompt('请输入本地备注名称:');
        if (n !== null && window.__post) {
          window.__post('/api/dashboard/friends/nickname', { userId: uid, nickname: n.trim() })
            .then(() => { if (window.__toast) window.__toast('备注已保存'); })
            .catch(() => {});
        }
      },
      async requestInvite(uid) {
        if (!uid) return;
        try {
          await window.__post('/api/dashboard/invite-request', { userId: uid });
          if (window.__toast) window.__toast('已向该好友发送邀请请求');
        } catch {
          if (window.__toast) window.__toast('发送邀请请求失败');
        }
      },
      trustColor: (t) => (typeof window.trustColor === 'function' ? window.trustColor(t) : '#8a94a0'),
      trustBadgeClass(t) {
        const v = String(t || '').toLowerCase();
        if (/trusted|veteran/.test(v)) return 'tb-purple';
        if (/known/.test(v)) return 'tb-orange';
        if (/new/.test(v)) return 'tb-blue';
        if (/user/.test(v)) return 'tb-green';
        if (/team|staff/.test(v)) return 'tb-red';
        return 'tb-gray';
      },
      trustLabel(t) {
        const v = String(t || '').toLowerCase();
        if (/trusted|veteran/.test(v)) return 'Trusted User';
        if (/known/.test(v)) return 'Known User';
        if (/new/.test(v)) return 'New User';
        if (/user/.test(v)) return 'User';
        if (/visitor/.test(v)) return 'Visitor';
        return t || 'User';
      },
      platformLabel(p) {
        if (p === 'standalonewindows') return '💻 PC';
        if (p === 'android') return '📱 Android';
        if (p === 'ios') return '🍏 iOS';
        return p || '💻 PC';
      },
      statusOf(u) {
        if (!u) return 'offline';
        if (typeof window.isWebOnline === 'function' && window.isWebOnline(u)) return 'web';
        if (!u.isOnline || u.status === 'offline') return 'offline';
        return String(u.status || 'active').toLowerCase().replace(/\s+/g, '') || 'active';
      },
      statusStateName(u) {
        if (typeof window.isWebOnline === 'function' && window.isWebOnline(u)) return '网页在线';
        if (!u.isOnline || u.status === 'offline') return '离线';
        const s = (u.status || 'active').toLowerCase();
        if (s === 'join me') return '请加入我 (Join Me)';
        if (s === 'ask me') return '问问我 (Ask Me)';
        if (s === 'busy') return '忙碌 (Do Not Disturb)';
        return '在线 (Online)';
      },
      formatDate: (s) => (s ? new Date(s).toLocaleDateString('zh-CN') : '—'),
      formatTime: (s) => (s ? new Date(s).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'),
      formatLinkName(link) {
        if (!link) return '';
        try {
          const u = new URL(link);
          return u.hostname.replace('www.', '');
        } catch { return link.slice(0, 20); }
      },
      typeName(t) {
        const m = { 'friend-online': '🟢 上线', 'friend-offline': '⚪ 下线', 'friend-location': '📍 移动', 'friend-update': '📝 资料' };
        return m[t] || t || '动态';
      },
    },
  };

  const AvatarDialog = {
    template: `<div v-if="store.avatarModal" class="modal-backdrop" @click.self="close">
      <div class="modal-card modal-md">
        <div class="modal-header">
          <b>{{ avatar.name || avatar.avatarId || '模型详情' }}</b>
          <button class="modal-close-btn" @click="close" aria-label="关闭">×</button>
        </div>

        <div class="modal-body-scroll">
          <div v-if="loading" class="empty">加载模型数据中…</div>
          <div v-else>
            <div v-if="proxy(avatar.imageUrl)" class="avatar-banner-cover zoomable" :style="{ backgroundImage: 'url(' + proxy(avatar.imageUrl) + ')' }" @click="openPreview(proxy(avatar.imageUrl))"></div>
            <div class="world-meta-head">
              <h2>{{ avatar.name || '未命名模型' }}</h2>
              <small>{{ avatar.id || avatar.avatarId }}</small>
            </div>

            <div class="user-action-bar">
              <button class="btn-primary-sm" @click="copy(avatar.id || avatar.avatarId)">复制模型 ID</button>
              <button class="btn-secondary-sm" @click="copy('https://vrchat.com/home/avatar/' + (avatar.id || avatar.avatarId))">复制网页链接</button>
            </div>

            <div class="facts-grid mt-3">
              <div v-if="avatar.authorName" class="fact-item"><span>作者</span><b>{{ avatar.authorName }}</b></div>
              <div class="fact-item"><span>发布状态</span><b>{{ avatar.releaseStatus === 'public' ? '公开' : '私有' }}</b></div>
              <div class="fact-item"><span>版本</span><b>v{{ avatar.version || 1 }}</b></div>
              <div class="fact-item"><span>Unity 版本</span><b>{{ avatar.unityVersion || '—' }}</b></div>
            </div>

            <div v-if="avatar.tags && avatar.tags.length" class="tags-section mt-3">
              <label>标签</label>
              <div class="chips">
                <span v-for="tag in avatar.tags" :key="tag" class="chip">{{ tag }}</span>
              </div>
            </div>

            <div v-if="avatar.description" class="bio-section mt-3">
              <label>模型说明</label>
              <p class="bio-text">{{ avatar.description }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        avatar: {},
        loading: false,
      };
    },
    watch: {
      'store.avatarModal': {
        immediate: true,
        handler(val) {
          if (val) this.load();
        },
      },
    },
    methods: {
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      proxy: (u) => (typeof window.proxyImg === 'function' ? window.proxyImg(u) : (u || '')),
      close() { this.store.avatarModal = null; },
      async load() {
        const raw = this.store.avatarModal;
        const aid = typeof raw === 'string' ? raw : raw?.avatarId || raw?.id;
        if (!aid) return;
        this.loading = true;
        try {
          const d = await window.__get(`/api/dashboard/avatar?avatarId=${encodeURIComponent(aid)}`);
          this.avatar = d || {};
        } catch { this.avatar = { avatarId: aid, name: '加载失败' }; }
        finally { this.loading = false; }
      },
      openPreview(url) { if (window.openPreview) window.openPreview(url); },
      copy(t) { if (window.copyText) window.copyText(t); },
    },
  };

  // ── 4. GroupDialog (群组资料弹窗) ──
  const GroupDialog = {
    template: `<div v-if="store.groupModal" class="modal-backdrop" @click.self="close">
      <div class="modal-card modal-md">
        <div class="modal-header">
          <b>{{ group.name || group.groupId || '群组详情' }}</b>
          <button class="modal-close-btn" @click="close" aria-label="关闭">×</button>
        </div>

        <div class="modal-body-scroll">
          <div v-if="loading" class="empty">加载群组数据中…</div>
          <div v-else>
            <div v-if="proxy(group.bannerUrl) || proxy(group.iconUrl)" class="group-banner-cover zoomable" :style="{ backgroundImage: 'url(' + (proxy(group.bannerUrl) || proxy(group.iconUrl)) + ')' }" @click="openPreview(proxy(group.bannerUrl) || proxy(group.iconUrl))"></div>
            <div class="world-meta-head">
              <h2>{{ group.name || '未命名群组' }}</h2>
              <small>{{ group.id || group.groupId }}</small>
            </div>

            <div class="user-action-bar">
              <button class="btn-primary-sm" @click="copy(group.id || group.groupId)">复制群组 ID</button>
              <button class="btn-secondary-sm" @click="copy('https://vrchat.com/home/group/' + (group.id || group.groupId))">复制网页链接</button>
            </div>

            <div class="facts-grid mt-3">
              <div v-if="group.shortCode" class="fact-item"><span>短标识码</span><b>#{{ group.shortCode }}</b></div>
              <div class="fact-item"><span>成员总数</span><b>{{ group.memberCount || 0 }} 人</b></div>
              <div class="fact-item"><span>加入规则</span><b>{{ group.joiningEnabled ? '自由加入' : '需要审批' }}</b></div>
              <div class="fact-item"><span>公开状态</span><b>{{ group.isPublic !== false ? '公开' : '私密' }}</b></div>
            </div>

            <div v-if="group.description" class="bio-section mt-3">
              <label>群组简介</label>
              <p class="bio-text">{{ group.description }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        group: {},
        loading: false,
      };
    },
    watch: {
      'store.groupModal': {
        immediate: true,
        handler(val) {
          if (val) this.load();
        },
      },
    },
    methods: {
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      proxy: (u) => (typeof window.proxyImg === 'function' ? window.proxyImg(u) : (u || '')),
      close() { this.store.groupModal = null; },
      async load() {
        const raw = this.store.groupModal;
        const gid = typeof raw === 'string' ? raw : raw?.groupId || raw?.id;
        if (!gid) return;
        this.loading = true;
        try {
          const d = await window.__get(`/api/dashboard/group?groupId=${encodeURIComponent(gid)}`);
          this.group = d || {};
        } catch { this.group = { groupId: gid, name: '加载失败' }; }
        finally { this.loading = false; }
      },
      openPreview(url) { if (window.openPreview) window.openPreview(url); },
      copy(t) { if (window.copyText) window.copyText(t); },
    },
  };

  // ── 5. QuickSearchDialog (全局 Ctrl+K 快速搜索) ──
  // ── WorldDialog 世界详情（对齐 VRCX WorldDialog：封面/作者/统计/标签/简介）──
  const WorldDialog = {
    template: `<div v-if="store.worldModal" class="modal-mask" @click.self="close">
      <div class="modal world-dialog-vrcx" style="width:560px">
        <div class="modal-head"><b class="modal-title">{{ w.name || '世界详情' }}</b><button class="icon-btn" @click="close" title="关闭">✕</button></div>
        <div class="modal-body">
          <div v-if="w.imageUrl" class="worldmodal-cover" :style="{backgroundImage:'url('+w.imageUrl+')'}"></div>
          <div class="modalprofile"><b>{{ w.name || '未知世界' }}</b><small>{{ w.worldId }}</small></div>
          <div v-if="stats.length" class="facts"><div v-for="s in stats" :key="s[0]" class="fact"><span>{{ s[0] }}</span><span>{{ s[1] }}</span></div></div>
          <div v-if="w.description" class="modalsection">简介</div>
          <div v-if="w.description" class="modaldesc">{{ w.description }}</div>
          <div v-if="tags.length" class="modalsection">标签</div>
          <div v-if="tags.length" class="chips"><span v-for="t in tags" :key="t" class="chip">{{ t }}</span></div>
          <div v-if="loading" class="empty">加载中…</div>
          <div v-if="error" class="error">{{ error }}</div>
        </div>
      </div>
    </div>`,
    data() { return { store: window.__store, w: {}, loading: false, error: '' }; },
    computed: {
      stats() { const w = this.w, s = []; if (w.capacity) s.push(['人数', w.capacity]); if (w.authorName) s.push(['作者', w.authorName]); if (w.visits != null) s.push(['访问', w.visits]); if (w.favorites != null) s.push(['收藏', w.favorites]); if (w.releaseStatus) s.push(['状态', w.releaseStatus === 'public' ? '公开' : '私有']); return s; },
      tags() { return Array.isArray(this.w.tags) ? this.w.tags : []; },
    },
    watch: { 'store.worldModal'(v) { if (v) this.load(); } },
    methods: {
      close() { this.store.worldModal = null; },
      async load() {
        const id = this.store.worldModal && this.store.worldModal.worldId;
        if (!id) return;
        this.loading = true; this.error = '';
        try { this.w = (await window.__get('/api/dashboard/world?worldId=' + encodeURIComponent(id))) || {}; }
        catch { this.w = {}; this.error = '加载失败，请重试'; }
        finally { this.loading = false; }
      },
    },
  };

  const QuickSearchDialog = {
    template: `<div v-if="store.quickSearchOpen" class="modal-backdrop" @click.self="close">
      <div class="qs-box">
        <div class="qs-head">
          <input ref="inputRef" v-model="q" placeholder="快速搜索好友 / VRChat 用户 / 世界 / 群组… (Esc 关闭)" @keydown.esc="close" @keydown.enter="run">
          <button class="modal-close-btn" @click="close">×</button>
        </div>
        <div class="qs-body">
          <div v-if="localMatches.length" class="qs-group">
            <label>本地好友</label>
            <div v-for="f in localMatches" :key="f.userId" class="qs-row" @click="selectUser(f.userId)">
              <span class="avatar-sm" :style="avatarStyle(f)"></span>
              <b>{{ f.displayName }}</b>
              <small>{{ f.isOnline ? '在线' : '离线' }}</small>
            </div>
          </div>
          <div v-if="remoteUsers.length" class="qs-group">
            <label>VRChat 用户搜索</label>
            <div v-for="u in remoteUsers" :key="u.id || u.userId" class="qs-row" @click="selectUser(u.id || u.userId)">
              <b>{{ u.displayName || u.username }}</b>
              <small>{{ u.id || u.userId }}</small>
            </div>
          </div>
          <div v-if="!localMatches.length && !remoteUsers.length" class="empty">
            {{ q.trim() ? '无匹配结果' : '输入关键词快速查找' }}
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        q: '',
        timer: null,
        remoteUsers: [],
      };
    },
    computed: {
      localMatches() {
        const t = this.q.trim().toLowerCase();
        if (!t) return (this.store.friends || []).slice(0, 6);
        return (this.store.friends || []).filter((f) =>
          (f.displayName || '').toLowerCase().includes(t) || (f.userId || '').includes(t)
        ).slice(0, 8);
      },
    },
    watch: {
      q() {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.searchRemote(), 300);
      },
      'store.quickSearchOpen'(v) {
        if (v) {
          this.q = '';
          this.remoteUsers = [];
          this.$nextTick(() => { if (this.$refs.inputRef) this.$refs.inputRef.focus(); });
        }
      },
    },
    methods: {
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      proxy: (u) => (typeof window.proxyImg === 'function' ? window.proxyImg(u) : (u || '')),
      close() { this.store.quickSearchOpen = false; },
      avatarStyle(f) {
        const u = typeof window.avatarUrlFor === 'function' ? window.avatarUrlFor(f, this.store.friends) : (f.avatarUrl || f.userIcon || '');
        return { backgroundImage: u ? `url('${u}')` : 'none' };
      },
      async searchRemote() {
        const t = this.q.trim().toLowerCase();
        if (t.length < 2) { this.remoteUsers = []; return; }
        try {
          const d = await window.__get(`/api/dashboard/search?q=${encodeURIComponent(t)}&type=users&limit=6`);
          this.remoteUsers = d.users || d.results || [];
        } catch { this.remoteUsers = []; }
      },
      selectUser(uid) {
        if (window.openUser) window.openUser(uid);
        this.close();
      },
    },
  };

  // ── 6. FullscreenImagePreview (全屏图片灯箱) ──
  const FullscreenImagePreview = {
    template: `<div v-if="store.previewUrl" class="image-preview-overlay" @click="close">
      <img :src="store.previewUrl" referrerpolicy="no-referrer" alt="预览" @click.stop>
      <button class="preview-close-btn" @click="close">×</button>
    </div>`,
    data() {
      return { store: window.__store };
    },
    methods: {
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      proxy: (u) => (typeof window.proxyImg === 'function' ? window.proxyImg(u) : (u || '')),
      close() { this.store.previewUrl = null; },
    },
  };

  // ── 7. ToastNotification (全局 Toast 消息提示) ──
  const ToastNotification = {
    template: `<div class="toast-container" :class="{ show: !!store.toastMsg }">
      {{ store.toastMsg }}
    </div>`,
    data() {
      return { store: window.__store };
    },
  };

  window.__dialogs = {
    UserDialog,
    WorldDialog,
    AvatarDialog,
    GroupDialog,
    QuickSearchDialog,
    FullscreenImagePreview,
    ToastNotification,
  };
})();
