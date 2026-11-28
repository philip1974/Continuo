// 全部 terminal.* IPC 通道字符串集中地。main / preload 两侧 import 同一份。
// invoke 通道 + 单向 event 通道(main → renderer push)。

export const TERMINAL_CHANNELS = {
  // invoke(renderer → main)
  CREATE: 'terminal:create',
  WRITE: 'terminal:write',
  RESIZE: 'terminal:resize',
  // P1 Agent Terminal MCP:session metadata 真相源在 main
  LIST_SESSIONS: 'terminal:list_sessions',
  REMOVE: 'terminal:remove',
  // topic-07: dockview lazy-mount inactive panel 错过初始 PTY 输出。
  // renderer mount 时调此接口从 main 端 buffer replay 历史 chunks。
  READ_HISTORY: 'terminal:read_history',
  // 关闭终端前确认(VSCode confirmOnKill):查询前台是否有 shell 以外的子程序在运行。
  RUNNING_PROCESS: 'terminal:running_process',
  // 拆分终端继承目录(VSCode splitCwd: inherited):OSC 7 上报的目录,否则 shell 进程的真实当前目录。
  CWD: 'terminal:cwd',
  // tab 右键「重命名…」(用户标题,固定)。
  RENAME: 'terminal:rename',
  // 终端本地文件链接:候选路径按终端 cwd 解析并确认是存在的普通文件(VSCode TerminalLinkResolver)。
  RESOLVE_LINKS: 'terminal:resolve_links',
  // event(main → renderer,webContents.send)
  DATA: 'terminal:data',
  SESSIONS_CHANGED: 'terminal:sessions_changed',
} as const;

/**
 * OSC 7 cwd 上报(renderer → main)。通道名沿用历史值 `session:*`,不在 `terminal:` 前缀族内,故单列
 * (TERMINAL_CHANNELS 有「全部前缀 terminal:」的契约测试)。preload 与 main 共用此常量。
 */
export const SESSION_UPDATE_CWD_CHANNEL = 'session:update-cwd';

/**
 * READ_HISTORY 的返回(main getBufferSnapshot → preload → renderer useTerminal)。renderer 按偏移把历史与
 * 实时推送去重:startOffset = 快照首字符的累计偏移,endOffset = 快照止于的累计偏移(会话已无实例时缺省)。
 */
export interface TerminalHistorySnapshot {
  readonly data: string;
  readonly truncated: boolean;
  readonly endOffset?: number;
  readonly startOffset?: number;
}
