// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { useFsWatcher } from '../../panels/Explorer/hooks/useFsWatcher';
import { onWatchRestored } from '../../lib/fs-watch-restored';

interface FakeFs {
  watchDir: ReturnType<typeof vi.fn>;
  unwatchDir: ReturnType<typeof vi.fn>;
  onDirChanged: (cb: (path: string) => void) => () => void;
  onWatchLost?: (cb: (path: string) => void) => () => void;
}

function installFs(fs: FakeFs): void {
  Object.defineProperty(window, 'api', {
    value: { fs: { onWatchLost: () => () => {}, ...fs } },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  delete (window as { api?: unknown }).api;
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useFsWatcher', () => {
  it('首次挂载 → 对所有 expandedPaths 调 watchDir', () => {
    const watchDir = vi.fn().mockResolvedValue({ ok: true });
    installFs({
      watchDir,
      unwatchDir: vi.fn(),
      onDirChanged: () => () => {},
    });

    renderHook(() =>
      useFsWatcher(new Set(['/a', '/b']), vi.fn()),
    );
    const calls = watchDir.mock.calls.map((c) => c[0]).sort();
    expect(calls).toEqual(['/a', '/b']);
  });

  it('expandedPaths 增加 → watchDir 增量 path', () => {
    const watchDir = vi.fn().mockResolvedValue({ ok: true });
    const unwatchDir = vi.fn().mockResolvedValue({ ok: true });
    installFs({ watchDir, unwatchDir, onDirChanged: () => () => {} });

    const { rerender } = renderHook(
      ({ paths }: { paths: Set<string> }) => useFsWatcher(paths, vi.fn()),
      { initialProps: { paths: new Set(['/a']) } },
    );
    expect(watchDir.mock.calls.map((c) => c[0])).toEqual(['/a']);

    rerender({ paths: new Set(['/a', '/b']) });
    // 仅 /b 是新增的
    expect(watchDir.mock.calls.map((c) => c[0])).toEqual(['/a', '/b']);
    expect(unwatchDir).not.toHaveBeenCalled();
  });

  it('expandedPaths 减少 → unwatchDir 移除的 path', () => {
    const watchDir = vi.fn().mockResolvedValue({ ok: true });
    const unwatchDir = vi.fn().mockResolvedValue({ ok: true });
    installFs({ watchDir, unwatchDir, onDirChanged: () => () => {} });

    const { rerender } = renderHook(
      ({ paths }: { paths: Set<string> }) => useFsWatcher(paths, vi.fn()),
      { initialProps: { paths: new Set(['/a', '/b']) } },
    );
    rerender({ paths: new Set(['/a']) });
    expect(unwatchDir.mock.calls.map((c) => c[0])).toEqual(['/b']);
  });

  it('fs:dir-changed → debounce 100ms 后调 onChange', () => {
    let dirCb: ((p: string) => void) | null = null;
    installFs({
      watchDir: vi.fn().mockResolvedValue({ ok: true }),
      unwatchDir: vi.fn().mockResolvedValue({ ok: true }),
      onDirChanged: (cb) => {
        dirCb = cb;
        return () => {};
      },
    });

    const onChange = vi.fn();
    renderHook(() => useFsWatcher(new Set(), onChange));

    dirCb!('/a');
    dirCb!('/a');
    dirCb!('/a');
    expect(onChange).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('/a');
  });

  // 性能:dir-changed 是全窗口广播,别的窗口工作区的目录变化也会送达;传入 root 后
  // root 外路径在进入 debouncer 前丢弃,不再触发本 Explorer 无效 invalidation→listDir。
  it('传入 root → 只对 root 自身及其内部路径回调 onChange,root 外事件丢弃', () => {
    let dirCb: ((p: string) => void) | null = null;
    installFs({
      watchDir: vi.fn().mockResolvedValue({ ok: true }),
      unwatchDir: vi.fn().mockResolvedValue({ ok: true }),
      onDirChanged: (cb) => {
        dirCb = cb;
        return () => {};
      },
    });

    const onChange = vi.fn();
    renderHook(() => useFsWatcher(new Set(), onChange, '/ws'));

    dirCb!('/ws');
    dirCb!('/ws/src');
    dirCb!('/other/src');
    dirCb!('/wsx'); // 前缀相同但不在 root 内(路径边界)
    vi.advanceTimersByTime(100);
    expect(onChange.mock.calls.map((c) => c[0]).sort()).toEqual(['/ws', '/ws/src']);
  });

  it('卸载 → 当前 expandedPaths 全 unwatchDir + onDirChanged unsub', () => {
    const unwatchDir = vi.fn().mockResolvedValue({ ok: true });
    const unsubFn = vi.fn();
    installFs({
      watchDir: vi.fn().mockResolvedValue({ ok: true }),
      unwatchDir,
      onDirChanged: () => unsubFn,
    });

    const { unmount } = renderHook(() =>
      useFsWatcher(new Set(['/a', '/b']), vi.fn()),
    );
    unmount();

    const unwatched = unwatchDir.mock.calls.map((c) => c[0]).sort();
    expect(unwatched).toEqual(['/a', '/b']);
    expect(unsubFn).toHaveBeenCalledTimes(1);
  });
});

// race(R14):watchDir 异步失败(ok:false / reject)的目录不得被记为「已安装 watch」,否则
// expandedPaths 不变时永不重试;下次 expandedPaths 变化时应重新尝试该 path。
describe('useFsWatcher · R14 失败不记账可重试', () => {
  it('watchDir 失败 → 不记 installed,下次 expandedPaths 变化重试该 path', async () => {
    const watchDir = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, code: 'EACCES' }) // /a 首次失败
      .mockResolvedValue({ ok: true });
    installFs({
      watchDir,
      unwatchDir: vi.fn().mockResolvedValue({ ok: true }),
      onDirChanged: () => () => {},
    });

    const { rerender } = renderHook(
      ({ paths }: { paths: ReadonlySet<string> }) => useFsWatcher(paths, vi.fn()),
      { initialProps: { paths: new Set(['/a']) } },
    );
    // flush:/a 的 watchDir 失败 → 异步撤销记账(installed.delete)
    await Promise.resolve();
    await Promise.resolve();

    // 展开新增 /b → effect 重跑;/a 不在 installed(失败已撤销)→ 重试 watchDir('/a')
    rerender({ paths: new Set(['/a', '/b']) });
    await Promise.resolve();
    await Promise.resolve();

    const aCalls = watchDir.mock.calls.filter((c) => c[0] === '/a').length;
    expect(aCalls).toBe(2); // 首次失败 + 重试
  });

  // race(R37):collapse→re-expand 同一 path 时,第一次迟到的失败回调不得删掉第二次已成功安装的
  // 记账(否则 watcher 泄漏:后续 collapse 不 unwatch / 重复 watch 增 refCount)。代际校验拦住。
  it('R37 collapse→re-expand 后第一次迟到失败不删第二次成功记账', async () => {
    let rejectFirst: (e: unknown) => void = () => {};
    let aCall = 0;
    const watchDir = vi.fn((p: string) => {
      if (p === '/a') {
        aCall += 1;
        if (aCall === 1) {
          return new Promise((_res, rej) => {
            rejectFirst = rej;
          }); // 第一次:在途,稍后迟到 reject
        }
        return Promise.resolve({ ok: true }); // 第二次:成功
      }
      return Promise.resolve({ ok: true });
    });
    const unwatchDir = vi.fn().mockResolvedValue({ ok: true });
    installFs({ watchDir, unwatchDir, onDirChanged: () => () => {} });

    const { rerender } = renderHook(
      ({ paths }: { paths: ReadonlySet<string> }) => useFsWatcher(paths, vi.fn()),
      { initialProps: { paths: new Set(['/a']) } },
    );
    rerender({ paths: new Set<string>() }); // collapse /a(unwatch + bump 代际)
    rerender({ paths: new Set(['/a']) }); // re-expand /a → 第二次 watchDir 成功
    await Promise.resolve();
    await Promise.resolve();

    // 第一次迟到 reject(过期代际)→ 不得删 installed['/a']。
    rejectFirst(new Error('stale ENOENT'));
    await Promise.resolve();
    await Promise.resolve();

    // 验证 installed 仍含 /a:再 collapse 应 unwatchDir('/a')(若被误删则 removed 不含 /a → 不 unwatch)。
    unwatchDir.mockClear();
    rerender({ paths: new Set<string>() });
    expect(unwatchDir.mock.calls.map((c) => c[0])).toContain('/a');
  });

  // race(R109):watchDir 在途时卸载,迟到的 watch 成功后须补发 unwatchDir 抵消可能的孤儿 watcher
  // (卸载时 fire 的 unwatch 可能先于本 watch 到达 main → unwatch 落空、watch 后建成无主 watcher)。
  it('R109 watchDir 在途时卸载 → watch 成功后补发 unwatch', async () => {
    let resolveWatch: (v: { ok: boolean }) => void = () => {};
    const watchDir = vi.fn().mockReturnValue(
      new Promise((r) => {
        resolveWatch = r;
      }),
    );
    const unwatchDir = vi.fn().mockResolvedValue({ ok: true });
    installFs({ watchDir, unwatchDir, onDirChanged: () => () => {} });

    const { unmount } = renderHook(() =>
      useFsWatcher(new Set(['/a']), vi.fn()),
    );
    expect(watchDir).toHaveBeenCalledWith('/a'); // watch 在途

    unmount(); // 卸载:bulk cleanup unwatchDir('/a') 一次
    expect(unwatchDir.mock.calls.filter((c) => c[0] === '/a').length).toBe(1);

    resolveWatch({ ok: true }); // 迟到 watch 成功
    await Promise.resolve();
    await Promise.resolve();
    // 补发第二次 unwatchDir('/a') 抵消孤儿(main owner-guarded unwatch 对此 double-unwatch 安全)
    expect(unwatchDir.mock.calls.filter((c) => c[0] === '/a').length).toBe(2);
  });

  // race(R109):collapse(未 re-expand)期间 watch 在途,成功后同样补发 unwatch。
  it('R109 collapse 后迟到 watch 成功 → 补发 unwatch', async () => {
    let resolveWatch: (v: { ok: boolean }) => void = () => {};
    const watchDir = vi.fn((p: string) => {
      if (p === '/a')
        return new Promise((r) => {
          resolveWatch = r as (v: { ok: boolean }) => void;
        });
      return Promise.resolve({ ok: true });
    });
    const unwatchDir = vi.fn().mockResolvedValue({ ok: true });
    installFs({ watchDir, unwatchDir, onDirChanged: () => () => {} });

    const { rerender } = renderHook(
      ({ paths }: { paths: ReadonlySet<string> }) => useFsWatcher(paths, vi.fn()),
      { initialProps: { paths: new Set(['/a']) } },
    );
    rerender({ paths: new Set<string>() }); // collapse /a → unwatch('/a') 一次
    expect(unwatchDir.mock.calls.filter((c) => c[0] === '/a').length).toBe(1);

    resolveWatch({ ok: true }); // 迟到 watch 成功,/a 已不在 installed
    await Promise.resolve();
    await Promise.resolve();
    expect(unwatchDir.mock.calls.filter((c) => c[0] === '/a').length).toBe(2); // 补发
  });

  it('watchDir 成功 → 记 installed,expandedPaths 不变不重复 watch', async () => {
    const watchDir = vi.fn().mockResolvedValue({ ok: true });
    installFs({
      watchDir,
      unwatchDir: vi.fn().mockResolvedValue({ ok: true }),
      onDirChanged: () => () => {},
    });

    const { rerender } = renderHook(
      ({ paths }: { paths: ReadonlySet<string> }) => useFsWatcher(paths, vi.fn()),
      { initialProps: { paths: new Set(['/a']) } },
    );
    await Promise.resolve();
    await Promise.resolve();
    // 同 expandedPaths 引用变但内容相同 → /a 已 installed → 不重复 watch
    rerender({ paths: new Set(['/a']) });
    await Promise.resolve();

    expect(watchDir.mock.calls.filter((c) => c[0] === '/a').length).toBe(1);
  });
});

