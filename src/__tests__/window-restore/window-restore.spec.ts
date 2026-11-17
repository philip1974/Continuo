import { describe, it, expect, vi } from 'vitest';
import {
  pickWindowsToRestore,
  MAX_RESTORE_WINDOWS,
  MAX_RESTORE_CHECKS,
  RESTORE_CHECK_CONCURRENCY,
} from '../../../electron/main/services/window-restore.service';
import { MAX_STARTUP_DIR_PATH_LEN } from '../../../electron/main/services/cli-args.service';
import type { ExplorerPayload } from '../../../electron/main/persistence';

const allDirs = (_p: string) => true;
const noDirs = (_p: string) => false;

function snap(
  windows: ExplorerPayload['windows'],
  nextWindowSeq = windows.length,
  restoreAllWindowsOnLaunch = true,  // opt-in 改默认后:测试用 true 保留原行为断言
): ExplorerPayload {
  return {
    version: 2,
    workspace: { recentRoots: [] },
    pinned: { paths: [] },
    nextWindowSeq,
    windows,
    restoreAllWindowsOnLaunch,
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
  it('只有主窗段(windowSeq=0)→ 返回空(主窗主动开,不重复)', async () => {
    const data = snap([win({ windowSeq: 0, workspace: { root: '/p' } })]);
    expect(await pickWindowsToRestore(data, allDirs)).toEqual([]);
  });

  it('只有主窗段时复用稳定空数组,不预分配恢复数组', async () => {
    const data = snap([win({ windowSeq: 0, workspace: { root: '/p' } })]);
    const first = await pickWindowsToRestore(data, allDirs);
    const second = await pickWindowsToRestore(data, allDirs);
    const src = pickWindowsToRestore.toString();

    expect(second).toBe(first);
    expect(src).not.toContain('const out = new Array');
    expect(src).not.toContain('const seenSeq = new Set');
  });

  it('多窗段(0 + 1 + 2)→ 跳过 0,返回其它 windowSeq + workspace', async () => {
    const data = snap([
      win({ windowSeq: 0, workspace: { root: '/p0' } }),
      win({ windowSeq: 1, workspace: { root: '/p1' } }),
      win({ windowSeq: 2, workspace: { root: '/p2' } }),
    ]);
    expect(await pickWindowsToRestore(data, allDirs)).toEqual([
      { windowSeq: 1, workspace: '/p1' },
      { windowSeq: 2, workspace: '/p2' },
    ]);
  });

  it('windowSeq>0 段 workspace=null → 跳过(空 workspace 无恢复语义)', async () => {
    const data = snap([
      win({ windowSeq: 0, workspace: { root: '/p0' } }),
      win({ windowSeq: 1, workspace: { root: null } }),
      win({ windowSeq: 2, workspace: { root: '/p2' } }),
    ]);
    expect(await pickWindowsToRestore(data, allDirs)).toEqual([
      { windowSeq: 2, workspace: '/p2' },
    ]);
  });

  it('workspace 路径已不存在 / 非目录 → 跳过(用户删项目;段保留以防 mount 改回来)', async () => {
    const data = snap([
      win({ windowSeq: 0, workspace: { root: '/p0' } }),
      win({ windowSeq: 1, workspace: { root: '/gone' } }),
      win({ windowSeq: 2, workspace: { root: '/exists' } }),
    ]);
    const isDir = (p: string) => p === '/exists';
    expect(await pickWindowsToRestore(data, isDir)).toEqual([
      { windowSeq: 2, workspace: '/exists' },
    ]);
  });

  it('全部 workspace 路径不存在 → 返回空(只剩主窗)', async () => {
    const data = snap([
      win({ windowSeq: 0, workspace: { root: '/p0' } }),
      win({ windowSeq: 1, workspace: { root: '/gone1' } }),
      win({ windowSeq: 2, workspace: { root: '/gone2' } }),
    ]);
    expect(await pickWindowsToRestore(data, noDirs)).toEqual([]);
  });

  it('保留 windows[] 物理顺序', async () => {
    const data = snap([
      win({ windowSeq: 0, workspace: { root: '/p0' } }),
      win({ windowSeq: 5, workspace: { root: '/p5' } }),
      win({ windowSeq: 2, workspace: { root: '/p2' } }),
    ]);
    expect((await pickWindowsToRestore(data, allDirs)).map((r) => r.windowSeq)).toEqual([
      5,
      2,
    ]);
  });

  it('windows=[] → 空(冷启首次没任何段)', async () => {
    const data = snap([]);
    expect(await pickWindowsToRestore(data, allDirs)).toEqual([]);
  });

  it('restoreAllWindowsOnLaunch undefined (默认) → 空(只开主窗,opt-in 改默认)', async () => {
    const data = snap(
      [
        win({ windowSeq: 0, workspace: { root: '/p0' } }),
        win({ windowSeq: 1, workspace: { root: '/p1' } }),
      ],
      2,
      undefined as unknown as boolean,
    );
    delete (data as { restoreAllWindowsOnLaunch?: boolean }).restoreAllWindowsOnLaunch;
    expect(await pickWindowsToRestore(data, allDirs)).toEqual([]);
  });

  it('restoreAllWindowsOnLaunch=false → 空(显式 opt-out)', async () => {
    const data = snap(
      [
        win({ windowSeq: 0, workspace: { root: '/p0' } }),
        win({ windowSeq: 1, workspace: { root: '/p1' } }),
      ],
      2,
      false,
    );
    expect(await pickWindowsToRestore(data, allDirs)).toEqual([]);
  });

  // 边界(E60,E58/E59 启动外部输入族):启动恢复窗口数上限 + 超长 workspace 路径先跳过(不 stat)。
  describe('E60 · 启动恢复上限', () => {
    it('恢复窗口数超 MAX_RESTORE_WINDOWS → 封顶且停止同步 stat', async () => {
      const isDir = vi.fn(() => true);
      const windows = [
        win({ windowSeq: 0, workspace: { root: '/p0' } }),
        ...Array.from({ length: MAX_RESTORE_WINDOWS + 30 }, (_, i) =>
          win({ windowSeq: i + 1, workspace: { root: `/p${i + 1}` } }),
        ),
      ];
      const data = snap(windows, windows.length, true);
      const r = await pickWindowsToRestore(data, isDir);
      expect(r).toHaveLength(MAX_RESTORE_WINDOWS); // 封顶,不批量开成千上万窗
      expect(isDir.mock.calls.length).toBeLessThanOrEqual(MAX_RESTORE_WINDOWS);
      expect(pickWindowsToRestore.toString()).not.toContain('out.push(');
    });

    it('超长 workspace 路径 → 跳过且不 stat', async () => {
      const isDir = vi.fn(() => true);
      const longRoot = '/' + 'x'.repeat(MAX_STARTUP_DIR_PATH_LEN);
      const data = snap(
        [
          win({ windowSeq: 0, workspace: { root: '/p0' } }),
          win({ windowSeq: 1, workspace: { root: longRoot } }),
          win({ windowSeq: 2, workspace: { root: '/ok' } }),
        ],
        3,
        true,
      );
      const r = await pickWindowsToRestore(data, isDir);
      expect(r.map((x) => x.workspace)).toEqual(['/ok']);
      expect(isDir).not.toHaveBeenCalledWith(longRoot);
    });
  });

  // 边界(E84,数据完整性):重复 windowSeq 段不为同一 seq 开多窗(会共享同段互相覆盖会话)。
  describe('E84 · 重复 windowSeq 去重', () => {
    it('多个相同 windowSeq 段 → 只恢复一次(首个 workspace)', async () => {
      const data = snap([
        win({ windowSeq: 0, workspace: { root: '/p0' } }),
        win({ windowSeq: 1, workspace: { root: '/dup-first' } }),
        win({ windowSeq: 1, workspace: { root: '/dup-second' } }),
        win({ windowSeq: 2, workspace: { root: '/p2' } }),
      ]);
      expect(await pickWindowsToRestore(data, allDirs)).toEqual([
        { windowSeq: 1, workspace: '/dup-first' }, // 同 seq 只一次,取首个
        { windowSeq: 2, workspace: '/p2' },
      ]);
    });
  });

  // 边界(E91):windowSeq 须安全整数。畸形 explorer.json 的 >MAX_SAFE_INTEGER seq 能过 schema
  // (int().nonnegative()),但 main/renderer 段编号认知不一致 → 启动恢复跳过。
  describe('E91 · 非安全整数 windowSeq', () => {
    it('windowSeq > MAX_SAFE_INTEGER → 启动恢复跳过', async () => {
      const data = snap([
        win({ windowSeq: 0, workspace: { root: '/p0' } }),
        win({
          windowSeq: Number.MAX_SAFE_INTEGER + 2, // 9007199254740993,不安全整数
          workspace: { root: '/unsafe' },
        }),
        win({ windowSeq: 3, workspace: { root: '/p3' } }),
      ]);
      expect(await pickWindowsToRestore(data, allDirs)).toEqual([
        { windowSeq: 3, workspace: '/p3' }, // 不安全 seq 段被跳过
      ]);
    });
  });

  // 性能(审计 #7):启动恢复原为 main 进程串行 statSync(最多 64 次),慢挂载/断开网络盘时阻塞主进程。
  // 改为 async 判定 + 小规模有界并发;恢复集合 / 上限 / 顺序与串行语义逐一一致。
  describe('#7 · async 有界并发判定', () => {
    function deferredIsDir(existing: (p: string) => boolean) {
      let inFlight = 0;
      let peak = 0;
      const pending: Array<() => void> = [];
      const fn = vi.fn(
        (p: string) =>
          new Promise<boolean>((resolve) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            pending.push(() => {
              inFlight -= 1;
              resolve(existing(p));
            });
          }),
      );
      // 逆序 settle 当前在途的全部判定(验证结果按原索引收集而非完成顺序)
      const flushReverse = async (): Promise<void> => {
        for (let guard = 0; guard < 1000; guard += 1) {
          await new Promise((r) => setTimeout(r, 0));
          if (pending.length === 0) return;
          const batch = pending.splice(0).reverse();
          for (const settle of batch) settle();
        }
      };
      return { fn, flushReverse, peak: () => peak };
    }

    it('判定并发执行但不超过 RESTORE_CHECK_CONCURRENCY,结果按 windows[] 原顺序', async () => {
      const windows = [
        win({ windowSeq: 0, workspace: { root: '/p0' } }),
        ...Array.from({ length: 30 }, (_, i) =>
          win({ windowSeq: i + 1, workspace: { root: `/p${i + 1}` } }),
        ),
      ];
      const d = deferredIsDir((p) => Number(p.slice(2)) % 3 !== 0);
      const promise = pickWindowsToRestore(snap(windows), d.fn);
      await d.flushReverse();
      const r = await promise;
      const expected = Array.from({ length: 30 }, (_, i) => i + 1)
        .filter((n) => n % 3 !== 0)
        .slice(0, MAX_RESTORE_WINDOWS);
      expect(r.map((x) => x.windowSeq)).toEqual(expected);
      expect(d.peak()).toBeGreaterThan(1);
      expect(d.peak()).toBeLessThanOrEqual(RESTORE_CHECK_CONCURRENCY);
    });

    it('候选检查预算与串行一致:全不存在时恰好判定 MAX_RESTORE_CHECKS 次', async () => {
      const windows = Array.from({ length: 500 }, (_, i) =>
        win({ windowSeq: i + 1, workspace: { root: `/gone/${i}` } }),
      );
      const d = deferredIsDir(() => false);
      const promise = pickWindowsToRestore(snap(windows), d.fn);
      await d.flushReverse();
      expect(await promise).toEqual([]);
      expect(d.fn).toHaveBeenCalledTimes(MAX_RESTORE_CHECKS);
    });

    it('开窗名额将满时不超额判定:判定次数与串行相同', async () => {
      const windows = [
        win({ windowSeq: 1, workspace: { root: '/gone' } }),
        ...Array.from({ length: 40 }, (_, i) =>
          win({ windowSeq: i + 2, workspace: { root: `/p${i + 2}` } }),
        ),
      ];
      const d = deferredIsDir((p) => p !== '/gone');
      const promise = pickWindowsToRestore(snap(windows), d.fn);
      await d.flushReverse();
      expect(await promise).toHaveLength(MAX_RESTORE_WINDOWS);
      expect(d.fn).toHaveBeenCalledTimes(MAX_RESTORE_WINDOWS + 1); // 串行:1 次未命中 + 16 次命中
    });

    it('重复 windowSeq:前段不存在时仍检查后段(与串行语义一致)', async () => {
      const data = snap([
        win({ windowSeq: 0, workspace: { root: '/p0' } }),
        win({ windowSeq: 1, workspace: { root: '/gone' } }),
        win({ windowSeq: 1, workspace: { root: '/dup-ok' } }),
        win({ windowSeq: 1, workspace: { root: '/dup-later' } }),
        win({ windowSeq: 2, workspace: { root: '/p2' } }),
      ]);
      const d = deferredIsDir((p) => p !== '/gone');
      const promise = pickWindowsToRestore(data, d.fn);
      await d.flushReverse();
      expect(await promise).toEqual([
        { windowSeq: 1, workspace: '/dup-ok' },
        { windowSeq: 2, workspace: '/p2' },
      ]);
      expect(d.fn).not.toHaveBeenCalledWith('/dup-later');
    });
  });
});
