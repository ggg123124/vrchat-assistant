// Vue 3 应用：Dashboard 框架组件化（阶段 1：侧栏导航 + 状态预设）
// 视图渲染由 app.js 的数据函数管理（渐进迁移：后续轮次逐个视图组件化）
(function () {
  if (typeof Vue === 'undefined') return;
  const { createApp } = Vue;

  // ── 侧栏导航 ──
  const SideNav = {
    template: `<div>
      <div class="navgroup">动态与社交</div>
      <div v-for="v in items1" :key="v.view" class="sidelink" :class="{active:v.view===cur}" @click="go(v.view)"><span class="ico">{{v.ico}}</span>{{v.label}}</div>
      <div class="navgroup">数据与工具</div>
      <div v-for="v in items2" :key="v.view" class="sidelink" :class="{active:v.view===cur}" @click="go(v.view)"><span class="ico">{{v.ico}}</span>{{v.label}}</div>
    </div>`,
    data() {
      return {
        cur: 'feed',
        items1: [
          { view: 'feed', ico: '◉', label: '好友动态' },
          { view: 'friends', ico: '◌', label: '好友位置' },
          { view: 'logs', ico: '▤', label: '游戏日志' },
          { view: 'players', ico: '♙', label: '房间玩家列表' },
          { view: 'search', ico: '⌕', label: '搜索' },
          { view: 'favorites', ico: '☆', label: '收藏' },
          { view: 'moderation', ico: '⊘', label: '屏蔽管理' },
        ],
        items2: [
          { view: 'avatars', ico: '◇', label: '我的模型' },
          { view: 'charts', ico: '▥', label: '图表' },
          { view: 'tools', ico: '⚙', label: '工具' },
          { view: 'open', ico: '↗', label: '直接打开' },
        ],
      };
    },
    mounted() {
      const hp = new URLSearchParams(location.hash.replace(/^#/, ''));
      if (hp.get('view')) this.cur = hp.get('view');
    },
    methods: {
      go(view) {
        this.cur = view;
        if (window.__renderView) window.__renderView(view);
      },
    },
  };

  // ── 状态预设 ──
  const StatusPresets = {
    template: `<div>
      <div class="navgroup">状态预设</div>
      <div class="status-presets">
        <button v-for="s in presets" :key="s.v" class="sp-btn" @click="apply(s.v)">{{s.l}}</button>
      </div>
      <input class="sp-desc" v-model="desc" placeholder="状态描述（可选）…" maxlength="32" @keydown.enter="apply('active', desc)">
      <button class="sp-btn sp-apply" @click="apply('active', desc)">应用状态</button>
    </div>`,
    data() {
      return {
        presets: [
          { v: 'active', l: '在线' },
          { v: 'join me', l: '加入我' },
          { v: 'ask me', l: '问我' },
          { v: 'busy', l: '忙碌' },
        ],
        desc: '',
      };
    },
    methods: {
      apply(status, desc) {
        if (window.applyStatus) window.applyStatus(status, desc || '');
      },
    },
  };

  // ── 挂载（容器存在时）──
  const nav = document.querySelector('#vueNav');
  if (nav) createApp(SideNav).mount(nav);
  const pre = document.querySelector('#vuePresets');
  if (pre) createApp(StatusPresets).mount(pre);
})();
