// BDD:重启恢复出来的 popout 子窗不抢焦点(主窗保持键盘焦点);用户主动弹出的子窗照常获焦。
// 主进程在 layout:read 返回布局时登记该窗口将恢复的 popout 数(限时),随后由该窗口打开的那么多个子窗走 showInactive。
// 见同目录 README 第 2 条。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetPopoutRestore,
  countPopoutGroups,
  notePopoutRestore,
  POPOUT_RESTORE_WINDOW_MS,
  takePopoutRestoreSlot,
} from '../../../electron/main/services/popout-restore-focus.service';

beforeEach(() => _resetPopoutRestore());

describe('恢复中的 popout 名额', () => {
  it('布局里的 popout 数:无 / 畸形 → 0', () => {
    expect(countPopoutGroups(null)).toBe(0);
    expect(countPopoutGroups({ grid: {} })).toBe(0);
    expect(countPopoutGroups({ popoutGroups: 'x' })).toBe(0);
    expect(countPopoutGroups({ popoutGroups: [{}, {}] })).toBe(2);
  });

  it('登记 N 个 → 同一窗口随后打开的前 N 个子窗不抢焦点,第 N+1 个(用户主动弹出)照常', () => {
    notePopoutRestore(7, 2, 1000);
    expect(takePopoutRestoreSlot(7, 1100)).toBe(true);
    expect(takePopoutRestoreSlot(7, 1200)).toBe(true);
    expect(takePopoutRestoreSlot(7, 1300)).toBe(false);
  });

  it('别的窗口打开的子窗不占名额', () => {
    notePopoutRestore(7, 1, 1000);
    expect(takePopoutRestoreSlot(8, 1100)).toBe(false);
    expect(takePopoutRestoreSlot(7, 1100)).toBe(true);
  });

  it('名额限时:超过恢复窗口期仍未用完(popout 被 sanitize 丢弃等)→ 作废,之后的子窗照常获焦', () => {
    notePopoutRestore(7, 3, 1000);
    expect(takePopoutRestoreSlot(7, 1000 + POPOUT_RESTORE_WINDOW_MS + 1)).toBe(false);
  });

  it('再次读布局(onReady 重入)以最新一次为准;布局无 popout → 清掉名额', () => {
    notePopoutRestore(7, 3, 1000);
    notePopoutRestore(7, 0, 1100);
    expect(takePopoutRestoreSlot(7, 1200)).toBe(false);
  });
});
