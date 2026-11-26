// BDD: 文件被删除而编辑器里有未保存修改 → tab 保留并标记「已删除」(orphaned)。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useEditorStore, type EditorTab } from '../../stores/editor.store';
import { saveFile } from '../../panels/Editor/editor-file-actions';
import { collectEditorSnapshot } from '../../lib/persist/explorer-persist';

const tab = (filePath: string, dirty: boolean, extra: Partial<EditorTab> = {}): EditorTab => ({
  id: filePath,
  filePath,
  content: dirty ? 'mine' : 'orig',
  originalContent: 'orig',
  dirty,
  ...extra,
});

const find = (id: string) => useEditorStore.getState().tabs.find((t) => t.id === id);

beforeEach(() => {
  useEditorStore.setState({
    tabs: [tab('/w/a.md', true), tab('/w/b.md', false), tab('/w/dir/c.ts', true), tab('/w/other.md', true)],
    activeTabId: '/w/a.md',
    chromeVersion: 0,
  });
});

describe('删除路径:未保存 tab 保留并标记已删除', () => {
  it('删除文件 → 脏 tab 保留、orphaned;干净 tab 关闭;无关 tab 不受影响', () => {
    useEditorStore.getState().removePaths(['/w/a.md', '/w/b.md']);
    expect(find('/w/a.md')).toMatchObject({ orphaned: true, content: 'mine', dirty: true });
    expect(find('/w/b.md')).toBeUndefined();
    expect(find('/w/other.md')?.orphaned).toBeFalsy();
  });

  it('删除目录 → 其下脏 tab 标记 orphaned', () => {
    useEditorStore.getState().removePaths(['/w/dir']);
    expect(find('/w/dir/c.ts')?.orphaned).toBe(true);
  });

  it('标记变化 bump chromeVersion(tab 栏据此重渲)', () => {
    useEditorStore.getState().removePaths(['/w/a.md']);
    expect(useEditorStore.getState().chromeVersion).toBeGreaterThan(0);
  });

  it('只在运行时:会话快照不含 orphaned', () => {
    useEditorStore.getState().removePaths(['/w/a.md']);
    const { tabs, activeTabId } = useEditorStore.getState();
    expect(JSON.stringify(collectEditorSnapshot(tabs, activeTabId))).not.toContain('orphaned');
  });
});

describe('清除已删除标记', () => {
  beforeEach(() => {
    useEditorStore.getState().removePaths(['/w/a.md']);
    expect(find('/w/a.md')?.orphaned).toBe(true);
  });

  it('重命名 / 移动到新路径 → 清除', () => {
    useEditorStore.getState().renamePath('/w/a.md', '/w/z.md');
    expect(find('/w/z.md')?.orphaned).toBeFalsy();
  });

  it('保存成功(手动 ⌘S 按路径重建文件,同 VSCode)→ 清除', async () => {
    const writeFile = vi.fn(async () => ({ ok: true as const, data: undefined }));
    const readFile = vi.fn(async () => ({ ok: false as const, code: 'FS_NOT_FOUND', message: 'ENOENT' }));
    const r = await saveFile('/w/a.md', { fs: { readFile, writeFile } });
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/w/a.md', 'mine');
    expect(find('/w/a.md')).toMatchObject({ dirty: false });
    expect(find('/w/a.md')?.orphaned).toBeFalsy();
  });

  it('文件重新出现(setOrphaned false)→ 清除', () => {
    useEditorStore.getState().setOrphaned('/w/a.md', false);
    expect(find('/w/a.md')?.orphaned).toBeFalsy();
  });

  it('还原为磁盘内容(reloadFromDisk discardChanges)→ 清除', () => {
    useEditorStore.getState().reloadFromDisk('/w/a.md', 'disk', undefined, { discardChanges: true });
    expect(find('/w/a.md')).toMatchObject({ content: 'disk', dirty: false });
    expect(find('/w/a.md')?.orphaned).toBeFalsy();
  });
});

