// @vitest-environment jsdom
// BDD:活动编辑器组在 popout 子窗时,从主窗打开文件落在主窗(主窗没有编辑器组 → 在主窗新建),从子窗打开仍落在子窗;落在子窗的
// 编辑器组面板被显示时聚焦子窗。VSCode:按获焦窗口的编辑器区取活动组(EditorParts.activePart)。见同目录 README.md「打开文件」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DockviewComponent, type DockviewApi, type IDockviewPanel } from 'dockview-react';
import { markDockLayoutRestored, setDockApi, showEditorGroupPanel } from '@/shell/dock/dock-api-ref';
import { trackGroupMru } from '@/shell/dock/group-mru';
import { runInCommandDocument } from '@/shell/dock/popout-documents';
import { createTab, editorGroupIdsOf, groupTabsOf, useEditorStore } from '@/stores/editor.store';
import { openFileByPath, type EditorFileDeps } from '@/panels/Editor/editor-file-actions';
import { newUntitledFile } from '@/panels/Editor/untitled';
import { reopenClosedEditor } from '@/panels/Editor/reopen-closed-editor';
import { clearRecentlyClosedEditors } from '@/panels/Editor/recently-closed-editors';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let mru: { dispose(): void } | null = null;

function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  mru = trackGroupMru(dock.api);
  return dock.api;
}

/** 把面板所在组标成 popout 子窗,返回子窗 document 与 focus 桩。 */
function popOut(panel: IDockviewPanel): { doc: Document; focus: ReturnType<typeof vi.fn> } {
  const focus = vi.fn();
  const doc = document.implementation.createHTMLDocument('child');
  const win = Object.assign(new EventTarget(), { focus, document: doc });
  (panel.group as unknown as { model: { location: unknown } }).model.location = { type: 'popout', getWindow: () => win };
  return { doc, focus };
}

const A = '/w/a.ts';
const B = '/w/b.ts';
const st = () => useEditorStore.getState();
const ids = (groupId: string): string[] => groupTabsOf(st(), groupId).map((t) => t.id);
const deps = {
  fs: { readFile: vi.fn(async (p: string) => ({ ok: true as const, data: `disk ${p}` })), writeFile: vi.fn() },
} as unknown as EditorFileDeps;
const windowOf = (id: string) => (setupApi!.getPanel(id)?.api.location.type === 'popout' ? 'popout' : 'main');

let setupApi: DockviewApi | null = null;

/**
 * 唯一的编辑器组(editor,开着 A)移到了新窗口(workbench.action.moveEditorGroupToNewWindow):主窗 dock 里没有编辑器组,
 * 活动编辑器组在子窗。extraMain:主窗另有一个编辑器组 editor:2(开着 B)。
 */
function movedToNewWindow(opts: { extraMain?: boolean } = {}) {
  st().openTab(createTab(A, 'disk a'));
  const api = createDock();
  setupApi = api;
  if (opts.extraMain) {
    st().splitGroup('editor', 'editor:2', null);
    st().openTab(createTab(B, 'disk b'), { groupId: 'editor:2' });
    api.addPanel({ id: 'editor:2', component: 'editor', title: 'Editor' });
  }
  const editor = api.addPanel({ id: 'editor', component: 'editor', title: 'Editor', position: { direction: 'right' } });
  const child = popOut(editor);
  editor.api.setActive();
  st().setActiveGroup('editor');
  setDockApi(api);
  markDockLayoutRestored(api);
  return { api, editor, child };
}

beforeEach(() => {
  useEditorStore.setState({
    tabs: [],
    activeTabId: null,
    groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
    activeGroupId: 'editor',
    mode: 'source',
    viewRefs: new Map(),
  });
  clearRecentlyClosedEditors();
});

