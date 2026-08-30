// 轻量 toast 封装（PrimeVue ToastService 绑定，组件无需各自 useToast）
let instance = null;

export function bindToast(t) { instance = t; }

export function toast(msg, severity = 'info', life = 2600) {
  if (instance && msg) instance.add({ severity, summary: String(msg), life });
}