describe('markPathsDeleted(外部删除确认 / 工作区根消失)', () => {
  it('干净与脏 tab 都保留并标记(目录含其下全部);不关闭、不换活动 tab;无关 tab 不动', () => {
    useEditorStore.getState().markPathsDeleted(['/w/b.md', '/w/dir']);
    expect(find('/w/b.md')).toMatchObject({ orphaned: true, dirty: false, content: 'orig' });
    expect(find('/w/dir/c.ts')).toMatchObject({ orphaned: true, dirty: true });
    expect(find('/w/a.md')?.orphaned).toBeFalsy();
    expect(useEditorStore.getState().tabs).toHaveLength(4);
    expect(useEditorStore.getState().activeTabId).toBe('/w/a.md');
    expect(useEditorStore.getState().chromeVersion).toBeGreaterThan(0);
  });

  it('全部已标记 → 不产生新状态', () => {
    useEditorStore.getState().markPathsDeleted(['/w/b.md']);
    const before = useEditorStore.getState();
    useEditorStore.getState().markPathsDeleted(['/w/b.md']);
    expect(useEditorStore.getState()).toBe(before);
  });
});

describe('setOrphaned', () => {
  it('只标记脏 tab(干净 tab 的删除由关闭处理);值不变不产生新状态', () => {
    const before = useEditorStore.getState();
    useEditorStore.getState().setOrphaned('/w/b.md', true);
    expect(find('/w/b.md')?.orphaned).toBeFalsy();
    useEditorStore.getState().setOrphaned('/w/other.md', false);
    expect(useEditorStore.getState()).toBe(before);
    useEditorStore.getState().setOrphaned('/w/other.md', true);
    expect(find('/w/other.md')?.orphaned).toBe(true);
  });
});

// 外部删除后、orphaned 尚未经外部同步确认(FSEvents 防抖 + stat + 延迟复查)前,自动保存先到点:
// 只供自动保存的 recreateMissing:false —— 读盘确认文件不存在 → 不写回、就地标记 orphaned;手动保存默认照常重建。
describe('保存时发现文件已不存在(recreateMissing:false,自动保存用)', () => {
  const notFound = { ok: false as const, code: 'FS_NOT_FOUND', message: 'ENOENT' };

  it('读盘 FS_NOT_FOUND → 不写盘,返回 FS_NOT_FOUND,tab 标记 orphaned、保持脏', async () => {
    const writeFile = vi.fn(async () => ({ ok: true as const, data: undefined }));
    const readFile = vi.fn(async () => notFound);
    const r = await saveFile('/w/other.md', { fs: { readFile, writeFile } }, { recreateMissing: false });
    expect(r).toMatchObject({ ok: false, code: 'FS_NOT_FOUND' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(find('/w/other.md')).toMatchObject({ orphaned: true, dirty: true, content: 'mine' });
  });

  it('读盘 reject 且带 FS_NOT_FOUND → 同样不写、标记 orphaned', async () => {
    const writeFile = vi.fn(async () => ({ ok: true as const, data: undefined }));
    const readFile = vi.fn(async () => {
      throw Object.assign(new Error('gone'), { code: 'FS_NOT_FOUND' });
    });
    const r = await saveFile('/w/other.md', { fs: { readFile, writeFile } }, { recreateMissing: false });
    expect(r).toMatchObject({ ok: false, code: 'FS_NOT_FOUND' });
    expect(writeFile).not.toHaveBeenCalled();
    expect(find('/w/other.md')?.orphaned).toBe(true);
  });

  it('默认(手动保存)→ 照常按路径重建,不标记', async () => {
    const writeFile = vi.fn(async () => ({ ok: true as const, data: undefined }));
    const readFile = vi.fn(async () => notFound);
    const r = await saveFile('/w/other.md', { fs: { readFile, writeFile } });
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/w/other.md', 'mine');
    expect(find('/w/other.md')?.orphaned).toBeFalsy();
  });
});
