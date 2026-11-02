// 主题：light / dark / system 三态，持久化到 localStorage，并在首帧之前应用（防闪白）
// 与 PrimeVue 的 darkModeSelector='.app-dark' 对齐：应用深色 = html 加 .app-dark。
// 她用「跟随系统」时用 matchMedia 实时响应系统切换，而不是只在启动时读一次。
const KEY = 'vrc.theme';
const mql = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

/** 读持久化值；非法值一律回落到 system */
export function readPref() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** pref → 实际生效的 light/dark */
export function resolve(pref) {
  if (pref === 'light' || pref === 'dark') return pref;
  return mql && mql.matches ? 'dark' : 'light';
}

/** 把生效主题写到 <html>：只切 .app-dark，绝不改成 ;) 之类 */
export function apply(pref) {
  const effective = resolve(pref);
  const el = document.documentElement;
  el.classList.toggle('app-dark', effective === 'dark');
  el.dataset.theme = effective;
  el.dataset.themePref = pref;
  // meta theme-color 跟着走（移动端地址栏配色）
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', effective === 'dark' ? '#070708' : '#f7f7f8');
  return effective;
}

export function setPref(pref) {
  const next = pref === 'light' || pref === 'dark' ? pref : 'system';
  try { localStorage.setItem(KEY, next); } catch { /* 隐私模式忽略 */ }
  return apply(next);
}

/** 跟随系统时监听系统切换（重复调用幂等） */
let bound = false;
export function bindSystemWatcher(onChange) {
  if (!mql || bound) return;
  bound = true;
  const handler = () => {
    if (readPref() !== 'system') return;
    const eff = apply('system');
    if (onChange) onChange(eff);
  };
  if (mql.addEventListener) mql.addEventListener('change', handler);
  else if (mql.addListener) mql.addListener(handler);
}
