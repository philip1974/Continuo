// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { useFsWatcher } from '../../panels/Explorer/hooks/useFsWatcher';

interface FakeFs {
  watchDir: ReturnType<typeof vi.fn>;
  unwatchDir: ReturnType<typeof vi.fn>;
  onDirChanged: (cb: (path: string) => void) => () => void;
}

function installFs(fs: FakeFs): void {
  Object.defineProperty(window, 'api', {
    value: { fs },
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
