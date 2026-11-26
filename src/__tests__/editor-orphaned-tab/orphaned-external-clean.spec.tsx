// @vitest-environment jsdom
// BDD: 外部删除(git checkout 切到删除该文件的分支 / 外部 rm / mv)不关闭干净 tab —— 对齐 VSCode
// workbench.editor.closeOnFileDelete: false:tab 保留、内容不动、标「(已删除)」;文件重新出现 → 清标记并按磁盘重载。
// 资源管理器里用户主动删除(removePaths)仍关闭干净 tab(见 orphaned-store.spec.ts)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { onEditorPathChange, useEditorStore, type EditorPathChange } from '../../stores/editor.store';
import { saveFile } from '../../panels/Editor/editor-file-actions';
import { _resetSavedDiskStatsForTest, recordSavedDiskStat } from '../../panels/Editor/saved-disk-stat';

const fsMock = vi.hoisted(() => ({
  onDirChanged: vi.fn(),
  onRootPresenceChanged: vi.fn((_fn: (dir: string) => void) => () => {}),
  readFile: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('@/lib/co-api', () => ({ coApi: { fs: fsMock } }));
vi.mock('@/lib/fs-watch-restored', () => ({ onWatchRestored: () => () => {} }));

import { EXTERNAL_DELETE_CONFIRM_MS, useExternalFileSync } from '../../panels/Editor/useExternalFileSync';

const A = '/w/a.md';
const B = '/w/b.md';
const NOT_FOUND = { ok: false as const, code: 'FS_NOT_FOUND', message: 'ENOENT' };
let emit: (dir: string, files?: string[]) => void = () => {};
const find = (id: string) => useEditorStore.getState().tabs.find((t) => t.id === id);
const clean = (p: string, content = 'disk') => ({ id: p, filePath: p, content, originalContent: content, dirty: false });

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  fsMock.onDirChanged.mockImplementation((fn: typeof emit) => {
    emit = fn;
    return () => {};
  });
  useEditorStore.setState({ tabs: [clean(A), clean(B)], activeTabId: A, chromeVersion: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('外部删除干净 tab:保留并标记已删除', () => {
  it('确认不存在 → tab 保留(仍是活动 tab)、内容不动、orphaned;确认前不标记', async () => {
    fsMock.readFile.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    emit('/w', ['a.md']);
    await flush();
    expect(find(A)?.orphaned).toBeFalsy(); // 先删后建的间隙不算删除
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    expect(find(A)).toMatchObject({ orphaned: true, content: 'disk', dirty: false });
    expect(useEditorStore.getState().activeTabId).toBe(A);
    expect(find(B)?.orphaned).toBeFalsy();
  });

  it('确认删除 → 发出一次「已删除」路径通知(搜索结果 / 最近打开据此移除);已标记后再次确认不重复通知', async () => {
    const seen: EditorPathChange[] = [];
    const off = onEditorPathChange((c) => seen.push(c));
    fsMock.readFile.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    emit('/w', ['a.md']);
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    emit('/w', ['a.md']);
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    off();
    expect(seen).toEqual([{ kind: 'removed', paths: [A] }]);
  });

  it('文件重新出现(内容相同,如切回原分支)→ 清除标记,不重挂载视图', async () => {
    fsMock.readFile.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    emit('/w', ['a.md']);
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    expect(find(A)?.orphaned).toBe(true);
    fsMock.readFile.mockResolvedValue({ ok: true, data: 'disk' });
    emit('/w', ['a.md']);
    await flush();
    expect(find(A)?.orphaned).toBeFalsy();
    expect(find(A)?.reloadEpoch).toBeUndefined();
  });

  it('文件重新出现(内容不同)→ 清除标记并按磁盘重载', async () => {
    fsMock.readFile.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    emit('/w', ['a.md']);
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    fsMock.readFile.mockResolvedValue({ ok: true, data: 'other branch' });
    emit('/w', ['a.md']);
    await flush();
    expect(find(A)).toMatchObject({ content: 'other branch', originalContent: 'other branch', dirty: false });
    expect(find(A)?.orphaned).toBeFalsy();
  });

  it('所在目录被外部改名(只报目录名)→ 目录内干净 tab 保留并标记', async () => {
    useEditorStore.setState({ tabs: [clean('/w/foo/deep/c.ts'), clean(B)], activeTabId: B });
    fsMock.readFile.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    emit('/w', ['foo', 'bar']);
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    expect(find('/w/foo/deep/c.ts')?.orphaned).toBe(true);
    expect(find(B)?.orphaned).toBeFalsy();
  });
});

describe('应用内保存过的文件被移走再移回(mv 不改 mtime / size / ino,与保存记录一致)', () => {
  const SAVED_STAT = { mtimeMs: 1, size: 4, ino: 7 };
  // 模拟应用内 ⌘S:记录写盘 stat,tab.savedGen 指向该记录(之后磁盘 stat 一致即「自己保存的回声」)
  const markSavedHere = (p: string) => {
    const gen = recordSavedDiskStat(p, SAVED_STAT);
    useEditorStore.getState().markSaved(p, 'disk', gen);
  };
  beforeEach(() => _resetSavedDiskStatsForTest());

  it('dir-changed:移走 → 标记;移回 → 清除标记(不因回声判断跳过读盘)', async () => {
    markSavedHere(A);
    fsMock.stat.mockResolvedValue(NOT_FOUND);
    fsMock.readFile.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    emit('/w', ['a.md']);
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    expect(find(A)?.orphaned).toBe(true);
    fsMock.stat.mockResolvedValue({ ok: true, data: SAVED_STAT });
    fsMock.readFile.mockResolvedValue({ ok: true, data: 'disk' });
    emit('/w', ['a.md']);
    await flush();
    expect(find(A)?.orphaned).toBeFalsy();
    expect(find(A)?.reloadEpoch).toBeUndefined(); // 内容相同,不重挂载视图
  });

  it('工作区根改名再改回(根恢复事件)→ 保存过的干净 tab 同样清除标记', async () => {
    let rootPresence: (dir: string) => void = () => {};
    fsMock.onRootPresenceChanged.mockImplementation((fn: (dir: string) => void) => {
      rootPresence = fn;
      return () => {};
    });
    markSavedHere(A);
    fsMock.stat.mockResolvedValue(NOT_FOUND);
    fsMock.readFile.mockResolvedValue(NOT_FOUND);
    renderHook(() => useExternalFileSync());
    rootPresence('/w');
    await flush(EXTERNAL_DELETE_CONFIRM_MS);
    expect(find(A)?.orphaned).toBe(true);
    expect(find(B)?.orphaned).toBe(true);
    fsMock.stat.mockResolvedValue({ ok: true, data: SAVED_STAT });
    fsMock.readFile.mockResolvedValue({ ok: true, data: 'disk' });
    rootPresence('/w');
    await flush();
    expect(find(A)?.orphaned).toBeFalsy();
    expect(find(B)?.orphaned).toBeFalsy();
  });

  it('未标记删除时仍识别自己保存的回声:stat 与记录一致 → 不整文件读', async () => {
    markSavedHere(A);
    fsMock.stat.mockResolvedValue({ ok: true, data: SAVED_STAT });
    renderHook(() => useExternalFileSync());
    emit('/w', ['a.md']);
    await flush();
    expect(fsMock.stat).toHaveBeenCalledWith(A);
    expect(fsMock.readFile).not.toHaveBeenCalled();
  });
});

describe('已删除的干净 tab 保存', () => {
  it('⌘S → 按路径重建文件(VSCode 同),成功后清除标记', async () => {
    useEditorStore.getState().markPathsDeleted([A]);
    expect(find(A)?.orphaned).toBe(true);
    const writeFile = vi.fn(async () => ({ ok: true as const, data: undefined }));
    const readFile = vi.fn(async () => NOT_FOUND);
    const r = await saveFile(A, { fs: { readFile, writeFile } });
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(A, 'disk');
    expect(find(A)?.orphaned).toBeFalsy();
  });
});
