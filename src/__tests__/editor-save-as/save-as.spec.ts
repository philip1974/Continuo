// 另存为流程(行为见同目录 README)。被测:panels/Editor/save-as.ts、stores/editor.store.ts retargetTab、navigation-history。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTab, useEditorStore, type EditorTab } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { saveAsDefaultPath, saveTabAs, type SaveAsDeps } from '../../panels/Editor/save-as';
import { suggestedUntitledFileName } from '../../panels/Editor/untitled';
import { PRIMARY_EDITOR_GROUP_ID } from '../../../electron/shared/editor-group-id';
import {
  installNavigationHistory,
  navigationStack,
  resetNavigationHistory,
} from '../../panels/Editor/navigation-history';

const A = '/work/a.ts';
const B = '/work/b.ts';

function tab(path: string, content: string, originalContent = content): EditorTab {
  return { ...createTab(path, originalContent), content, dirty: content !== originalContent };
}

function deps(picked: string | null, write: SaveAsDeps['writeFile'] = async () => ({ ok: true, data: undefined })) {
  return {
    showSaveDialog: vi.fn(async (_p: string) => ({ ok: true as const, data: picked })),
    writeFile: vi.fn(write),
  };
}

const ids = () => useEditorStore.getState().tabs.map((t) => t.id);
const get = (id: string) => useEditorStore.getState().tabs.find((t) => t.id === id);

beforeEach(() => {
  useEditorStore.setState({
    tabs: [tab(A, 'mine', 'orig'), tab('/work/c.ts', 'c')],
    activeTabId: A,
    groups: [{ id: PRIMARY_EDITOR_GROUP_ID, tabIds: [], activeTabId: null }],
    activeGroupId: PRIMARY_EDITOR_GROUP_ID,
    tabMru: new Map(),
    previewTabs: new Map(),
    mode: 'source',
  });
  useWorkspaceStore.setState({ root: '/work' });
});

describe('另存为已有文件', () => {
  it('默认位置 = 文件自己的路径;写入当前内容到选定路径;原 tab 换到新路径(同位置、仍活动、变干净),原文件不写', async () => {
    const d = deps(B);
    const r = await saveTabAs(A, d);
    expect(r).toEqual({ ok: true, data: B });
    expect(d.showSaveDialog).toHaveBeenCalledWith(A);
    expect(d.writeFile).toHaveBeenCalledTimes(1);
    expect(d.writeFile).toHaveBeenCalledWith(B, 'mine');
    expect(ids()).toEqual([B, '/work/c.ts']);
    expect(useEditorStore.getState().activeTabId).toBe(B);
    expect(get(B)).toMatchObject({ filePath: B, content: 'mine', originalContent: 'mine', dirty: false });
  });

  it('取消 → 不写盘,tab 不变', async () => {
    const d = deps(null);
    expect(await saveTabAs(A, d)).toEqual({ ok: true, data: null });
    expect(d.writeFile).not.toHaveBeenCalled();
    expect(ids()).toEqual([A, '/work/c.ts']);
    expect(get(A)?.dirty).toBe(true);
  });

  it('写盘失败 → 原样返回失败,tab 不变(仍脏、仍是原路径)', async () => {
    const d = deps(B, async () => ({ ok: false, code: 'FS_NO_SPACE', message: 'ENOSPC' }));
    const r = await saveTabAs(A, d);
    expect(r).toMatchObject({ ok: false, code: 'FS_NO_SPACE' });
    expect(ids()).toEqual([A, '/work/c.ts']);
    expect(get(A)?.dirty).toBe(true);
  });

  it('对话框 IPC 失败 → 原样返回,不写盘', async () => {
    const d = {
      showSaveDialog: vi.fn(async () => ({ ok: false as const, code: 'NO_WINDOW', message: 'x' })),
      writeFile: vi.fn(),
    };
    expect(await saveTabAs(A, d)).toMatchObject({ ok: false, code: 'NO_WINDOW' });
    expect(d.writeFile).not.toHaveBeenCalled();
  });

  it('选的就是原路径 → 等同保存:tab id 不变,变干净', async () => {
    const d = deps(A);
    await saveTabAs(A, d);
    expect(ids()).toEqual([A, '/work/c.ts']);
    expect(get(A)?.dirty).toBe(false);
  });

  it('目标路径已在另一个 tab 打开 → 只留一个该路径的 tab,内容是另存的内容', async () => {
    useEditorStore.setState({ tabs: [tab(A, 'mine', 'orig'), tab(B, 'b-unsaved', 'b')], activeTabId: A });
    await saveTabAs(A, deps(B));
    expect(ids()).toEqual([B]);
    expect(get(B)).toMatchObject({ content: 'mine', dirty: false });
    expect(useEditorStore.getState().activeTabId).toBe(B);
  });

  it('写盘期间继续输入 → 基线推进到写入内容但仍脏', async () => {
    let finish!: () => void;
    const d = deps(B, () => new Promise((res) => (finish = () => res({ ok: true, data: undefined }))));
    const p = saveTabAs(A, d);
    await vi.waitFor(() => expect(d.writeFile).toHaveBeenCalled());
    useEditorStore.getState().updateContent(A, 'mine+more');
    finish();
    await p;
    expect(get(B)).toMatchObject({ content: 'mine+more', originalContent: 'mine', dirty: true });
  });

  it('对话框开着时再次另存为同一 tab → 不叠第二个对话框', async () => {
    let answer!: (v: { ok: true; data: string | null }) => void;
    const d = {
      showSaveDialog: vi.fn(() => new Promise<{ ok: true; data: string | null }>((res) => (answer = res))),
      writeFile: vi.fn(async () => ({ ok: true as const, data: undefined })),
    };
    const first = saveTabAs(A, d);
    expect(await saveTabAs(A, d)).toEqual({ ok: true, data: null });
    expect(d.showSaveDialog).toHaveBeenCalledTimes(1);
    answer({ ok: true, data: null });
    await first;
  });

  it('多编辑器组:两个组里的这个 tab 都换到新路径,各自位置不变', async () => {
    useEditorStore.setState({
      tabs: [tab(A, 'mine', 'orig'), tab('/work/c.ts', 'c')],
      groups: [
        { id: PRIMARY_EDITOR_GROUP_ID, tabIds: ['/work/c.ts', A], activeTabId: A },
        { id: 'editor:2', tabIds: [A], activeTabId: A },
      ],
      activeGroupId: 'editor:2',
      activeTabId: A,
    });
    await saveTabAs(A, deps(B));
    const s = useEditorStore.getState();
    expect(s.groups.map((g) => g.tabIds)).toEqual([['/work/c.ts', B], [B]]);
    expect(s.groups.map((g) => g.activeTabId)).toEqual([B, B]);
    expect(s.tabs.map((t) => t.id).sort()).toEqual([B, '/work/c.ts'].sort());
  });

  it('另存为 .md:同一内容,按 Markdown 重算派生判定(unsafe 内容在新路径下才算 Markdown)', async () => {
    useEditorStore.setState({ tabs: [tab(A, '---\ntitle: x\n---\n# T', 'orig')], activeTabId: A });
    await saveTabAs(A, deps('/work/notes.md'));
    expect(get('/work/notes.md')).toMatchObject({ content: '---\ntitle: x\n---\n# T', milkdownUnsafe: true, dirty: false });
    expect(useEditorStore.getState().mode).toBe('source');
  });
});

