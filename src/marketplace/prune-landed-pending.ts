// install.pending 是「刚装/更新成功、但等磁盘 mtime watcher 落地到 PluginManager」
// 的乐观标记。一旦某 id 在 installed(user plugin manager 的已发现集合)出现 = 已落地,该 id 的
// pending 使命已完,必须摘除。否则:
//   (1) pending 单调只增不减(会话内内存泄漏);
//   (2) 用户随后在设置页卸载该插件 → installed 变假但 pending 仍真 →
//       marketplace 卡片错误显示「已安装 / 待重启」幻影
//       (pendingRestart = pending.has && !installed.has;installed 展示 = installed || pending)。
//
// 返回**同一引用**当无可摘除项 → setState 函数式更新可据此 bail,不触发多余 re-render。
const EMPTY_PENDING: ReadonlySet<string> = new Set();

export function pruneLandedPending(
  pending: ReadonlySet<string>,
  installed: ReadonlySet<string>,
): ReadonlySet<string> {
  let next: Set<string> | null = null;
  for (const id of pending) {
    if (installed.has(id)) {
      if (!next) next = new Set(pending);
      next.delete(id);
    }
  }
  if (next?.size === 0) return EMPTY_PENDING;
  return next ?? pending;
}

/**
 * 同一规则的 Map 版(插件设置页「从 Git 安装」的待重启行,按 id 记安装结果):已落地(isInstalled)的 id 摘除。
 * 此前设置页只增不减 → 落地后行被过滤隐藏,卸载后过滤重新成立,「已安装,重启后加载」幽灵行回来。无可摘除返回同一引用。
 */
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

