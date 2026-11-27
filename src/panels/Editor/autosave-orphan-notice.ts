// 自动保存因「已删除」暂停时的可见提示。文件被删 / 所在卷卸载后 tab 标「(已删除)」,自动保存不再写回(见 useAutoSave);
// 此前只有 tab 上的后缀,继续输入时磁盘不更新、无任何提示,用户以为已自动保存。
// 只提示一次(不刷屏):同一 tab 每次进入「已删除 + 有未保存修改」状态提示一次;标记清除(文件回来 / 手动保存重建)后复位,
// 之后再次被删才会再提示。按 tabId 记在模块级:同一 tab 被多个编辑器组的 useAutoSave 观察也只提示一次。

const notified = new Set<string>();
/** 记录上限(关闭了的已删除 tab 不会再被观察到;超限丢最早的,最多导致一次重复提示)。 */
const MAX_NOTIFIED = 64;

/**
 * useAutoSave 在自动保存开启的 tab 上调用。orphaned && dirty 且本轮未提示过 → 调 show 并记下;orphaned 为假 → 复位。
 */
export function observeOrphanedAutoSave(tabId: string, orphaned: boolean, dirty: boolean, show: () => void): void {
  if (!orphaned) {
    notified.delete(tabId);
    return;
  }
  if (!dirty || notified.has(tabId)) return;
  notified.add(tabId);
  if (notified.size > MAX_NOTIFIED) {
    const oldest = notified.values().next().value;
    if (oldest !== undefined) notified.delete(oldest);
  }
  show();
}

/** 测试用:清空提示记录。 */
export function resetOrphanedAutoSaveNotices(): void {
  notified.clear();
}
