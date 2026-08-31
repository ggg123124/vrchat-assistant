// Vue 右侧栏组件：我 + 好友列表与状态预设 (支持直连优先 + 失败自动降级到路由器图片代理)
// 对齐 VRCX FriendsSidebar：顶部 me-item（本人状态/位置）、同实例好友分组、在线按世界分组、收藏、离线
(function () {
  if (typeof Vue === 'undefined') return;

  const RightBar = {
    template: `<div class="rightbar-inner">
      <div class="right-head">
        <span class="rh-title">好友列表</span>
        <span class="num">{{ online.length }} / {{ friends.length }}</span>
      </div>

      <!-- 我（VRCX me-item：当前用户 + 状态 + 位置） -->
      <div v-if="me" class="me-item" @click="openUser(me.userId)" role="button" tabindex="0" @keydown.enter="openUser(me.userId)">
        <img class="avatar-sm" :src="meAvatar(me)" @error="handleError" alt="" loading="lazy">
        <div class="friendtext">
          <div class="ft-name-row">
            <b :style="{ color: trustColor(me.trustLevel) }">{{ me.displayName || me.userId }}</b>
          </div>
          <div class="ft-status-row">
            <i class="status-dot-inline" :class="'sd-' + meStatus(me)"></i>
            <span class="fs-desc">{{ meStatusText(me) }}</span>
            <span v-if="meLocText(me)" class="fs-loc"> · {{ meLocText(me) }}</span>
          </div>
          <div v-if="me.currentAvatarName" class="me-model" :title="'模型 ID: ' + (me.currentAvatar || '')">🧍 {{ me.currentAvatarName }}</div>
        </div>
      </div>

      <input class="side-search" v-model="q" placeholder="搜索好友…" aria-label="搜索好友">

      <!-- 在线好友分组 -->
      <div class="navgroup">
        <span>在线好友</span>
        <span class="group-count">{{ online.length }}</span>
      </div>
      <div class="friendlist">
        <!-- 同实例好友（VRCX same_instance：与我在同一世界实例的好友，置顶高亮） -->
        <div v-if="sameInstance.length" class="worldgroup same-instance">
          <div class="wg-header">
            <span class="wg-ico">◎</span>
            <span class="wg-name" :title="sameInstanceWorldName || '同实例好友'">同实例好友<span v-if="sameInstanceWorldName"> · {{ sameInstanceWorldName }}</span></span>
            <span class="wg-num">{{ sameInstance.length }}</span>
          </div>
          <div v-for="f in sameInstance" :key="f.userId" class="friend online" @click="openUser(f.userId)">
            <img class="avatar-sm" :src="avatarUrl(f)" @error="handleError" alt="" loading="lazy">
            <div class="friendtext">
              <div class="ft-name-row">
                <b :style="{ color: trustColor(f.trustLevel) }">{{ shown(f) }}</b>
              </div>
              <div class="ft-status-row">
                <i class="status-dot-inline" :class="'sd-' + statusOf(f)"></i>
                <span class="fs-desc">{{ statusDesc(f) }}</span>
                <span v-if="locText(f)" class="fs-loc"> · {{ locText(f) }}</span>
              </div>
            </div>
          </div>
        </div>

        <div v-for="g in groups" :key="g.label" class="worldgroup">
          <div class="wg-header">
            <span class="wg-ico">📍</span>
            <span class="wg-name" :title="g.label">{{ g.label }}</span>
            <span class="wg-num">{{ g.list.length }}</span>
          </div>
          <div v-for="f in g.list" :key="f.userId" class="friend online" @click="openUser(f.userId)">
            <img class="avatar-sm" :src="avatarUrl(f)" @error="handleError" alt="" loading="lazy">
            <div class="friendtext">
              <div class="ft-name-row">
                <b :style="{ color: trustColor(f.trustLevel) }">{{ shown(f) }}</b>
              </div>
              <div class="ft-status-row">
                <i class="status-dot-inline" :class="'sd-' + statusOf(f)"></i>
                <span class="fs-desc">{{ statusDesc(f) }}</span>
                <span v-if="locText(f)" class="fs-loc"> · {{ locText(f) }}</span>
              </div>
            </div>
          </div>
        </div>
        <div v-if="!online.length" class="empty-sm">暂无在线好友</div>
      </div>

      <!-- 收藏好友分组 -->
      <div class="navgroup">
        <span>☆ 收藏好友</span>
        <span class="group-count">{{ favorites.length }}</span>
      </div>
      <div class="friendlist">
        <div v-for="f in favorites" :key="f.userId" class="friend" @click="openUser(f.userId)">
          <img class="avatar-sm" :src="avatarUrl(f)" @error="handleError" alt="" loading="lazy">
          <div class="friendtext">
            <div class="ft-name-row">
              <b :style="{ color: trustColor(f.trustLevel) }">{{ shown(f) }}</b>
            </div>
            <div class="ft-status-row">
              <i class="status-dot-inline" :class="'sd-' + statusOf(f)"></i>
              <span class="fs-desc">{{ f.isOnline ? (f.statusDescription || '在线') : '离线' }}</span>
              <span v-if="locText(f)" class="fs-loc"> · {{ locText(f) }}</span>
            </div>
          </div>
        </div>
        <div v-if="!favorites.length" class="empty-sm">暂无收藏好友</div>
      </div>

      <!-- 离线好友分组 -->
      <div class="navgroup">
        <span>离线好友</span>
        <span class="group-count">{{ offline.length }}</span>
      </div>
      <div class="friendlist">
        <div v-for="f in offline" :key="f.userId" class="friend" @click="openUser(f.userId)">
          <img class="avatar-sm" :src="avatarUrl(f)" @error="handleError" alt="" loading="lazy">
          <div class="friendtext">
            <div class="ft-name-row">
              <b :style="{ color: trustColor(f.trustLevel) }">{{ shown(f) }}</b>
            </div>
            <div class="ft-status-row">
              <i class="status-dot-inline sd-offline"></i>
              <span class="fs-desc">离线</span>
            </div>
          </div>
        </div>
        <div v-if="!offline.length" class="empty-sm">暂无离线好友</div>
      </div>

      <!-- 底部状态预设 -->
      <div class="status-preset-box">
        <div class="navgroup" style="padding: 0 0 6px 0">状态预设</div>
        <div class="status-presets">
          <button v-for="s in store.statusPresets" :key="s.v" class="sp-btn" @click="applyStatus(s.v, desc)">{{ s.l }}</button>
        </div>
        <input class="sp-desc" v-model="desc" placeholder="状态描述（可选）…" maxlength="32" @keydown.enter="applyStatus('active', desc)">
        <button class="sp-btn sp-apply" @click="applyStatus('active', desc)">应用当前状态</button>
      </div>
    </div>`,
    data() {
      return {
        store: window.__store,
        q: '',
        desc: '',
      };
    },
    computed: {
      friends() { return this.store.friends || []; },
      me() { return this.store.me || null; },
      qf() {
        const q = this.q.trim().toLowerCase();
        return this.friends.filter((f) =>
          !q || (f.displayName || '').toLowerCase().includes(q) || (f.userId || '').includes(q)
        );
      },
      online() { return this.qf.filter((f) => f.isOnline); },
      offline() { return this.qf.filter((f) => !f.isOnline); },
      favorites() {
        return this.qf.filter((f) => this.store.favFriendIds && this.store.favFriendIds.has(f.userId));
      },
      // 与我在同一世界实例的在线好友（对齐 VRCX friendsInSameInstance）
      sameInstance() {
        const me = this.store.me;
        if (!me || !me.location) return [];
        const myLoc = me.location;
        if (myLoc === 'offline' || myLoc === 'traveling' || !myLoc.includes(':')) return [];
        return this.online.filter((f) => f.location === myLoc);
      },
      sameInstanceWorldName() {
        const f = this.sameInstance[0];
        if (f && f.worldName && f.worldName !== f.worldId) return f.worldName;
        return '';
      },
      // 在线好友按世界实例分组（同实例好友已单独置顶，这里排除避免重复）
      groups() {
        const si = new Set(this.sameInstance.map((f) => f.userId));
        const isWeb = (f) => typeof window.isWebOnline === 'function' ? window.isWebOnline(f) : f.platform === 'web';
        const web = this.online.filter((f) => !si.has(f.userId) && isWeb(f));
        const ing = this.online.filter((f) => !si.has(f.userId) && !isWeb(f));
        const m = new Map();
        for (const f of ing) {
          const k = f.worldId || 'none';
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(f);
        }
        const gs = [...m.entries()].map(([wid, list]) => ({
          label: (list[0].worldName && list[0].worldName !== wid) ? list[0].worldName : (wid === 'none' ? '未公开位置' : wid.slice(0, 14)),
          list,
        }));
        if (web.length) gs.push({ label: '仅网页端在线', list: web });
        return gs;
      },
    },
    methods: {
      openUser(uid) { if (window.openUser) window.openUser(uid); },
      shown(f) { return f.displayName || f.userId || '?'; },
      trustColor: (t) => (typeof window.trustColor === 'function' ? window.trustColor(t) : '#8a94a0'),
      avatarUrl(f) {
        return typeof window.avatarUrlFor === 'function' ? window.avatarUrlFor(f, this.friends) : (f.avatarUrl || f.userIcon || '');
      },
      meAvatar(me) {
        return typeof window.avatarUrlFor === 'function' ? window.avatarUrlFor(me, this.friends) : (me.avatarUrl || me.userIcon || '');
      },
      handleError: (e) => (typeof window.handleImgError === 'function' ? window.handleImgError(e) : null),
      statusOf(f) {
        if (typeof window.isWebOnline === 'function' && window.isWebOnline(f)) return 'web';
        if (!f.isOnline) return 'offline';
        return f.status || 'active';
      },
      statusDesc(f) {
        if (typeof window.isWebOnline === 'function' && window.isWebOnline(f)) return '网页在线';
        if (!f.isOnline) return '离线';
        if (f.statusDescription) return f.statusDescription;
        const labels = { active: '在线', 'join me': '加入我', 'ask me': '问我', busy: '忙碌' };
        return labels[f.status] || '在线';
      },
      locText(f) {
        if (typeof window.isWebOnline === 'function' && window.isWebOnline(f)) return '';
        if (!f.isOnline) return '';
        const inst = typeof window.locLabel === 'function' ? window.locLabel(f.location) : (f.instanceType || '');
        return inst || '';
      },
      meStatus(me) {
        const loc = me.location || '';
        if (loc === 'offline') return 'offline';
        return me.status || 'active';
      },
      meStatusText(me) {
        const loc = me.location || '';
        if (me.travelingToLocation) return '传送中';
        if (loc === 'offline') return '离线';
        if (me.statusDescription) return me.statusDescription;
        const labels = { active: '在线', 'join me': '加入我', 'ask me': '问我', busy: '忙碌' };
        return labels[me.status] || '在线';
      },
      meLocText(me) {
        const loc = me.location || '';
        if (loc === 'offline' || !loc) return '';
        if (me.travelingToLocation) return '';
        const inst = typeof window.locLabel === 'function' ? window.locLabel(loc) : '';
        return inst || '';
      },
      applyStatus(st, desc) {
        if (window.applyStatus) window.applyStatus(st, desc);
      },
    },
  };

  window.__RightBar = RightBar;
})();
