// 重启恢复出来的 popout 子窗不抢主窗焦点(VSCode 恢复辅助窗口后焦点仍在主窗)。
//
// main 分不清 window.open 是用户点「弹出」还是 dockview fromJSON 恢复(features 只有位置尺寸)。layout:read 是恢复的
// 唯一入口:返回布局时登记该窗口将恢复的 popout 数(限时),随后由该窗口打开的那么多个子窗以 showInactive 显示;
// 用完 / 过期后的子窗(用户主动弹出)照常获焦。renderer 可能因 sanitize 丢弃部分 popout(全是终端)→ 名额限时作废。
// BDD: src/__tests__/window-state-restore/popout-restore-focus.spec.ts

/** 登记后多久内打开的子窗算「恢复」(dockview 恢复按 100ms 间隔逐个开窗,远小于此)。 */
export const POPOUT_RESTORE_WINDOW_MS = 10_000;

const pending = new Map<number, { count: number; expiresAt: number }>();

/** 布局里的 popout 组数(畸形 → 0)。 */
export function countPopoutGroups(layout: unknown): number {
  if (typeof layout !== 'object' || layout === null) return 0;
  const groups = (layout as { popoutGroups?: unknown }).popoutGroups;
  return Array.isArray(groups) ? groups.length : 0;
}

/** layout:read 返回布局时调用:该 webContents 接下来恢复 count 个 popout(以最新一次为准)。 */
export function notePopoutRestore(openerId: number, count: number, now: number = Date.now()): void {
  if (count > 0) pending.set(openerId, { count, expiresAt: now + POPOUT_RESTORE_WINDOW_MS });
  else pending.delete(openerId);
}

/** 该 webContents 打开 popout 时调用:属于恢复名额 → true(占用一个)。 */
export function takePopoutRestoreSlot(openerId: number, now: number = Date.now()): boolean {
  const entry = pending.get(openerId);
  if (!entry) return false;
  if (now > entry.expiresAt) {
    pending.delete(openerId);
    return false;
  }
  entry.count -= 1;
  if (entry.count <= 0) pending.delete(openerId);
  return true;
}

/** 测试用:清空登记。 */
export function _resetPopoutRestore(): void {
  pending.clear();
}