// main 因 FSWatcher error 驱逐失效 watcher 后推 fs:watch-lost:renderer 移出账本、刷新该目录,
// 退避延迟后若仍展开则重装;卷持续断开(反复失效)时延迟指数增长,不形成高频重试。
describe('useFsWatcher · watch-lost 退避重装', () => {
  async function flush(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  function setup(initial: Set<string>) {
    let lostCb: ((p: string) => void) | null = null;
    const watchDir = vi.fn().mockResolvedValue({ ok: true });
    const unwatchDir = vi.fn().mockResolvedValue({ ok: true });
    const lostUnsub = vi.fn();
    installFs({
      watchDir,
      unwatchDir,
      onDirChanged: () => () => {},
      onWatchLost: (cb) => {
        lostCb = cb;
        return lostUnsub;
      },
    });
    const onChange = vi.fn();
    const hook = renderHook(
      ({ paths }: { paths: ReadonlySet<string> }) => useFsWatcher(paths, onChange),
      { initialProps: { paths: initial } },
    );
    const lost = (p: string): void => lostCb!(p);
    const aCalls = (): number => watchDir.mock.calls.filter((c) => c[0] === '/a').length;
    return { hook, lost, watchDir, unwatchDir, onChange, aCalls, lostUnsub };
  }

  it('失效 → 立即刷新该目录;延迟后仍展开 → 重新 watchDir', async () => {
    const { lost, onChange, aCalls } = setup(new Set(['/a']));
    await flush();
    expect(aCalls()).toBe(1);

    lost('/a');
    expect(onChange).toHaveBeenCalledWith('/a');
    vi.advanceTimersByTime(1000);
    expect(aCalls()).toBe(1); // 不立即重试
    vi.advanceTimersByTime(5000);
    expect(aCalls()).toBe(2);
  });

  it('延迟期间已折叠 → 不重装;非已安装 path 的 lost 忽略', async () => {
    const { hook, lost, onChange, aCalls, watchDir } = setup(new Set(['/a']));
    await flush();
    lost('/zzz');
    expect(onChange).not.toHaveBeenCalled();
    lost('/a');
    hook.rerender({ paths: new Set<string>() });
    vi.advanceTimersByTime(120_000);
    expect(aCalls()).toBe(1);
    expect(watchDir.mock.calls.some((c) => c[0] === '/zzz')).toBe(false);
  });

  it('反复失效 → 重试延迟指数退避且有上限', async () => {
    const { lost, aCalls } = setup(new Set(['/a']));
    await flush();
    const delays: number[] = [];
    for (let i = 0; i < 8; i++) {
      lost('/a');
      const before = aCalls();
      let waited = 0;
      while (aCalls() === before && waited < 600_000) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }
      await flush();
      delays.push(waited);
    }
    for (let i = 1; i < delays.length; i++) expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(delays.at(-1)!).toBeGreaterThan(delays[0]! * 4);
    expect(delays.at(-1)!).toBeLessThanOrEqual(60_000);
  });

  it('重装时卷仍不可用(ok:false / reject)→ 继续按退避重试直到成功', async () => {
    const { lost, aCalls, watchDir } = setup(new Set(['/a']));
    await flush();
    watchDir
      .mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error('ENOENT'))
      .mockResolvedValue({ ok: true });
    lost('/a');
    vi.advanceTimersByTime(2000); // 首次重装(失败 ok:false)
    await flush();
    expect(aCalls()).toBe(2);
    vi.advanceTimersByTime(3999);
    await flush();
    expect(aCalls()).toBe(2); // 退避翻倍到 4s
    vi.advanceTimersByTime(1);
    await flush();
    expect(aCalls()).toBe(3); // 第二次重装(reject)
    vi.advanceTimersByTime(8000);
    await flush();
    expect(aCalls()).toBe(4); // 第三次重装成功
    vi.advanceTimersByTime(600_000);
    await flush();
    expect(aCalls()).toBe(4); // 成功后不再重试
  });

  it('重试中折叠 → 停止重试', async () => {
    const { hook, lost, aCalls, watchDir } = setup(new Set(['/a']));
    await flush();
    watchDir.mockResolvedValue({ ok: false });
    lost('/a');
    vi.advanceTimersByTime(2000);
    await flush();
    expect(aCalls()).toBe(2);
    hook.rerender({ paths: new Set<string>() });
    vi.advanceTimersByTime(600_000);
    await flush();
    expect(aCalls()).toBe(2);
  });

  it('重装成功 → 再刷新一次该目录并本地分发「重新可观察」(补断线期间的变化)', async () => {
    const restored: string[] = [];
    const off = onWatchRestored((p) => restored.push(p));
    try {
      const { lost, onChange } = setup(new Set(['/a']));
      await flush();
      lost('/a');
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(restored).toEqual([]);
      vi.advanceTimersByTime(2000);
      await flush();
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(restored).toEqual(['/a']);
    } finally {
      off();
    }
  });

  it('退避期间展开别的目录 → 普通 diff 抢先重装失效 path,成功时同样恢复刷新并分发「重新可观察」', async () => {
    const restored: string[] = [];
    const off = onWatchRestored((p) => restored.push(p));
    try {
      const { hook, lost, onChange, aCalls } = setup(new Set(['/a']));
      await flush();
      lost('/a');
      expect(onChange).toHaveBeenCalledTimes(1);
      hook.rerender({ paths: new Set(['/a', '/b']) }); // diff 把 /a 列为 added → 普通 installWatch
      await flush();
      expect(aCalls()).toBe(2);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onChange).toHaveBeenLastCalledWith('/a');
      expect(restored).toEqual(['/a']);
      vi.advanceTimersByTime(600_000); // 原定时器发现已重装 → 退出,不重复分发
      await flush();
      expect(aCalls()).toBe(2);
      expect(restored).toEqual(['/a']);
    } finally {
      off();
    }
  });

  it('失效后折叠再展开同一 path → 重新安装成功时恢复刷新并分发「重新可观察」(仅一次)', async () => {
    const restored: string[] = [];
    const off = onWatchRestored((p) => restored.push(p));
    try {
      const { hook, lost, onChange } = setup(new Set(['/a']));
      await flush();
      lost('/a');
      hook.rerender({ paths: new Set<string>() });
      hook.rerender({ paths: new Set(['/a']) });
      await flush();
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(restored).toEqual(['/a']);
      hook.rerender({ paths: new Set<string>() });
      hook.rerender({ paths: new Set(['/a']) });
      await flush();
      expect(restored).toEqual(['/a']); // 已恢复,再次正常安装不分发
    } finally {
      off();
    }
  });

  it('首次安装成功不分发「重新可观察」', async () => {
    const restored: string[] = [];
    const off = onWatchRestored((p) => restored.push(p));
    try {
      const { onChange } = setup(new Set(['/a']));
      await flush();
      expect(restored).toEqual([]);
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it('失效后折叠再展开 → 下一次失效的退避从 2s 重新开始', async () => {
    const { hook, lost, aCalls } = setup(new Set(['/a']));
    await flush();
    lost('/a'); // lostCount=1,/a 已移出账本
    hook.rerender({ paths: new Set<string>() });
    hook.rerender({ paths: new Set(['/a']) });
    await flush();
    expect(aCalls()).toBe(2); // 重新展开 → 正常安装
    lost('/a');
    vi.advanceTimersByTime(2000);
    await flush();
    expect(aCalls()).toBe(3); // 未沿用旧退避(否则需 4s)
  });

  it('失效 → 退避期间折叠 → 卷仍不可用时重新展开且首次安装失败 → 按退避继续重试直到成功', async () => {
    const restored: string[] = [];
    const off = onWatchRestored((p) => restored.push(p));
    try {
      const { hook, lost, aCalls, watchDir } = setup(new Set(['/a']));
      await flush();
      lost('/a');
      hook.rerender({ paths: new Set<string>() }); // 折叠:清定时器 + 退避清零
      watchDir
        .mockResolvedValueOnce({ ok: false })
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValue({ ok: true });
      hook.rerender({ paths: new Set(['/a']) }); // 重新展开 → 普通 diff 安装,失败
      await flush();
      expect(aCalls()).toBe(2);
      vi.advanceTimersByTime(2000); // 折叠已清零退避 → 从 2s 起
      await flush();
      expect(aCalls()).toBe(3); // 续排重试(reject)
      vi.advanceTimersByTime(3999);
      await flush();
      expect(aCalls()).toBe(3);
      vi.advanceTimersByTime(1);
      await flush();
      expect(aCalls()).toBe(4); // 退避翻倍后成功
      expect(restored).toEqual(['/a']);
      vi.advanceTimersByTime(600_000);
      await flush();
      expect(aCalls()).toBe(4);
    } finally {
      off();
    }
  });

  it('从未失效的 path 首次安装失败 → 不自动退避重试(仅等下一次 diff)', async () => {
    const { hook, aCalls, watchDir } = setup(new Set<string>());
    watchDir.mockResolvedValue({ ok: false });
    hook.rerender({ paths: new Set(['/a']) });
    await flush();
    expect(aCalls()).toBe(1);
    vi.advanceTimersByTime(600_000);
    await flush();
    expect(aCalls()).toBe(1);
  });

  it('卸载 → 退订 watch-lost 且取消待重试', async () => {
    const { hook, lost, aCalls, lostUnsub } = setup(new Set(['/a']));
    await flush();
    lost('/a');
    hook.unmount();
    expect(lostUnsub).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(120_000);
    expect(aCalls()).toBe(1);
  });
});
