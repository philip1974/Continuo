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
  // topic-07: dockview lazy-mount inactive panel 错过初始 PTY 输出。
  // renderer mount 时调此接口从 main 端 buffer replay 历史 chunks。
  READ_HISTORY: 'terminal:read_history',
  // event(main → renderer,webContents.send)
  DATA: 'terminal:data',
  EXIT: 'terminal:exit',
  OVERFLOW: 'terminal:overflow',
  OVERFLOW_RECOVERED: 'terminal:overflow-recovered',
  SESSIONS_CHANGED: 'terminal:sessions_changed',
} as const;

/**
 * OSC 7 cwd 上报(renderer → main)。通道名沿用历史值 `session:*`,不在 `terminal:` 前缀族内,故单列
 * (TERMINAL_CHANNELS 有「全部前缀 terminal:」的契约测试)。preload 与 main 共用此常量。
 */
export const SESSION_UPDATE_CWD_CHANNEL = 'session:update-cwd';
