// dockview popout 子窗口的标记。主窗口给 addPopoutGroup 传 popoutUrl 时附 ?popout=1,
// 子窗口的 App.tsx 据此短路 DockShell,留位置给 dockview 的 portal 渲染。
const POPOUT_FLAG = 'popout';

export function isPopoutWindow(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  return params.get(POPOUT_FLAG) === '1';
}

export function popoutUrlFor(baseHref: string): string {
  const url = new URL(baseHref);
  url.searchParams.set(POPOUT_FLAG, '1');
  return url.toString();
}
