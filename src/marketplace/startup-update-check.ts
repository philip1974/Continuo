// 启动更新检查排在用户插件 init 之后(IconSidebar 角标用)。
// update-store.refresh() 先同步读 listAll() 按已安装规模裁剪网络(打磨 R54);若与 init 同一同步段发起,
// init 还在等 listPluginDirs IPC,listAll() 恒为空 → 直接落空,已装插件有新版本也不出角标。
// init 成功或失败都检查一次;init 的结果(含失败)原样返回给调用方(reload-gate 据此 flush)。
export function initPluginsThenCheckUpdates(
  init: () => Promise<void>,
  refresh: () => Promise<void>,
): Promise<void> {
  return init().finally(() => {
    // fire-and-forget:refresh 内部 catch 不抛,也不阻塞 reload-gate flush。
    void refresh();
  });
}