describe('另存为沿用 tab 的编码(BDD: editor-text-encoding)', () => {
  it.each(['utf16le', 'gbk', 'utf8bom'] as const)('%s tab:按该编码写入(BOM 由编码决定),新路径的 tab 保留编码与「用户选定」标记', async (encoding) => {
    useEditorStore.setState({
      tabs: [{ ...tab(A, '中文\r\nline\r\n', 'orig'), encoding, encodingPinned: true }],
      activeTabId: A,
    });
    const d = deps(B);
    await saveTabAs(A, d);
    expect(d.writeFile).toHaveBeenCalledWith(B, '中文\r\nline\r\n', { encoding });
    expect(get(B)).toMatchObject({ encoding, encodingPinned: true, dirty: false });
  });

  it('UTF-8 tab:不带 encoding(写入载荷同普通保存)', async () => {
    const d = deps(B);
    await saveTabAs(A, d);
    expect(d.writeFile.mock.calls[0]).toEqual([B, 'mine']);
  });

  it('编码表示不了内容(FS_UNENCODABLE)→ 不换 tab,编码不变', async () => {
    useEditorStore.setState({ tabs: [{ ...tab(A, '😀', 'orig'), encoding: 'gbk' }], activeTabId: A });
    const d = deps(B, async () => ({ ok: false, code: 'FS_UNENCODABLE', message: 'x' }));
    expect(await saveTabAs(A, d)).toMatchObject({ ok: false, code: 'FS_UNENCODABLE' });
    expect(get(A)).toMatchObject({ encoding: 'gbk', dirty: true });
  });
});

describe('另存为后导航历史', () => {
  it('指向原 tab 的条目改指新路径,不多出一条', async () => {
    resetNavigationHistory();
    const off = installNavigationHistory();
    try {
      useEditorStore.setState({ tabs: [], activeTabId: null });
      useEditorStore.getState().openTab(createTab('/work/c.ts', 'c'));
      useEditorStore.getState().openTab({ ...createTab(A, 'orig'), content: 'mine', dirty: true });
      expect(navigationStack().entries.map((e) => e.path)).toEqual(['/work/c.ts', A]);
      await saveTabAs(A, deps(B));
      expect(navigationStack().entries.map((e) => e.path)).toEqual(['/work/c.ts', B]);
    } finally {
      off();
      resetNavigationHistory();
    }
  });
});

describe('无标题文件的默认位置与建议名', () => {
  it('工作区根下按首行推断的名字;无工作区 → 只给文件名(主进程放到主目录)', () => {
    expect(saveAsDefaultPath('untitled:Untitled-1', 'hello world\nsecond', '/work')).toBe('/work/hello world.txt');
    expect(saveAsDefaultPath('untitled:Untitled-1', 'hello', null)).toBe('hello.txt');
    expect(saveAsDefaultPath(A, 'whatever', '/work')).toBe(A);
  });

  it.each([
    ['  多个   空白  合并 ', '多个 空白 合并.txt'],
    ['a'.repeat(60), `${'a'.repeat(40)}.txt`],
    ['notes.md', 'notes.md'],
    ['a/b:c*?', 'abc.txt'],
    ['', 'Untitled-3.txt'],
    ['   \n第二行', 'Untitled-3.txt'],
    ['!!!', 'Untitled-3.txt'],
    ['‮evil', 'evil.txt'],
  ])('首行 %j → %j', (first, expected) => {
    expect(suggestedUntitledFileName('untitled:Untitled-3', first)).toBe(expected);
  });
});
