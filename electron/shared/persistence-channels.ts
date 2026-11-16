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
  // renderer → main:本窗口关窗会丢的脏 tab 计数 `{ dirty, untitled }`(变化时上报)。main 据此在关窗 /
  // 退出前弹「是否保存」确认;选保存时 FLUSH_REQUEST 带 `save: true`(不保存带 `discard: true`),FLUSH_ACK
  // 第二参带 `{ saveFailed, remaining? }`(remaining:全部 flush 后仍有未保存改动,main 中止关闭)。
  DIRTY_STATE: 'layout:dirty-state',
} as const;

export const EXPLORER_CHANNELS = {
  READ: 'explorer:read',
  WRITE: 'explorer:write',
} as const;

/** preload 启动时 sendSync 取本窗口 id。 */
export const WINDOW_ID_CHANNEL = 'window:id';
