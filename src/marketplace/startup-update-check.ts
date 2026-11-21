// 启动更新检查排在用户插件扫描完成之后(IconSidebar 角标用)。
// update-store.refresh() 先同步读 listAll() 按已安装规模裁剪网络(打磨 R54);若与 init 同一同步段发起,
// init 还在等 listPluginDirs IPC,listAll() 恒为空 → 直接落空,已装插件有新版本也不出角标。
// perf:挂在「扫描完成」(whenScanned,扫描失败也 resolve)而非整个 init 上 —— 某插件激活挂在授权弹窗 / onload 上时
// init 可能长时间甚至永不完成,而 refresh 只需 manifest。checkUpdates=false(popout 子窗口:只渲染 PopoutHost、
// 无 IconSidebar 角标)→ 只 init、不检查,省掉每个 popout 一次 marketplace index + N 个 manifest 拉取。
// init 的结果(含失败)原样返回给调用方(reload-gate 据此 flush,仍等整个 init)。
export function initPluginsThenCheckUpdates(
  manager: { init(): Promise<void>; whenScanned(): Promise<void> },
  refresh: () => Promise<void>,
  opts: { checkUpdates: boolean },
): Promise<void> {
  const done = manager.init();
  if (opts.checkUpdates) {
    // fire-and-forget:refresh 内部 catch 不抛,也不阻塞 reload-gate flush。
    void manager.whenScanned().then(() => refresh());
  }
  return done;
}
