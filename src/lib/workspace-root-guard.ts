import { createLatestGuard } from './latest-wins';

// race(R27,R18/R19 同族收口):一个窗口只有一个 workspace root,所有「异步选择 root」的入口都
// 最终 setRoot 同一目标。此前守卫按入口分裂——drop 用 App.tsx 的 per-component dropGuardRef、
// 打开最近用 open-recent-root 的 recentOpenGuard、EmptyWorkspace/ExplorerHeader 的 selectDirectory
// 仅靠各自的 busy 本地态——不同入口的守卫互不失效:拖入目录 A 的异步探测未完成时,用户点击「最近」
// B 成功切到 B,随后 A 迟到 resolve 仍会 setRoot(A),打开错误 workspace 并触发 tab/session/layout
// 持久化写入错误 root。
//
// 统一为单个模块级共享守卫:任一入口发起选择时 begin(),await 后用 isLatest() 判定;任一入口的
// begin() 都会作废其它入口在途的选择(全局「最新者胜」)。drop / 打开最近 / EmptyWorkspace 打开 /
// ExplorerHeader 切换 共用此实例。
export const workspaceRootSelectionGuard = createLatestGuard();

// race(R28,R27 直接遗漏边):同步变更 workspace root 的入口(如「关闭文件夹」setRoot(null))也是
// 对同一资源的更新,必须参与 last-wins —— 否则用户先触发一个仍在途的打开/拖入/recent 选择,再点
// 关闭文件夹,旧异步选择迟到 resolve 时 isLatest() 仍为真 → 重新 setRoot(oldPath),撤销关闭,后续
// 持久化也写回错误 root。同步入口不 await、无需自己的 isLatest;在变更前调用本函数 begin() 一次,
// 即把所有在途异步选择标记为过期(它们 resolve 时 isLatest() 返回 false 不再落地)。
export function cancelPendingWorkspaceRootSelection(): void {
  workspaceRootSelectionGuard.begin();
}
