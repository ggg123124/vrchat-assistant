// @vitest-environment happy-dom
// 2026-09-22：挂载测试需要 DOM ⇒ 用文件级指令开 happy-dom（不改全局 vite.config，改动面最小 ✓）
import { describe, it, expect, vi } from 'vitest';
import { clickable } from './directives/clickable.js';
import { mount } from '@vue/test-utils';
import { store } from './store.js';   // 被上面的 vi.mock 替换成桩；本文件会改 userModal 触发弹窗 ✓

// 2026-09-22 新增：**挂载级**回归护栏
// 起因：今晚连续出现「模板里用了不存在的函数」✗（openDetail / startSse / getToken）与
// 「某视图挂载即抛错 ⇒ 整块空白」✗ —— 而当时 44 个纯函数测试 + 构建全绿，什么都没拦住 ✗。
// 这里把关键视图**真的挂起来**并断言渲染出关键文案：构建通过 ≠ 能渲染 ✓。
// ⚠️ vi.mock 会被提升到文件顶部，工厂里不能引用外部变量 ⇒ stub 写在工厂内部 ✓。
vi.mock('./store.js', () => ({
  store: {
    friends: [], feedEvents: [], feedHasMore: false, feedMoreError: '', loadError: '',
    userModal: null, previewUrl: '', tracked: [], worlds: [], loading: false, authed: true,
    trackedList: [], overview: null,
    // FeedView 读这些筛选态（我第一版桩少写了 feedFilter ⇒ 报错 ✗ —— 那是桩的问题，不是组件 bug ✓）
    // 字段名照 store.js 的真实初值写（feedSearch 不是 feedQuery —— 上次写错名 ⇒ trim of undefined ✗）
    feedFilter: [], feedSearch: '', feedDateFrom: '', feedDateTo: '', feedOnlyFav: false,
    feedLoading: false, feedLoadingMore: false, feedOwner: '', feedKind: 'all', feedDays: 0,
    stats: null, total: 0, eventsRange: [], watchlist: [], favorites: [], nicknames: {},
  },
  closeUser: () => {}, openWorld: () => {}, openGroup: () => {}, copyText: () => {},
  openPreview: () => {}, toggleWatch: () => {}, startDashboard: () => {}, consume: () => {},
  loadMore: () => {}, load: () => {},
}));
vi.mock('./api.js', () => ({
  get: async () => [], post: async () => ({ ok: true }), getToken: () => 'test-token',
  openSse: () => {}, consume: async () => ({}),
}));

import TrackedView from './views/TrackedView.vue';
import FriendsView from './views/FriendsView.vue';
import BoothView from './views/BoothView.vue';

// 2026-11-02：v-clickable 是全局指令（main.js 注册）。挂载测试不走 main.js，若不在这里注册，模板里的 v-clickable 会报 "Failed to resolve directive" 并且**不绑定任何行为** ⇒测试环境与生产不一致，等于给这类回归开了后门。)
const mountOpts = {
  global: {
    directives: { clickable },
    stubs: { Teleport: true, Transition: true, TransitionGroup: true },
  },
};

describe('视图挂载护栏（挂载即渲染，不允许静默空白）', () => {
  const cases = [
    ['TrackedView', TrackedView, ['非好友追踪']],
    ['FriendsView', FriendsView, ['好友']],
    // 2026-10-16（审查方 ⚠️ 修正）：把 BoothView 纳入清单 —— 三个原始缺陷里 openDetail 的唯一
    // 所在就是 BoothView.vue（此前未被挂载 ⇒ 护栏覆盖不到它）✓
    ['BoothView', BoothView, ['BOOTH 素材']],
    // ⚠️ 覆盖边界（如实标注）：store.js 被 vi.mock **整体替换** ⇒ 本护栏不覆盖 store.js 内部逻辑
    // （startSse / getToken 都在 store 里）—— 那些只能靠真机巡回（scripts/ui-view-tour.mjs）覆盖 ✓
    // FeedView 的模板依赖较多 store 字段（本轮桩不够）；先不覆盖，避免'为了让它绿'把桩写成假实现 ✓
    // ['FeedView', FeedView, ['动态']],
  ];
  for (const [name, Comp, expects] of cases) {
    it(name + ' 挂载后能看到关键文案（不是空白）', async () => {
      const w = mount(Comp, mountOpts);
      await new Promise((r) => setTimeout(r, 40));
      const text = w.text();
      expect(text.length, name + ' 渲染为空 —— 这正是今晚的故障形态').toBeGreaterThan(0);
      for (const e of expects) expect(text, name + ' 缺少关键文案: ' + e).toContain(e);
      w.unmount();
    });
  }
  // 2026-10-16（审查方 ⚠️ 修正）：原断言 expect(typeof w.text()).toBe('string') **恒真**（空串也是
  // string）⇒ 兜不住"渲染成空白"。改为断言"真的渲染出了目标用户"，并给 Dialog/Tabs 补 slot 桩
  // 让弹窗内容真的落地（否则内容根本不渲染、断言又变成恒真）✓
  // 2026-10-16（审查方 ⚠️ 修正）：原断言 expect(typeof w.text()).toBe('string') **恒真**（空串也是
  // string）⇒ 兜不住"渲染成空白"。本测试环境**没有全局注册 PrimeVue**（Dialog/Tabs/Tab/Button 全部
  // 解析失败 ⇒ 弹窗内容不一定渲染）⇒ 与其写一条依赖渲染的假断言，改为**行为判据**：
  // 挂载后组件必须真的跑起来（发起过资料请求）——受控变异可证伪（去掉请求即红）✓
  // 2026-10-16（审查方 ⚠️ 修正）：原 `UserDialog` 用例**已删除** —— 原断言
  // expect(typeof w.text()).toBe('string') 恒真（空串也是 string）；而本测试环境**没有全局注册
  // PrimeVue**（Dialog/Tabs/Tab/Button 全部解析失败 ⇒ 弹窗内容不渲染、挂载也不触发资料请求）
  // ⇒ 在这个环境里对它做任何断言都只能是假护栏。按审查方建议「宁可删掉，也不要留下恒真用例」。
  // UserDialog 的渲染/行为覆盖交回**真机巡回**：scripts/ui-view-tour.mjs（遍历 #view=...，检查空白/报错）。
});
