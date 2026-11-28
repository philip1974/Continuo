// 窗口 devicePixelRatio 变化监听(对齐 VSCode src/vs/base/browser/pixelRatio.ts 的 DevicePixelRatioMonitor):
// `matchMedia('(resolution: Ndppx)')` 在 DPR 离开 N 时触发一次 change,之后须按新值换一条 query 才能听到下一次变化。
// 窗口换到缩放比例不同的显示器 / 页面缩放时 DPR 变,而元素的 CSS 尺寸往往不变(ResizeObserver 不触发)——
// 依赖设备像素测量的组件(终端行列按设备像素取整的 cell 尺寸算)要靠这个重算。
// 元素可能在窗口间移动(dockview popout):getWindow 每次 sync 时重新取,窗口变了就改听新窗口。
// BDD: src/__tests__/device-pixel-ratio-change/

export interface DevicePixelRatioWatch {
  /** 元素所在窗口可能变了(如拖进 / 拖出 popout):变了就改听新窗口(不触发 onChange)。 */
  sync(): void;
  dispose(): void;
}

export function watchDevicePixelRatio(getWindow: () => Window | null, onChange: () => void): DevicePixelRatioWatch {
  let win: Window | null = null;
  let mql: MediaQueryList | null = null;
  let disposed = false;

  const unlisten = () => {
    mql?.removeEventListener('change', handleChange);
    mql = null;
  };
  const listen = () => {
    unlisten();
    win = getWindow();
    // jsdom / 非 DOM 环境没有 matchMedia:不监听
    if (!win || typeof win.matchMedia !== 'function') return;
    mql = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    mql.addEventListener('change', handleChange);
  };
  function handleChange(): void {
    if (disposed) return;
    listen();
    onChange();
  }

  listen();
  return {
    sync() {
      if (!disposed && getWindow() !== win) listen();
    },
    dispose() {
      disposed = true;
      unlisten();
      win = null;
    },
  };
}
