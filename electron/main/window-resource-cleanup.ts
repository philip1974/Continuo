// 窗口级资源清理工厂(topic49 第二十轮 — popout 兄弟入口补漏)。
//
// 主窗 / 新窗经 createMainWindow 创建,dockview popout 子窗由 Electron 在
// setWindowOpenHandler 返回 action:'allow' 时**内部创建,不走 createMainWindow**。
// 但 popout 注入了同一套 PRELOAD,能发起 fs.watch / plugin scope 授权 / agent 授权。
// 旧实现把这三项关窗清理只挂在 createMainWindow 的 win.on('closed') → popout 关闭时:
//   - fs watcher 引用不释放 → 单向累积触顶 MAX_WATCHERS,把活跃窗的 watcher LRU 踢掉;
//   - pending scope / agent 授权不结算 → host 侧干等满 5min TTL。
// 这与 terminal.ipc 的 windowClosedCleanup(已用覆盖全窗口的 browser-window-created
// 挂载)是同一类资源,却用了两套挂载模式、其一漏了 popout 兄弟入口。
//
// 抽成可注入工厂集中清理逻辑,index.ts 在覆盖全窗口的 browser-window-created 处统一挂载,
// 杜绝兄弟入口再次漂移。

export interface WindowResourceCleanupDeps {
  /** 取消该 webContents 仍 pending 的 plugin scope 授权请求(按 wcId 记账)。 */
  readonly cancelScopeRequests: (webContentsId: number) => void;
  /** 释放该窗口持有的 fs watcher 引用(按 win.id 记账)。 */
  readonly releaseFsWatchers: (windowId: number) => void;
  /** 把该窗口仍挂着的 agent 授权 pending 立即结算为 denied(按 win.id 记账)。 */
  readonly cancelAgentAuth: (windowId: number) => void;
}

/**
 * 返回一个 `(windowId, webContentsId) => void` 清理器。每个清理子项对无主资源都是
 * no-op,故对从未注册过任何资源的 popout 调用安全、且重复调用幂等。
 */
export function makeWindowResourceCleanup(
  deps: WindowResourceCleanupDeps,
): (windowId: number, webContentsId: number) => void {
  return (windowId: number, webContentsId: number): void => {
    deps.cancelScopeRequests(webContentsId);
    deps.releaseFsWatchers(windowId);
    deps.cancelAgentAuth(windowId);
  };
}
