// 轻量确认封装（PrimeVue ConfirmDialog 绑定，组件无需各自 useConfirm）。
// 用法：confirm({ message, header, acceptLabel, rejectLabel }) → Promise<boolean>
// 视觉与全站 Dialog 统一（替代原生 window.confirm）。
let confirmService = null;

export function bindConfirm(c) { confirmService = c; }

export function confirm({ message, header = '确认操作', acceptLabel = '确认', rejectLabel = '取消', severity = 'danger' } = {}) {
  return new Promise((resolve) => {
    if (!confirmService) { resolve(window.confirm(message)); return; }
    confirmService.require({
      message,
      header,
      acceptLabel,
      rejectLabel,
      acceptProps: { severity, size: 'small' },
      rejectProps: { severity: 'secondary', size: 'small', outlined: true },
      accept: () => resolve(true),
      reject: () => resolve(false),
    });
  });
}
