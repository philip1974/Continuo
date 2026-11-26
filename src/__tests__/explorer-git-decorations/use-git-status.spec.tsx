// @vitest-environment jsdom
// BDD: explorer-git-decorations / 刷新:挂载取一次、换根后 main 未登记新根(stale)重试、根内 fs 变化 / 保存 / 获焦防抖刷新、根外忽略、单飞补跑、隐藏期间记脏、关闭不查询、换根丢旧
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { GIT_STATUS_STALE, type GitStatusSnapshot } from '../../../electron/shared/git-status';

const h = vi.hoisted(() => ({
  status: vi.fn(),
  dirListeners: new Set<(path: string, files?: unknown, changeOnly?: boolean) => void>(),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    git: { status: h.status },
    fs: {
      onDirChanged: (cb: (path: string, files?: unknown, changeOnly?: boolean) => void) => {
        h.dirListeners.add(cb);
        return () => h.dirListeners.delete(cb);
      },
    },
  },
}));

import {
  GIT_REFRESH_DEBOUNCE_MS,
  GIT_REFRESH_MAX_WAIT_MS,
  GIT_STALE_RETRY_MAX,
  GIT_STALE_RETRY_MS,
  useGitStatus,
} from '../../panels/Explorer/hooks/useGitStatus';
import { gitDecorationOf } from '../../panels/Explorer/git-decorations';
import { useEditorStore } from '../../stores/editor.store';

const snap = (root: string, entries: GitStatusSnapshot['entries']) => ({ ok: true as const, data: { root, entries } });
const dirChanged = (p: string, changeOnly = false) => {
  for (const cb of h.dirListeners) cb(p, undefined, changeOnly);
};
const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

beforeEach(() => {
  vi.useFakeTimers();
  h.status.mockReset();
  h.status.mockResolvedValue(snap('/w', [['a.ts', 'modified', 'M']]));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.dirListeners.clear();
});