afterEach(() => {
  mru?.dispose();
  mru = null;
  setDockApi(null);
  setupApi = null;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('活动编辑器组在 popout 子窗时打开文件', () => {
  it('主窗没有编辑器组、从主窗打开(资源管理器 / ⌘P / 搜索结果 / 终端链接都经 openFileByPath)→ 在主窗新建编辑器组打开,不落进子窗', async () => {
    movedToNewWindow();
    expect((await openFileByPath(B, deps, { preview: true })).ok).toBe(true);

    const created = st().activeGroupId;
    expect(created).not.toBe('editor');
    expect(ids(created)).toEqual([B]);
    expect(windowOf(created)).toBe('main');
    expect(ids('editor')).toEqual([A]);
  });

  it('主窗另有编辑器组 → 落在主窗的那个组,不新建', async () => {
    movedToNewWindow({ extraMain: true });
    await openFileByPath('/w/c.ts', deps);

    expect(st().activeGroupId).toBe('editor:2');
    expect(ids('editor:2')).toContain('/w/c.ts');
    expect(ids('editor')).toEqual([A]);
    expect(editorGroupIdsOf(st())).toHaveLength(2);
  });

  it('文件已在子窗的组里开着、从主窗再打开 → 在主窗的组里打开它(VSCode 同:在活动组打开,不跳到别的窗口)', async () => {
    movedToNewWindow();
    await openFileByPath(A, deps);

    const created = st().activeGroupId;
    expect(created).not.toBe('editor');
    expect(windowOf(created)).toBe('main');
    expect(ids(created)).toEqual([A]);
    expect(ids('editor')).toEqual([A]);
  });

  it('从子窗打开(按键 / 点击在子窗)→ 仍落在子窗的组', async () => {
    const { child } = movedToNewWindow({ extraMain: true });
    st().setActiveGroup('editor:2'); // 全局活动编辑器组在主窗
    await runInCommandDocument(child.doc, () => openFileByPath('/w/c.ts', deps));

    expect(ids('editor')).toContain('/w/c.ts');
    expect(ids('editor:2')).not.toContain('/w/c.ts');
    expect(st().activeGroupId).toBe('editor');
  });

  it('活动编辑器组本就在主窗 → 照旧落在活动组', async () => {
    st().openTab(createTab(A, 'disk a'));
    const api = createDock();
    setupApi = api;
    api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    setDockApi(api);
    await openFileByPath(B, deps);

    expect(editorGroupIdsOf(st())).toEqual(['editor']);
    expect(ids('editor')).toEqual([A, B]);
  });

  it('显式指定组(拖到某个组 / 后退前进回原组)→ 不改投', async () => {
    movedToNewWindow({ extraMain: true });
    await openFileByPath('/w/c.ts', deps, { groupId: 'editor' });
    expect(ids('editor')).toContain('/w/c.ts');
  });

  it('⌘N 新建无标题文件同样落在主窗', () => {
    movedToNewWindow();
    const id = newUntitledFile();
    const created = st().activeGroupId;
    expect(created).not.toBe('editor');
    expect(windowOf(created)).toBe('main');
    expect(ids(created)).toEqual([id]);
  });

  it('⇧⌘T 在主窗按(原组已不在、主窗没有编辑器组)→ 在主窗新建编辑器组重开', async () => {
    st().openTab(createTab(A, 'disk a'));
    st().splitGroup('editor', 'editor:2', null);
    st().openTab(createTab(B, 'disk b'), { groupId: 'editor:2' });
    const api = createDock();
    setupApi = api;
    api.addPanel({ id: 'editor:2', component: 'editor', title: 'Editor' });
    const editor = api.addPanel({ id: 'editor', component: 'editor', title: 'Editor', position: { direction: 'right' } });
    popOut(editor);
    setDockApi(api);
    st().closeTab(B, 'editor:2'); // editor:2 随最后一个 tab 关闭,其面板随之关闭(此处手动移除)
    api.getPanel('editor:2')?.api.close();
    editor.api.setActive();
    st().setActiveGroup('editor');

    expect(await reopenClosedEditor(deps)).toBe(true);
    const created = st().activeGroupId;
    expect(created).not.toBe('editor');
    expect(windowOf(created)).toBe('main');
    expect(ids(created)).toEqual([B]);
  });
});

describe('显示落在 popout 子窗的编辑器组面板', () => {
  it('面板在子窗 → 激活并聚焦子窗(键盘随之过去)', () => {
    const { editor, child } = movedToNewWindow();
    showEditorGroupPanel(editor);
    expect(child.focus).toHaveBeenCalled();
  });

  it('面板在主窗 → 只激活,不动子窗', () => {
    const { api, child } = movedToNewWindow({ extraMain: true });
    const main = api.getPanel('editor:2')!;
    showEditorGroupPanel(main);
    expect(api.activePanel).toBe(main);
    expect(child.focus).not.toHaveBeenCalled();
  });
});
