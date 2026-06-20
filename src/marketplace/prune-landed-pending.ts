// install.pending 是「刚装/更新成功、但等磁盘 mtime watcher 落地到 PluginManager」
// 的乐观标记。一旦某 id 在 installed(1s 轮询的真实磁盘集)出现 = 已落地,该 id 的
// pending 使命已完,必须摘除。否则:
//   (1) pending 单调只增不减(会话内内存泄漏);
//   (2) 用户随后在设置页卸载该插件 → installed 变假但 pending 仍真 →
//       marketplace 卡片错误显示「已安装 / 待重启」幻影
//       (pendingRestart = pending.has && !installed.has;installed 展示 = installed || pending)。
//
// 返回**同一引用**当无可摘除项 → setState 函数式更新可据此 bail,不触发多余 re-render。
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
  return next ?? pending;
}
