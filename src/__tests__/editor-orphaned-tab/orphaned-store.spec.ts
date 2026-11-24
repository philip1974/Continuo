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
