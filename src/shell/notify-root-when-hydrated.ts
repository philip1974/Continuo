// race(R46):向 main 推送 window→root 映射的「先 hydrate 后推送」逻辑。
//
// initExplorerPersistence 是 fire-and-forget,renderer 首帧 root=null(hydrate 未完成)。若一变就
// notifyRoot(null),会把 null 写进 main 的 window→root map;hydrate 完成前 MCP/agent 经
// terminal.create_session(未显式传 cwd)建终端时,main 从空 map 回退成无 workspaceRoot 的全局终端
// 或错误 cwd,hydrate 后修正已来不及。门控:等 waitForWorkspaceHydrated() 再推,且 await 后读
// **最新** root(而非首帧捕获),hydrate 后该 Promise 立即 resolve,正常 root 变更无延迟。

export interface NotifyRootWhenHydratedDeps {
  waitHydrated: () => Promise<void>;
  getRoot: () => string | null;
  notifyRoot: (root: string | null) => Promise<{ ok: boolean; code?: string }>;
  /** effect cleanup 后置 true,避免对已卸载/被取代的 effect 推送。 */
  isCancelled: () => boolean;
}

export async function notifyRootWhenHydrated(
  deps: NotifyRootWhenHydratedDeps,
): Promise<void> {
  await deps.waitHydrated();
  if (deps.isCancelled()) return;
  const root = deps.getRoot();
  const res = await deps.notifyRoot(root ?? null);
  if (!res.ok) {
    console.warn('[App] notifyRoot rejected', res.code, root);
  }
}
