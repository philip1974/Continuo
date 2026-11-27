// @vitest-environment jsdom
// BDD: editor-search-git-decorations / 共享数据源:同根多使用方只查一次、任一可见即刷新、全隐藏记脏、最后一个离开即停
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import type { GitStatusSnapshot } from '../../../electron/shared/git-status';

const h = vi.hoisted(() => ({
  status: vi.fn(),
  dirListeners: new Set<(path: string) => void>(),
}));
vi.mock('@/lib/co-api', () => ({
  coApi: {
    git: { status: h.status },
    fs: {
      onDirChanged: (cb: (path: string) => void) => {
        h.dirListeners.add(cb);
        return () => h.dirListeners.delete(cb);
      },
    },
  },
}));

import { GIT_REFRESH_DEBOUNCE_MS, useGitStatus } from '../../panels/Explorer/hooks/useGitStatus';
import { gitDecorationOf } from '../../panels/Explorer/git-decorations';

const snap = (entries: GitStatusSnapshot['entries']) => ({ ok: true as const, data: { root: '/w', entries } });
const dirChanged = (p: string) => {
  for (const cb of h.dirListeners) cb(p);
};
const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
const settle = () => act(async () => vi.advanceTimersByTime(GIT_REFRESH_DEBOUNCE_MS + 10));

beforeEach(() => {
  vi.useFakeTimers();
  h.status.mockReset();
  h.status.mockResolvedValue(snap([['a.ts', 'modified', 'M']]));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.dirListeners.clear();
});

describe('同一根多个使用方', () => {
  it('只查询一次,结果同时到达;刷新也只查一次', async () => {
    const explorer = renderHook(() => useGitStatus('/w', true, true));
    const tabs = renderHook(() => useGitStatus('/w', true, true));
    const search = renderHook(() => useGitStatus('/w', true, true));
    await flush();
    expect(h.status).toHaveBeenCalledTimes(1);
    for (const r of [explorer, tabs, search]) {
      expect(gitDecorationOf(r.result.current!, 'a.ts', false)).toEqual({ kind: 'modified', letter: 'M' });
    }
    h.status.mockResolvedValue(snap([['a.ts', 'untracked', 'U']]));
    dirChanged('/w/a.ts');
    await settle();
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(dirListenerCount()).toBe(1);
    for (const r of [explorer, tabs, search]) {
      expect(gitDecorationOf(r.result.current!, 'a.ts', false)?.kind).toBe('untracked');
    }
  });

  it('后登记的使用方直接拿到已有快照,不再查询', async () => {
    renderHook(() => useGitStatus('/w', true, true));
    await flush();
    const late = renderHook(() => useGitStatus('/w', true, true));
    expect(late.result.current).not.toBeNull();
    await flush();
    expect(h.status).toHaveBeenCalledTimes(1);
  });
});

function dirListenerCount(): number {
  return h.dirListeners.size;
}

describe('可见性节流', () => {
  it('资源管理器隐藏、tab 栏可见 → 文件变化照常刷新', async () => {
    renderHook(() => useGitStatus('/w', true, false)); // 侧栏隐藏
    const tabs = renderHook(() => useGitStatus('/w', true, true));
    await flush();
    h.status.mockResolvedValue(snap([['b.ts', 'untracked', 'U']]));
    dirChanged('/w/b.ts');
    await settle();
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(gitDecorationOf(tabs.result.current!, 'b.ts', false)?.kind).toBe('untracked');
  });

  it('全部不可见 → 只记脏;任一方再次可见时补一次', async () => {
    const explorer = renderHook(({ visible }) => useGitStatus('/w', true, visible), { initialProps: { visible: true } });
    await flush();
    explorer.rerender({ visible: false });
    dirChanged('/w/a.ts');
    await settle();
    expect(h.status).toHaveBeenCalledTimes(1);
    explorer.rerender({ visible: true });
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
  });

  it('全部不可见期间无变化 → 再次可见不多查', async () => {
    const explorer = renderHook(({ visible }) => useGitStatus('/w', true, visible), { initialProps: { visible: true } });
    await flush();
    explorer.rerender({ visible: false });
    explorer.rerender({ visible: true });
    await flush();
    expect(h.status).toHaveBeenCalledTimes(1);
  });
});

describe('登记与退出', () => {
  it('某使用方关掉装饰只是它退出:它返回 null,其他照旧', async () => {
    const explorer = renderHook(({ enabled }) => useGitStatus('/w', enabled, true), { initialProps: { enabled: true } });
    const tabs = renderHook(() => useGitStatus('/w', true, true));
    await flush();
    explorer.rerender({ enabled: false });
    expect(explorer.result.current).toBeNull();
    expect(tabs.result.current).not.toBeNull();
    dirChanged('/w/a.ts');
    await settle();
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
  });

  it('最后一个使用方离开 → 停止监听、丢弃快照;再登记重新查询', async () => {
    const a = renderHook(() => useGitStatus('/w', true, true));
    const b = renderHook(() => useGitStatus('/w', true, true));
    await flush();
    a.unmount();
    expect(dirListenerCount()).toBe(1);
    b.unmount();
    expect(dirListenerCount()).toBe(0);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(h.status).toHaveBeenCalledTimes(1);
    const c = renderHook(() => useGitStatus('/w', true, true));
    expect(c.result.current).toBeNull();
    await flush();
    expect(h.status).toHaveBeenCalledTimes(2);
    expect(c.result.current).not.toBeNull();
  });
});
