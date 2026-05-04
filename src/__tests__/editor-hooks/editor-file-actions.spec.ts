import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  openFileByPath,
  saveFile,
  type EditorFileDeps,
} from '../../panels/Editor/editor-file-actions';
import {
  createTab,
  useEditorStore,
} from '../../stores/editor.store';
import type { IpcResult } from '../../lib/fs/types';

const ok = <T,>(data: T): IpcResult<T> => ({ ok: true, data });
const fail = (code: string, message = code): IpcResult<never> => ({
  ok: false,
  code,
  message,
});

const makeDeps = (overrides: Partial<EditorFileDeps['fs']> = {}): EditorFileDeps => ({
  fs: {
    readFile: vi.fn(async () => ok('')),
    writeFile: vi.fn(async () => ok(undefined as void)),
    ...overrides,
  },
  store: useEditorStore,
});

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    mode: 'edit',
  });
});

// ────────────────────────────────────────────────────────────
// openFileByPath
// ────────────────────────────────────────────────────────────

describe('openFileByPath', () => {
  it('新文件:fs.readFile → createTab + openTab,active 变', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => ok('hello world')),
    });
    const r = await openFileByPath('/x/a.md', deps);
    expect(r.ok).toBe(true);
    const s = useEditorStore.getState();
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]).toMatchObject({
      id: '/x/a.md',
      filePath: '/x/a.md',
      content: 'hello world',
      originalContent: 'hello world',
      dirty: false,
    });
    expect(s.activeTabId).toBe('/x/a.md');
    expect(deps.fs.readFile).toHaveBeenCalledWith('/x/a.md');
  });

  it('已开过同 path → 不重读,只 switchTab', async () => {
    const existing = createTab('/x/a.md', 'cached');
    useEditorStore.setState({
      tabs: [existing, createTab('/x/b.md', 'b')],
      activeTabId: '/x/b.md',
    });
    const deps = makeDeps({
      readFile: vi.fn(async () => ok('SHOULD-NOT-BE-USED')),
    });
    const r = await openFileByPath('/x/a.md', deps);
    expect(r.ok).toBe(true);
    expect(useEditorStore.getState().activeTabId).toBe('/x/a.md');
    expect(useEditorStore.getState().tabs).toHaveLength(2);
    // 内容仍是 cached(不重读覆盖)
    expect(useEditorStore.getState().tabs[0]?.content).toBe('cached');
    expect(deps.fs.readFile).not.toHaveBeenCalled();
  });

  it('fs.readFile IpcFail → 不 open,返 IpcFail 透传', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => fail('FS_NOT_FOUND', 'gone')),
    });
    const r = await openFileByPath('/x/missing', deps);
    expect(r).toEqual({ ok: false, code: 'FS_NOT_FOUND', message: 'gone' });
    expect(useEditorStore.getState().tabs).toHaveLength(0);
  });

  it('fs.readFile 抛 → 不 crash,返 EXCEPTION', async () => {
    const deps = makeDeps({
      readFile: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const r = await openFileByPath('/x/a', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('EXCEPTION');
      expect(r.message).toContain('boom');
    }
  });
});

// ────────────────────────────────────────────────────────────
// saveFile
// ────────────────────────────────────────────────────────────

describe('saveFile', () => {
  it('成功 → fs.writeFile + store.markSaved,dirty=false', async () => {
    useEditorStore.setState({
      tabs: [
        {
          id: '/x/a.md',
          filePath: '/x/a.md',
          content: 'new content',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/x/a.md',
      mode: 'edit',
    });
    const writeFile = vi.fn(async () => ok(undefined as void));
    const deps = makeDeps({ writeFile });
    const r = await saveFile('/x/a.md', deps);
    expect(r.ok).toBe(true);
    expect(writeFile).toHaveBeenCalledWith('/x/a.md', 'new content');
    const tab = useEditorStore.getState().tabs[0];
    expect(tab?.dirty).toBe(false);
    expect(tab?.originalContent).toBe('new content');
  });

  it('tab 不存在 → ok:false code=TAB_NOT_FOUND', async () => {
    const r = await saveFile('/zombie', makeDeps());
    expect(r).toEqual({
      ok: false,
      code: 'TAB_NOT_FOUND',
      message: expect.any(String),
    });
  });

  it('untitled tab(无 filePath)→ ok:false code=UNSAVED_DRAFT', async () => {
    const draft = createTab(null, 'draft');
    useEditorStore.setState({ tabs: [draft], activeTabId: draft.id });
    const r = await saveFile(draft.id, makeDeps());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('UNSAVED_DRAFT');
  });

  it('fs.writeFile IpcFail → 透传,store 不 markSaved', async () => {
    useEditorStore.setState({
      tabs: [
        {
          id: '/x/a',
          filePath: '/x/a',
          content: 'new',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/x/a',
      mode: 'edit',
    });
    const deps = makeDeps({
      writeFile: vi.fn(async () => fail('FS_DENIED', 'no perm')),
    });
    const r = await saveFile('/x/a', deps);
    expect(r).toEqual({ ok: false, code: 'FS_DENIED', message: 'no perm' });
    // 仍然 dirty
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true);
  });

  it('fs.writeFile 抛 → 返 EXCEPTION,store 不变', async () => {
    useEditorStore.setState({
      tabs: [
        {
          id: '/x/a',
          filePath: '/x/a',
          content: 'new',
          originalContent: 'old',
          dirty: true,
        },
      ],
      activeTabId: '/x/a',
      mode: 'edit',
    });
    const deps = makeDeps({
      writeFile: vi.fn(async () => {
        throw new Error('disk');
      }),
    });
    const r = await saveFile('/x/a', deps);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXCEPTION');
    expect(useEditorStore.getState().tabs[0]?.dirty).toBe(true);
  });
});
