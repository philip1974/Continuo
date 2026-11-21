// race(R106,R8 同族):打开系统目录选择器的**同步**单飞闸门。
//
// EmptyWorkspace / ExplorerHeader 用 React busy state 防重入,但 setBusy 是异步的:同一 tick 内
// 双击 / Enter 重复触发,或程序性重复调用,会在按钮 disabled 渲染落地前各自发起一次
// coApi.fs.selectDirectory() → 弹出多个原生目录对话框;且 workspaceRootSelectionGuard.begin()
// 的「最新优先」语义会让较早那次的有效选择被后发的作废(用户先选的目录被丢弃)。
//
// 模块级同步布尔在发起前立即置位,确保同 tick 后续调用(乃至其它入口 —— ExplorerHeader 切换 /
// WindowPlugin 新窗口打开)在原生选择器在途时直接被挡掉,全 app 同时只有一个目录选择器。
// 锁是单一全局:任一时刻只有一个持有者(被挡的调用直接 return、不进 finally),故释放无需 token。
// 与 workspaceRootSelectionGuard(latest-wins 作废过期结果)正交:本闸门防「并发发起」,
// 后者防「过期结果落地」。

let inFlight = false;

/** 尝试取得目录选择器单飞锁。成功(此前空闲)返回 true 并置位;已在途返回 false。 */
export function trySelectDirectoryLock(): boolean {
  if (inFlight) return false;
  inFlight = true;
  return true;
}

/** 释放锁(由当前持有者在 finally 调用)。 */
export function releaseSelectDirectoryLock(): void {
  inFlight = false;
}

/** 仅测试用:重置闸门。 */
export function __resetSelectDirectoryLockForTest(): void {
  inFlight = false;
}
