import { describe, it, expect } from 'vitest';
import { pickWindowsToRestore } from '../../../electron/main/services/window-restore.service';
import type { ExplorerPayload } from '../../../electron/main/persistence';

const allDirs = (_p: string) => true;
const noDirs = (_p: string) => false;

function snap(
  windows: ExplorerPayload['windows'],
  nextWindowSeq = windows.length,
): ExplorerPayload {
  return {
    version: 2,
    workspace: { recentRoots: [] },
    pinned: { paths: [] },
    nextWindowSeq,
    windows,
  };
}

const win = (over: Partial<ExplorerPayload['windows'][number]>): ExplorerPayload['windows'][number] => ({
  windowSeq: 0,
  workspace: { root: '/x' },
  explorer: {
    activePath: null,
    expandedPaths: [],
    sort: { by: 'name', reverse: false },
  },
  ...over,
});

describe('pickWindowsToRestore', () => {
  it('只有主窗段(windowSeq=0)→ 返回空(主窗主动开,不重复)', () => {
    const data = snap([win({ windowSeq: 0, workspace: { root: '/p' } })]);
    expect(pickWindowsToRestore(data, allDirs)).toEqual([]);
  });

  it('多窗段(0 + 1 + 2)→ 跳过 0,返回其它 windowSeq + workspace', () => {
    const data = snap([
      win({ windowSeq: 0, workspace: { root: '/p0' } }),
      win({ windowSeq: 1, workspace: { root: '/p1' } }),
      win({ windowSeq: 2, workspace: { root: '/p2' } }),
    ]);
    expect(pickWindowsToRestore(data, allDirs)).toEqual([
      { windowSeq: 1, workspace: '/p1' },
      { windowSeq: 2, workspace: '/p2' },
    ]);
  });

  it('windowSeq>0 段 workspace=null → 跳过(空 workspace 无恢复语义)', () => {
    const data = snap([
      win({ windowSeq: 0, workspace: { root: '/p0' } }),
      win({ windowSeq: 1, workspace: { root: null } }),
      win({ windowSeq: 2, workspace: { root: '/p2' } }),
    ]);
    expect(pickWindowsToRestore(data, allDirs)).toEqual([
      { windowSeq: 2, workspace: '/p2' },
    ]);
  });

  it('workspace 路径已不存在 / 非目录 → 跳过(用户删项目;段保留以防 mount 改回来)', () => {
    const data = snap([
      win({ windowSeq: 0, workspace: { root: '/p0' } }),
      win({ windowSeq: 1, workspace: { root: '/gone' } }),
      win({ windowSeq: 2, workspace: { root: '/exists' } }),
    ]);
    const isDir = (p: string) => p === '/exists';
    expect(pickWindowsToRestore(data, isDir)).toEqual([
      { windowSeq: 2, workspace: '/exists' },
    ]);
  });

  it('全部 workspace 路径不存在 → 返回空(只剩主窗)', () => {
    const data = snap([
      win({ windowSeq: 0, workspace: { root: '/p0' } }),
      win({ windowSeq: 1, workspace: { root: '/gone1' } }),
      win({ windowSeq: 2, workspace: { root: '/gone2' } }),
    ]);
    expect(pickWindowsToRestore(data, noDirs)).toEqual([]);
  });

  it('保留 windows[] 物理顺序', () => {
    const data = snap([
      win({ windowSeq: 0, workspace: { root: '/p0' } }),
      win({ windowSeq: 5, workspace: { root: '/p5' } }),
      win({ windowSeq: 2, workspace: { root: '/p2' } }),
    ]);
    expect(pickWindowsToRestore(data, allDirs).map((r) => r.windowSeq)).toEqual([
      5,
      2,
    ]);
  });

  it('windows=[] → 空(冷启首次没任何段)', () => {
    const data = snap([]);
    expect(pickWindowsToRestore(data, allDirs)).toEqual([]);
  });
});
