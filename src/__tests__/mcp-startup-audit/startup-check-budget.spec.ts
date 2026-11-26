// 规则 4:启动候选检查预算 —— 无效候选同样消耗预算,不得触发海量同步 stat。
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_STARTUP_DIR_CHECKS,
  pickArgvFolders,
} from '../../../electron/main/services/cli-args.service';
import { pickStartupMode } from '../../../electron/main/services/startup-mode.service';
import {
  MAX_RESTORE_CHECKS,
  pickWindowsToRestore,
} from '../../../electron/main/services/window-restore.service';

describe('规则 4 · pickArgvFolders 候选检查预算', () => {
  it('海量不存在的绝对路径 → isExistingDir 调用次数 ≤ 预算', () => {
    const argv = ['/app', ...Array.from({ length: 10_000 }, (_, i) => `/nope/${i}`)];
    const isDir = vi.fn(() => false);
    expect(pickArgvFolders(argv, isDir, { skipFirstArg: false })).toEqual([]);
    expect(isDir).toHaveBeenCalledTimes(MAX_STARTUP_DIR_CHECKS);
  });

  it('预算内的合法目录照常收集', () => {
    const isDir = vi.fn((p: string) => p === '/ok');
    expect(pickArgvFolders(['/app', '/nope', '/ok'], isDir, { skipFirstArg: false })).toEqual([
      '/ok',
    ]);
  });
});

describe('规则 4 · pickWindowsToRestore 候选检查预算', () => {
  it('海量指向不存在目录的段 → isExistingDir 调用次数 ≤ 预算', async () => {
    const windows = Array.from({ length: 10_000 }, (_, i) => ({
      windowSeq: i + 1,
      workspace: { root: `/gone/${i}` },
    }));
    const isDir = vi.fn(() => false);
    const out = await pickWindowsToRestore(
      // 上次退出时这些窗口都开着(openWindowSeqs),否则根本不进候选
      { restoreAllWindowsOnLaunch: true, openWindowSeqs: [0, ...windows.map((w) => w.windowSeq)], windows } as never,
      isDir,
    );
    expect(out).toEqual([]);
    expect(isDir).toHaveBeenCalledTimes(MAX_RESTORE_CHECKS);
  });
});

describe('规则 4 · pickStartupMode(open-file 缓冲,兄弟入口)候选检查预算', () => {
  it('海量不存在的路径 → isExistingDir 调用次数 ≤ 预算', () => {
    const paths = Array.from({ length: 10_000 }, (_, i) => `/nope/${i}`);
    const isDir = vi.fn(() => false);
    expect(pickStartupMode(paths, isDir)).toEqual({ mode: 'restore' });
    expect(isDir).toHaveBeenCalledTimes(MAX_STARTUP_DIR_CHECKS);
  });
});
