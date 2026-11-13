// layout / explorer 持久化与窗口 id 的 IPC 通道名。main / preload 两侧 import 同一份
// (此前两侧各写字符串字面量,是唯一没有共享常量的通道族)。

export const LAYOUT_CHANNELS = {
  // invoke(renderer → main)
  READ: 'layout:read',
  WRITE: 'layout:write',
  // 关窗 / 退出握手:main → renderer 请求落盘,renderer → main 回执
  FLUSH_REQUEST: 'layout:flush-request',
  FLUSH_ACK: 'layout:flush-ack',
  // renderer → main:已订阅 flush 请求(DockShell 挂载完成)。main 只对上报过的窗口发请求并等回执。
  FLUSH_READY: 'layout:flush-ready',
} as const;

export const EXPLORER_CHANNELS = {
  READ: 'explorer:read',
  WRITE: 'explorer:write',
} as const;

/** preload 启动时 sendSync 取本窗口 id。 */
export const WINDOW_ID_CHANNEL = 'window:id';
