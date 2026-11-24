// 启动更新检查排在用户插件扫描完成之后(IconSidebar 角标用)。
// update-store.refresh() 先同步读 listAll() 按已安装规模裁剪网络(打磨 R54);若与 init 同一同步段发起,
// init 还在等 listPluginDirs IPC,listAll() 恒为空 → 直接落空,已装插件有新版本也不出角标。
// perf:挂在「扫描完成」(whenScanned,扫描失败也 resolve)而非整个 init 上 —— 某插件激活挂在授权弹窗 / onload 上时
// init 可能长时间甚至永不完成,而 refresh 只需 manifest。只在主窗调用(popout 子窗口在 main-app 里早退,不走这里)。
// init 的结果(含失败)原样返回给调用方(main-app 只记录失败)。
export function initPluginsThenCheckUpdates(
  manager: { init(): Promise<void>; whenScanned(): Promise<void> },
  refresh: () => Promise<void>,
): Promise<void> {
  const done = manager.init();
  // fire-and-forget:refresh 内部 catch 不抛。
  void manager.whenScanned().then(() => refresh());
  return done;
}
