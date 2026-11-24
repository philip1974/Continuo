// 丢弃一个终端会话的单一顺序:**先删会话元数据,再杀 PTY**。先删保证 PTY 退出回调里的 setExited 不再
// 生效(会话不会以 exited 状态复活在列表里);force=true 立即 SIGKILL(撤销授权 / 创建回滚等安全或无调用方
// 场景),否则 Ctrl+C + 3s grace。用户关闭、撤销 agent、MCP 创建回滚共用(此前 3 处各写一遍配对);关窗走
// removeByOwner 批量删再逐个 kill,形状不同,不经此处。

export interface TerminalDiscardDeps {
  readonly sessionStore: { remove(id: string): unknown };
  readonly service: {
    has(id: string): boolean;
    kill(id: string): void;
    forceKill(id: string): void;
  };
}

export function discardTerminalSession(
  deps: TerminalDiscardDeps,
  id: string,
  opts: { readonly force: boolean },
): void {
  deps.sessionStore.remove(id);
  if (!deps.service.has(id)) return;
  if (opts.force) deps.service.forceKill(id);
  else deps.service.kill(id);
}
