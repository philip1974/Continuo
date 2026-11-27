// @vitest-environment jsdom
// BDD: 已标「(已删除)」的 tab 低频复查存在性(ORPHANED_RECHECK_MS 一次 + 窗口获得焦点时),不依赖文件事件 ——
// 卷卸载后挂回、网络盘重连时 watcher 不一定再报这个文件(VSCode:文件重新出现即清除 orphaned)。
// 文件回来 → 干净 tab 按磁盘重载并清除标记;脏 tab 清除标记(内容不动,恢复自动保存);仍不存在 → 不动。没有已删除 tab → 不发 IPC。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useEditorStore } from '../../stores/editor.store';

const fsMock = vi.hoisted(() => ({
  onDirChanged: vi.fn(() => () => {}),
  onRootPresenceChanged: vi.fn(() => () => {}),
  readFile: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({ coApi: { fs: fsMock } }));
vi.mock('@/lib/fs-watch-restored', () => ({ onWatchRestored: () => () => {} }));

import { ORPHANED_RECHECK_MS, useExternalFileSync } from '../../panels/Editor/useExternalFileSync';

const NOT_FOUND = { ok: false, code: 'FS_NOT_FOUND', message: 'ENOENT' };
const STAT_OK = { ok: true, data: { mtimeMs: 1.5, size: 4, ino: 1 } };
const find = (id: string) => useEditorStore.getState().tabs.find((t) => t.id === id);

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  useEditorStore.setState({
    tabs: [
      { id: '/v/README.md', filePath: '/v/README.md', content: 'disk', originalContent: 'disk', dirty: false, orphaned: true },
      { id: '/v/b.md', filePath: '/v/b.md', content: 'mine', originalContent: 'disk', dirty: true, orphaned: true },
      { id: '/w/c.md', filePath: '/w/c.md', content: 'c', originalContent: 'c', dirty: false },
    ],
    activeTabId: '/v/README.md',
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('已删除 tab 低频复查', () => {
  it('仍不存在 → 标记保持,不读内容;未标记的 tab 不查', async () => {
    fsMock.stat.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    await flush(ORPHANED_RECHECK_MS);
    expect(fsMock.stat.mock.calls.map((c) => c[0]).sort()).toEqual(['/v/README.md', '/v/b.md']);
    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(find('/v/README.md')?.orphaned).toBe(true);
    expect(find('/v/b.md')?.orphaned).toBe(true);
  });

  it('文件回来(卷挂回)→ 干净 tab 重载并清除;脏 tab 清除、内容不动', async () => {
    fsMock.stat.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    await flush(ORPHANED_RECHECK_MS);
    fsMock.stat.mockResolvedValue(STAT_OK);
    fsMock.readFile.mockResolvedValue({ ok: true, data: 'disk2' });
    await flush(ORPHANED_RECHECK_MS);
    expect(find('/v/README.md')).toMatchObject({ content: 'disk2', dirty: false });
    expect(find('/v/README.md')?.orphaned).toBeFalsy();
    expect(find('/v/b.md')).toMatchObject({ content: 'mine', dirty: true });
    expect(find('/v/b.md')?.orphaned).toBeFalsy();
  });

  it('窗口获得焦点 → 立即复查,不等周期', async () => {
    fsMock.stat.mockResolvedValue(STAT_OK);
    fsMock.readFile.mockResolvedValue({ ok: true, data: 'disk' });
    renderHook(() => useExternalFileSync());
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(find('/v/README.md')?.orphaned).toBeFalsy();
    expect(find('/v/b.md')?.orphaned).toBeFalsy();
  });

  it('没有已删除 tab → 周期到了也不发任何 IPC', async () => {
    useEditorStore.setState({
      tabs: [{ id: '/w/c.md', filePath: '/w/c.md', content: 'c', originalContent: 'c', dirty: false }],
    });
    renderHook(() => useExternalFileSync());
    await flush(ORPHANED_RECHECK_MS * 3);
    expect(fsMock.stat).not.toHaveBeenCalled();
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it('卸载后不再复查', async () => {
    fsMock.stat.mockResolvedValue(NOT_FOUND);
    const { unmount } = renderHook(() => useExternalFileSync());
    unmount();
    await flush(ORPHANED_RECHECK_MS * 2);
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(fsMock.stat).not.toHaveBeenCalled();
  });
});
