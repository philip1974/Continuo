// @vitest-environment jsdom
// BDD: 工作区根目录被外部改名 / 删除 → 根下所有打开的编辑器(干净 / 脏)保留并标「(已删除)」(VSCode 同);
// 根恢复(改回原名 / 重建)→ 标记清除(干净 tab 按磁盘重载,脏 tab 内容不动)。
// main 在根自身消失 / 重新出现时推 fs:root-presence-changed({ path },不带文件名),渲染端据此复查根下全部 tab。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEditorStore } from '../../stores/editor.store';

const fsMock = vi.hoisted(() => ({
  onDirChanged: vi.fn(() => () => {}),
  onRootPresenceChanged: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({ coApi: { fs: fsMock } }));
vi.mock('@/lib/fs-watch-restored', () => ({ onWatchRestored: () => () => {} }));

import { EXTERNAL_DELETE_CONFIRM_MS, useExternalFileSync } from '../../panels/Editor/useExternalFileSync';

const NOT_FOUND = { ok: false, code: 'FS_NOT_FOUND', message: 'ENOENT' };
const STAT_OK = { ok: true, data: { mtimeMs: 1.5, size: 3, ino: 1 } };
let rootEvent: (path: string) => void = () => {};
const find = (id: string) => useEditorStore.getState().tabs.find((t) => t.id === id);
const tab = (p: string, dirty: boolean) => ({
  id: p,
  filePath: p,
  content: dirty ? 'mine' : 'disk',
  originalContent: 'disk',
  dirty,
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  fsMock.onRootPresenceChanged.mockImplementation((fn: typeof rootEvent) => {
    rootEvent = fn;
    return () => {};
  });
  useEditorStore.setState({
    tabs: [tab('/w/a.md', false), tab('/w/sub/b.ts', true), tab('/other/c.md', false)],
    activeTabId: '/w/a.md',
  });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('工作区根消失 / 恢复', () => {
  it('根消失 → 根下干净 / 脏 tab 都保留并标记已删除;根外 tab 不读不动', async () => {
    fsMock.readFile.mockResolvedValue(NOT_FOUND);
    fsMock.stat.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    rootEvent('/w');
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    expect(find('/w/a.md')).toMatchObject({ orphaned: true, dirty: false });
    expect(find('/w/sub/b.ts')).toMatchObject({ orphaned: true, dirty: true, content: 'mine' });
    expect(find('/other/c.md')?.orphaned).toBeFalsy();
    expect(useEditorStore.getState().tabs).toHaveLength(3);
    expect(fsMock.readFile.mock.calls.map((c) => c[0])).not.toContain('/other/c.md');
  });

  it('根恢复 → 标记清除(干净按磁盘重载,脏 tab 内容不动)', async () => {
    fsMock.readFile.mockResolvedValue(NOT_FOUND);
    fsMock.stat.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    rootEvent('/w');
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    fsMock.readFile.mockResolvedValue({ ok: true, data: 'disk' });
    fsMock.stat.mockResolvedValue(STAT_OK);
    rootEvent('/w');
    await flush();
    expect(find('/w/a.md')?.orphaned).toBeFalsy();
    expect(find('/w/sub/b.ts')?.orphaned).toBeFalsy();
    expect(find('/w/sub/b.ts')).toMatchObject({ content: 'mine', dirty: true });
  });
});
