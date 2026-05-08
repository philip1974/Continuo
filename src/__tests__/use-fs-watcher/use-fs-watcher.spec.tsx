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
