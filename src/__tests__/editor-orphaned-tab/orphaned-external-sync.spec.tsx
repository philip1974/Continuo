// @vitest-environment jsdom
// BDD: 外部删除 / 恢复有未保存修改的文件 → tab 的「已删除」标记随之置位 / 清除(内容不动)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useEditorStore } from '../../stores/editor.store';

const fsMock = vi.hoisted(() => ({
  onDirChanged: vi.fn(),
  onRootPresenceChanged: vi.fn(() => () => {}),
  readFile: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({ coApi: { fs: fsMock } }));
vi.mock('@/lib/fs-watch-restored', () => ({ onWatchRestored: () => () => {} }));

import { EXTERNAL_DELETE_CONFIRM_MS, useExternalFileSync } from '../../panels/Editor/useExternalFileSync';

const PATH = '/dir/f.md';
const NOT_FOUND = { ok: false, code: 'FS_NOT_FOUND', message: 'ENOENT' };
const STAT_OK = { ok: true, data: { mtimeMs: 1.5, size: 3, ino: 1 } };
let emit: (dir: string, files?: string[]) => void = () => {};

const live = () => useEditorStore.getState().tabs[0];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  fsMock.onDirChanged.mockImplementation((fn: typeof emit) => {
    emit = fn;
    return () => {};
  });
  useEditorStore.setState({
    tabs: [{ id: PATH, filePath: PATH, content: 'mine', originalContent: 'orig', dirty: true }],
    activeTabId: PATH,
  });
});
afterEach(() => {
  vi.useRealTimers();
});

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('外部删除有未保存修改的文件', () => {
  it('确认不存在(延迟复查仍不存在)→ tab 保留、内容不动、标记已删除;不读内容', async () => {
    fsMock.stat.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    emit('/dir', ['f.md']);
    await flush();
    expect(live()?.orphaned).toBeFalsy(); // 先删后建的间隙不算删除
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    expect(live()).toMatchObject({ orphaned: true, content: 'mine', dirty: true });
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });

  it('删除后很快又出现(先删后建式替换)→ 不标记', async () => {
    fsMock.stat.mockResolvedValueOnce(NOT_FOUND).mockResolvedValue(STAT_OK);
    renderHook(() => useExternalFileSync());
    emit('/dir', ['f.md']);
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    expect(live()?.orphaned).toBeFalsy();
  });

  it('文件重新出现 → 清除已删除标记', async () => {
    useEditorStore.getState().setOrphaned(PATH, true);
    fsMock.stat.mockResolvedValue(STAT_OK);
    renderHook(() => useExternalFileSync());
    emit('/dir', ['f.md']);
    await flush();
    expect(live()?.orphaned).toBeFalsy();
    expect(live()).toMatchObject({ content: 'mine', dirty: true });
  });

  it('同目录其它文件变化(文件名集合不含本文件)→ 不检查', async () => {
    renderHook(() => useExternalFileSync());
    emit('/dir', ['other.md']);
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    expect(fsMock.stat).not.toHaveBeenCalled();
  });
});
