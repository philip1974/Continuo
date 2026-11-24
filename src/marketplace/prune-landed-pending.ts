// 待重启记录(src/plugins/pending-installs-store)是「刚装成功、但 PluginManager 还没扫到」的乐观标记。一旦某 id
// 已进插件列表(isInstalled)= 已落地,该 id 的记录使命已完,必须摘除。否则:
//   (1) 记录单调只增不减(会话内内存泄漏);
//   (2) 用户随后在设置页卸载该插件 → 列表不再含它但记录仍在 → 市场卡片「已安装 / 待重启」、设置页
//       「已安装,重启后加载」幽灵回来(两页都按「有记录且不在列表」显示待重启)。
//
// 无可摘除项返回**同一引用** → 调用方据此跳过 setState,不触发多余 re-render。
export function pruneLandedPendingMap<V>(
  pending: ReadonlyMap<string, V>,
  isInstalled: (id: string) => boolean,
): ReadonlyMap<string, V> {
  let next: Map<string, V> | null = null;
  for (const id of pending.keys()) {
    if (isInstalled(id)) {
      next ??= new Map(pending);
      next.delete(id);
    }
  }
  return next ?? pending;
}
