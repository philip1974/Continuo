// 全部 terminal.* IPC 通道字符串集中地。main / preload 两侧 import 同一份。
// invoke 通道 + 单向 event 通道(main → renderer push)。

export const TERMINAL_CHANNELS = {
  // invoke(renderer → main)
  CREATE: 'terminal:create',
  WRITE: 'terminal:write',
  RESIZE: 'terminal:resize',
  INTERRUPT: 'terminal:interrupt',
  KILL: 'terminal:kill',
  DESTROY: 'terminal:destroy',
  // event(main → renderer,webContents.send)
  DATA: 'terminal:data',
  EXIT: 'terminal:exit',
  OVERFLOW: 'terminal:overflow',
  OVERFLOW_RECOVERED: 'terminal:overflow-recovered',
} as const;

export type TerminalChannel =
  (typeof TERMINAL_CHANNELS)[keyof typeof TERMINAL_CHANNELS];
