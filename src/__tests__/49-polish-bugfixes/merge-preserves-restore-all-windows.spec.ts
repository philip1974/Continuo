// topic 49 第六 session · P2:restoreAllWindowsOnLaunch 在每次 renderer 写回时被丢弃。
//
// 根因:restoreAllWindowsOnLaunch 是 v3 顶层启动偏好,被 window-restore.service 读取
// (`if (data.restoreAllWindowsOnLaunch !== true) return []`)。但 renderer 的
// snapshotFromStores 从不携带它,而 explorer:write handler 走 mergeWritableIntoFull,
// 旧实现 `return { ...writable, nextWindowSeq, windows }` 只补回窗口级 main-owned 字段
// (layout/lastClosedAt),没补回这个顶层字段 → 任一窗口 workspace 切换/tab 开关/树展开
// 触发的写盘都会把它从盘上静默抹掉,用户「启动恢复所有窗口」偏好丢失且不可逆。
// 修复:mergeWritableIntoFull 显式保留 current.restoreAllWindowsOnLaunch(同 nextWindowSeq
// 一样属 main-owned,current 优先 writable 兜底)。

import { describe, expect, it } from 'vitest';
import {
  defaultExplorerV3,
  mergeWritableIntoFull,
  type ExplorerWritablePayload,
} from '../../../electron/main/persistence';

const sort = { by: 'name' as const, reverse: false };

const writable = (): ExplorerWritablePayload => ({
  version: 3,
  workspace: { recentRoots: ['/new'] },
  pinned: { paths: [] },
  nextWindowSeq: 4,
  windows: [
    {
      windowSeq: 0,
      workspace: { root: '/new' },
      explorer: { activePath: null, expandedPaths: ['/new'], sort },
    },
  ],
});

describe('topic49 6thS · mergeWritableIntoFull preserves restoreAllWindowsOnLaunch', () => {
  it('盘上 true、renderer 不携带 → merge 后仍为 true(不被抹掉)', () => {
    const current = defaultExplorerV3();
    current.restoreAllWindowsOnLaunch = true;

    // renderer 的 writable 不带 restoreAllWindowsOnLaunch(snapshotFromStores 从不写它)
    const w = writable();
    expect(w.restoreAllWindowsOnLaunch).toBeUndefined();

    const merged = mergeWritableIntoFull(current, w);
    expect(merged.restoreAllWindowsOnLaunch).toBe(true);
  });

  it('盘上未设 → merge 后不强行写出该字段(保持 undefined)', () => {
    const current = defaultExplorerV3();
    expect(current.restoreAllWindowsOnLaunch).toBeUndefined();

    const merged = mergeWritableIntoFull(current, writable());
    expect(merged.restoreAllWindowsOnLaunch).toBeUndefined();
    expect('restoreAllWindowsOnLaunch' in merged).toBe(false);
  });

  it('current 为 null 时不抛,沿用 writable(若带)', () => {
    const w = { ...writable(), restoreAllWindowsOnLaunch: true };
    const merged = mergeWritableIntoFull(null, w);
    expect(merged.restoreAllWindowsOnLaunch).toBe(true);
  });
});

// 边界(E138,E137 主进程写盘侧对偶):writable 来自 renderer IPC,schema 只校验 nonnegative int
//(zod .int() 不拒 unsafe integer)。merge 时只采纳安全整数的 writable.nextWindowSeq,否则忽略。
describe('mergeWritableIntoFull · nextWindowSeq safe-integer 守卫(E138)', () => {
  it('E138 writable.nextWindowSeq 为 unsafe integer → 忽略,保留磁盘安全值(不污染)', () => {
    const current = defaultExplorerV3();
    current.nextWindowSeq = 7; // 磁盘 main-owned 安全值
    const w = { ...writable(), nextWindowSeq: Number.MAX_SAFE_INTEGER + 2 };
    const merged = mergeWritableIntoFull(current, w);
    expect(Number.isSafeInteger(merged.nextWindowSeq)).toBe(true);
    expect(merged.nextWindowSeq).toBe(7); // unsafe 被忽略,max 保留磁盘值
  });

  it('E138 writable.nextWindowSeq 安全且更大 → 正常取 max(不回退)', () => {
    const current = defaultExplorerV3();
    current.nextWindowSeq = 2;
    const w = { ...writable(), nextWindowSeq: 9 };
    const merged = mergeWritableIntoFull(current, w);
    expect(merged.nextWindowSeq).toBe(9);
  });
});
