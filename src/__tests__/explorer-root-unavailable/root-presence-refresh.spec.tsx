// @vitest-environment jsdom
// BDD: 工作区根消失 / 恢复时资源管理器刷新:根读不到 → 只刷新根(显示根读取失败,不显示过期列表);读得到 → 整树刷新;
// 根读取失败期间低频复查(+ 窗口获得焦点),根回来即整树刷新。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

const fsMock = vi.hoisted(() => ({
  onRootPresenceChanged: vi.fn(),
  listDir: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({ coApi: { fs: fsMock } }));

import {
  ROOT_UNAVAILABLE_RECHECK_MS,
  useRootPresenceRefresh,
} from '../../panels/Explorer/hooks/useRootPresenceRefresh';

let presence: (path: string) => void = () => {};
const OK = { ok: true, data: [] };
const GONE = { ok: false, code: 'FS_NOT_FOUND', message: 'ENOENT' };

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  fsMock.onRootPresenceChanged.mockImplementation((fn: typeof presence) => {
    presence = fn;
    return () => {};
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function setup(rootFailed: boolean) {
  const refreshRoot = vi.fn();
  const refreshAll = vi.fn();
  const r = renderHook(({ failed }) => useRootPresenceRefresh('/Volumes/X', failed, refreshRoot, refreshAll), {
    initialProps: { failed: rootFailed },
  });
  return { refreshRoot, refreshAll, ...r };
}

describe('根存在性变化', () => {
  it('根消失(读不到)→ 只刷新根,不逐个刷新已展开目录', async () => {
    fsMock.listDir.mockResolvedValue(GONE);
    const { refreshRoot, refreshAll } = setup(false);
    presence('/Volumes/X');
    await flush();
    expect(refreshRoot).toHaveBeenCalledTimes(1);
    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('根恢复(读得到)→ 整树刷新', async () => {
    fsMock.listDir.mockResolvedValue(OK);
    const { refreshRoot, refreshAll } = setup(false);
    presence('/Volumes/X');
    await flush();
    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(refreshRoot).not.toHaveBeenCalled();
  });

  it('别的根的事件 → 不处理', async () => {
    fsMock.listDir.mockResolvedValue(OK);
    const { refreshRoot, refreshAll } = setup(false);
    presence('/Volumes/Other');
    await flush();
    expect(fsMock.listDir).not.toHaveBeenCalled();
    expect(refreshRoot).not.toHaveBeenCalled();
    expect(refreshAll).not.toHaveBeenCalled();
  });

  it('探测 reject → 按读不到处理', async () => {
    fsMock.listDir.mockRejectedValue(new Error('bridge'));
    const { refreshRoot } = setup(false);
    presence('/Volumes/X');
    await flush();
    expect(refreshRoot).toHaveBeenCalledTimes(1);
  });
});

describe('根读取失败期间低频复查', () => {
  it('仍读不到 → 不刷新;回来了 → 整树刷新', async () => {
    fsMock.listDir.mockResolvedValue(GONE);
    const { refreshAll } = setup(true);
    await flush(ROOT_UNAVAILABLE_RECHECK_MS);
    expect(fsMock.listDir).toHaveBeenCalledTimes(1);
    expect(refreshAll).not.toHaveBeenCalled();
    fsMock.listDir.mockResolvedValue(OK);
    await flush(ROOT_UNAVAILABLE_RECHECK_MS);
    expect(refreshAll).toHaveBeenCalledTimes(1);
  });

  it('窗口获得焦点 → 立即复查', async () => {
    fsMock.listDir.mockResolvedValue(OK);
    const { refreshAll } = setup(true);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(refreshAll).toHaveBeenCalledTimes(1);
  });

  it('根正常 → 不轮询;恢复正常后停止轮询', async () => {
    fsMock.listDir.mockResolvedValue(GONE);
    const { rerender } = setup(false);
    await flush(ROOT_UNAVAILABLE_RECHECK_MS * 3);
    expect(fsMock.listDir).not.toHaveBeenCalled();
    rerender({ failed: true });
    await flush(ROOT_UNAVAILABLE_RECHECK_MS);
    expect(fsMock.listDir).toHaveBeenCalledTimes(1);
    rerender({ failed: false });
    await flush(ROOT_UNAVAILABLE_RECHECK_MS * 3);
    expect(fsMock.listDir).toHaveBeenCalledTimes(1);
  });
});
