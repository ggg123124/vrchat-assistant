import { createApp } from 'vue';
import App from './App.vue';
import PrimeVue from 'primevue/config';
import Aura from '@primevue/themes/aura';
import { definePreset } from '@primevue/themes';
import ToastService from 'primevue/toastservice';
import Tooltip from 'primevue/tooltip';

import Button from 'primevue/button';
import Drawer from 'primevue/drawer';
import Tag from 'primevue/tag';
import Badge from 'primevue/badge';
import Avatar from 'primevue/avatar';
import InputText from 'primevue/inputtext';
import SelectButton from 'primevue/selectbutton';
import ProgressSpinner from 'primevue/progressspinner';
import Dialog from 'primevue/dialog';
import Tabs from 'primevue/tabs';
import TabList from 'primevue/tablist';
import Tab from 'primevue/tab';
import TabPanels from 'primevue/tabpanels';
import TabPanel from 'primevue/tabpanel';
import Toast from 'primevue/toast';
import Menu from 'primevue/menu';
import Popover from 'primevue/popover';
import Skeleton from 'primevue/skeleton';
import Divider from 'primevue/divider';
import ConfirmDialog from 'primevue/confirmdialog';
import ConfirmService from 'primevue/confirmationservice';
import Textarea from 'primevue/textarea';
import ToggleSwitch from 'primevue/toggleswitch';
import ScrollTop from 'primevue/scrolltop';
import Calendar from 'primevue/calendar';

import 'primeicons/primeicons.css';
import './style.css';
import { startDashboard } from './store.js';
import { imgUrl } from './api.js';

// iOS 软键盘修复：键盘弹出时 visualViewport 高度小于 100dvh，把实际值写到 --vvh，
// 壳体加 has-vvk 类后改用该高度（style.css），fixed tabbar/header 不再被顶飞
if (window.visualViewport && /iP(hone|ad|od)/.test(navigator.userAgent)) {
  const vv = window.visualViewport;
  const apply = () => {
    const kbVisible = vv.height < window.innerHeight - 40;
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    document.querySelector('.app-shell')?.classList.toggle('has-vvk', kbVisible);
  };
  vv.addEventListener('resize', apply);
  apply();
}

// 图片策略：VRChat 图片统一走路由器代理（局域网秒连 + 后端 6h 缓存），
// 不再"浏览器直连优先"——直连 api.vrchat.cloud 在大陆网络每张图要卡到超时才降级，页面明显变慢。
// 用 MutationObserver 接管所有动态插入的 <img>（含 PrimeVue Avatar 内部），src 幂等替换。
function proxyizeImg(img) {
  const src = img.getAttribute('src') || '';
  if (!src || String(src).includes('/image-proxy')) return;
  const p = imgUrl(src);
  if (p && p !== src) {
    img.setAttribute('src', p);
    // 列表图片懒加载（好友头像/世界缩略图等非首屏不阻塞）
    if (!img.hasAttribute('loading')) img.setAttribute('loading', 'lazy');
  }
}
document.querySelectorAll('img').forEach(proxyizeImg);
const imgObserver = new MutationObserver((muts) => {
  for (const m of muts) {
    if (m.type === 'childList') {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.tagName === 'IMG') proxyizeImg(n);
        if (n.querySelectorAll) n.querySelectorAll('img').forEach(proxyizeImg);
      }
    } else if (m.type === 'attributes' && m.target && m.target.tagName === 'IMG' && m.attributeName === 'src') {
      proxyizeImg(m.target);
    }
  }
});
imgObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
// 兜底：图片加载失败重试——直连失败先走代理；代理也失败（网络抖动/占位）延迟重试原 URL，
// 服务端 image-proxy 会重新回源 + 内部重试，瞬时抖动大多可恢复
document.addEventListener('error', (e) => {
  const t = e.target;
  if (t && t.tagName === 'IMG') {
    const cur = t.getAttribute('src') || '';
    if (!cur) return;
    const retries = Number(t.getAttribute('data-retry') || 0);
    if (retries >= 2) return;
    t.setAttribute('data-retry', retries + 1);
    if (String(cur).includes('/image-proxy')) {
      setTimeout(() => { if (t.isConnected) t.setAttribute('src', cur); }, 500);
    } else {
      const p = imgUrl(cur);
      if (p && p !== cur) { t.setAttribute('src', p); return; }
      setTimeout(() => { if (t.isConnected) t.setAttribute('src', cur); }, 500);
    }
  }
}, true);

const VrcPreset = definePreset(Aura, {
  semantic: {
    primary: {
      50: '#f5f3ff', 100: '#ede9fe', 200: '#ddd6fe', 300: '#c4b5fd',
      400: '#a78bfa', 500: '#8b5cf6', 600: '#7c3aed', 700: '#6d28d9',
      800: '#5b21b6', 900: '#4c1d95', 950: '#2e1065',
    },
    colorScheme: {
      dark: {
        // 黑灰表面（偏黑，去蓝调）
        surface: {
          0: '#ffffff', 50: '#f5f5f6', 100: '#e8e8ea', 200: '#d4d4d7',
          300: '#b0b0b4', 400: '#8a8a90', 500: '#6b6b71', 600: '#55555b',
          700: '#3a3a40', 800: '#26262a', 900: '#1a1a1d', 950: '#101012',
        },
      },
    },
  },
});

const app = createApp(App);

app.use(PrimeVue, {
  theme: {
    preset: VrcPreset,
    options: {
      darkModeSelector: '.app-dark',
      cssLayer: false,
    },
  },
  // overlay（Popover/Calendar 等）起始 z-index 提到 1100：
  // 应用壳的 header/tabbar 用了 z-index 30/40，但 zindex 工具栈内部从 base+1 起算，
  // 若与页面元素在同一数值段内会被压在下面 → 移动端日期 Popover 点不开
  zIndex: { modal: 1100, overlay: 1000, menu: 1050, toast: 1200 },
});
app.use(ToastService);
app.use(ConfirmService);

app.component('Button', Button);
app.component('Drawer', Drawer);
app.component('Tag', Tag);
app.component('Badge', Badge);
app.component('Avatar', Avatar);
app.component('InputText', InputText);
app.component('SelectButton', SelectButton);
app.component('ProgressSpinner', ProgressSpinner);
app.component('Dialog', Dialog);
app.component('Tabs', Tabs);
app.component('TabList', TabList);
app.component('Tab', Tab);
app.component('TabPanels', TabPanels);
app.component('TabPanel', TabPanel);
app.component('Toast', Toast);
app.component('Menu', Menu);
app.component('Popover', Popover);
app.component('Skeleton', Skeleton);
app.component('Divider', Divider);
app.component('ConfirmDialog', ConfirmDialog);
app.component('Textarea', Textarea);
app.component('ToggleSwitch', ToggleSwitch);
app.component('ScrollTop', ScrollTop);
app.component('Calendar', Calendar);

app.directive('tooltip', Tooltip);

startDashboard();

app.mount('#app');
