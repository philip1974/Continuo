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
  // P1 Agent Terminal MCP:session metadata 真相源在 main
  LIST_SESSIONS: 'terminal:list_sessions',
  REMOVE: 'terminal:remove',
  // topic-05: renderer 通知 main attach 拒绝;main 端 remove session。
  // V1 反向 cleanup(不做 main 端 preflight reserveAttachSlot — 工程范围内简化)。
  ATTACH_REJECTED: 'terminal:attach_rejected',
  // event(main → renderer,webContents.send)
  DATA: 'terminal:data',
  EXIT: 'terminal:exit',
  OVERFLOW: 'terminal:overflow',
  OVERFLOW_RECOVERED: 'terminal:overflow-recovered',
  SESSIONS_CHANGED: 'terminal:sessions_changed',
} as const;

export type TerminalChannel =
  (typeof TERMINAL_CHANNELS)[keyof typeof TERMINAL_CHANNELS];