describe('取快照', () => {
  it('挂载时取一次,返回可查询的索引', async () => {
    const { result } = renderHook(() => useGitStatus('/w', true, true));
    await flush();
    expect(h.status).toHaveBeenCalledTimes(1);
    expect(gitDecorationOf(result.current!, 'a.ts', false)).toEqual({ kind: 'modified', letter: 'M' });
  });

  it('非仓库(data=null)→ null', async () => {
    h.status.mockResolvedValue({ ok: true, data: null });
    const { result } = renderHook(() => useGitStatus('/w', true, true));
    await flush();
    expect(result.current).toBeNull();
  });

  it('IPC 抛错 → 静默 null', async () => {
    h.status.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useGitStatus('/w', true, true));
    await flush();
    expect(result.current).toBeNull();
  });

  it('装饰全关(enabled=false)→ 不查询', async () => {
    const { result } = renderHook(() => useGitStatus('/w', false, true));
    await flush();
    expect(h.status).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it('换根:旧快照立即不用;结果的根与当前根不符 → 丢弃', async () => {
    const { result, rerender } = renderHook(({ root }) => useGitStatus(root, true, true), {
      initialProps: { root: '/w' },
    });
    await flush();
    expect(result.current).not.toBeNull();
    h.status.mockResolvedValue(snap('/w', [['a.ts', 'modified', 'M']]));
    rerender({ root: '/other' });
    expect(result.current).toBeNull();
    await flush();
    expect(result.current).toBeNull();
  });
});

describe('换根后 main 尚未登记新根(stale)', () => {
  it('查询带上期望的根;stale → 稍后重试,登记到达后装饰出现(不靠获焦 / 文件变化)', async () => {
    h.status.mockResolvedValueOnce(snap('/w', [['a.ts', 'modified', 'M']]));
    const { result, rerender } = renderHook(({ root }) => useGitStatus(root, true, true), {
      initialProps: { root: '/w' },
    });
    await flush();
    expect(h.status).toHaveBeenLastCalledWith('/w');
    h.status.mockResolvedValueOnce({ ok: true, data: GIT_STATUS_STALE });
    h.status.mockResolvedValueOnce({ ok: true, data: GIT_STATUS_STALE });
    h.status.mockResolvedValue(snap('/b', [['x.ts', 'untracked', 'U']]));
    rerender({ root: '/b' });
    await flush();
    expect(h.status).toHaveBeenLastCalledWith('/b');
    expect(result.current).toBeNull();
    await act(async () => vi.advanceTimersByTime(GIT_STALE_RETRY_MS));
    await flush();
    expect(result.current).toBeNull();
    await act(async () => vi.advanceTimersByTime(GIT_STALE_RETRY_MS));
    await flush();
    expect(h.status).toHaveBeenCalledTimes(4);
    expect(gitDecorationOf(result.current!, 'x.ts', false)).toEqual({ kind: 'untracked', letter: 'U' });
  });

  it('一直 stale(根始终未登记)→ 重试有上限', async () => {
    h.status.mockResolvedValue({ ok: true, data: GIT_STATUS_STALE });
    const { result } = renderHook(() => useGitStatus('/w', true, true));
    for (let i = 0; i < GIT_STALE_RETRY_MAX + 5; i++) {
      await act(async () => vi.advanceTimersByTime(GIT_STALE_RETRY_MS));
      await flush();
    }
    expect(h.status).toHaveBeenCalledTimes(GIT_STALE_RETRY_MAX + 1);
    expect(result.current).toBeNull();
  });

  it('卸载后不再重试', async () => {
    h.status.mockResolvedValue({ ok: true, data: GIT_STATUS_STALE });
    const { unmount } = renderHook(() => useGitStatus('/w', true, true));
    await flush();
    unmount();
    await act(async () => vi.advanceTimersByTime(GIT_STALE_RETRY_MS * 5));
    expect(h.status).toHaveBeenCalledTimes(1);
  });
});

describe('刷新时机', () => {
  it('根内 fs 变化(含仅内容变化)→ 防抖后刷新;根外忽略', async () => {
    renderHook(() => useGitStatus('/w', true, true));
    await flush();
    dirChanged('/elsewhere/x');
    await act(async () => vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10));
    expect(h.status).toHaveBeenCalledTimes(1);
    dirChanged('/w/src', true);
    dirChanged('/w/src', true);
    await act(async () => vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS - 10));
    expect(h.status).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(20));
    expect(h.status).toHaveBeenCalledTimes(2);
  });

  it('持续变化下至多每 maxWait 刷新一次', async () => {
    renderHook(() => useGitStatus('/w', true, true));
    await flush();
    for (let t = 0; t <= GIT_REFRESH_MAX_WAIT_MS; t += 100) {
      dirChanged('/w/log');
      await act(async () => vi.advanceTimersByTime(100));
    }
    expect(h.status).toHaveBeenCalledTimes(2);
  });

  it('窗口获焦 → 刷新', async () => {
    renderHook(() => useGitStatus('/w', true, true));
    await flush();
    window.dispatchEvent(new Event('focus'));
    await act(async () => vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10));
    expect(h.status).toHaveBeenCalledTimes(2);
  });

  it('编辑器保存(已落盘内容变化)→ 刷新', async () => {
    const base = { id: '/w/a.ts', filePath: '/w/a.ts', content: 'x', originalContent: 'a', dirty: true };
    useEditorStore.setState({ tabs: [base] } as never);
    renderHook(() => useGitStatus('/w', true, true));
    await flush();
    useEditorStore.setState({ tabs: [{ ...base, content: 'xy' }] } as never); // 只是输入
    await act(async () => vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10));
    expect(h.status).toHaveBeenCalledTimes(1);
    useEditorStore.setState({ tabs: [{ ...base, content: 'xy', originalContent: 'xy', dirty: false }] } as never);
    await act(async () => vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10));
    expect(h.status).toHaveBeenCalledTimes(2);
    useEditorStore.setState({ tabs: [] } as never);
  });

  it('在途时再触发:不并发,完成后补跑一次', async () => {
    let release!: (v: unknown) => void;
    h.status.mockImplementationOnce(() => new Promise((r) => (release = r)));
    renderHook(() => useGitStatus('/w', true, true));
    await flush();
    window.dispatchEvent(new Event('focus'));
    await act(async () => vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10));
    dirChanged('/w/a');
    await act(async () => vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10));
    expect(h.status).toHaveBeenCalledTimes(1);
    release(snap('/w', []));
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
  });

  it('侧栏隐藏期间不查询,只记脏;再次显示时补一次', async () => {
    const { rerender } = renderHook(({ visible }) => useGitStatus('/w', true, visible), {
      initialProps: { visible: true },
    });
    await flush();
    rerender({ visible: false });
    dirChanged('/w/a');
    await act(async () => vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10));
    expect(h.status).toHaveBeenCalledTimes(1);
    rerender({ visible: true });
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
  });
});
