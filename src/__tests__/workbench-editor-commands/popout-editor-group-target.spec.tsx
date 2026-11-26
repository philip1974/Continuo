// @vitest-environment jsdom
// BDD: workbench-editor-commands / 8 编辑器组类命令作用于触发窗口的编辑器组;主窗获焦 → 主窗最近使用的组成为活动组。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { DockviewComponent, type DockviewApi, type IDockviewPanel } from 'dockview-react';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import { trackGroupMru } from '../../shell/dock/group-mru';
import { runInCommandDocument, trackPopoutDocuments } from '../../shell/dock/popout-documents';
import { trackEditorGroups } from '../../shell/dock/editor-groups-dock-sync';
import { POPOUT_RESTORE_POLL_MS, trackPopoutRestore } from '../../shell/dock/popout-restore-settle';
import { toggleActiveTerminalZoom } from '../../shell/dock/terminal-panel-zoom';
import { dockCommandSpecs } from '../../shell/dock/dock-panel-actions';
import {
  closeActiveGroupEditors,
  editorCommandSpecs,
  openAdjacentEditor,
  registerEditorPanelActions,
  registerMarkdownModeAction,
  revertActiveEditor,
  saveActiveEditor,
} from '../../panels/Editor/editor-commands';
import { splitEditor } from '../../panels/Editor/editor-groups-actions';
import { createTab, groupActiveTabIdOf, groupTabsOf, useEditorStore } from '../../stores/editor.store';

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), writeText: vi.fn() }));
vi.mock('../../panels/Editor/editor-file-deps', () => ({
  editorFileDeps: { fs: { readFile: mocks.readFile, writeFile: vi.fn() } },
}));
vi.mock('../../panels/Explorer/copy-to-clipboard', () => ({
  copyToClipboardOrNotify: (text: string) => mocks.writeText(text),
}));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const A = '/w/a.ts';
const B = '/w/b.ts';
const A2 = '/w/a2.ts';
const B2 = '/w/b2.ts';
const disposers: { dispose(): void }[] = [];

function createDock(): DockviewApi {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  setDockApi(dock.api);
  return dock.api;
}

function childWindow(): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  return frame.contentWindow!;
}

function popOut(group: IDockviewPanel['group'], win: Window): void {
  (group as unknown as { model: { location: unknown } }).model.location = { type: 'popout', getWindow: () => win };
}

/**
 * 主窗:编辑器组 editor(A、A2,活动 A);popout 子窗:编辑器组 editor:2(B、B2,活动 B)。
 * 用户最后用过子窗:dock 活动组与活动编辑器组都在子窗(点主窗标题栏 / 资源管理器切回时不变)。
 */
function editorGroupsInBothWindows() {
  useEditorStore.setState({
    tabs: [A, A2, B, B2].map((p) => createTab(p, `content ${p}`)),
    groups: [
      { id: 'editor', tabIds: [A, A2], activeTabId: A },
      { id: 'editor:2', tabIds: [B, B2], activeTabId: B },
    ],
    activeGroupId: 'editor',
    activeTabId: A,
    viewRefs: new Map(),
  });
  const api = createDock();
  const main = api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
  const child = api.addPanel({ id: 'editor:2', component: 'editor', title: 'Editor', position: { direction: 'right' } });
  const win = childWindow();
  disposers.push(trackGroupMru(api), trackPopoutDocuments(api), trackEditorGroups(api));
  act(() => popOut(child.group, win));
  main.api.setActive();
  child.api.setActive();
  expect(useEditorStore.getState().activeGroupId).toBe('editor:2');
  return { api, main, child, win };
}

/** 在主窗里按键(全局热键分发把按键所在文档标为主窗)。 */
const inMain = <T,>(fn: () => T): T => runInCommandDocument(document, fn);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  for (const d of disposers.splice(0)) d.dispose();
  setDockApi(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('主窗获得焦点 → 主窗最近使用的组成为活动组(与子窗获焦对称)', () => {
  it('从子窗切回主窗(窗口 focus)→ dock 活动组与活动编辑器组回到主窗的组,不移 DOM 焦点', () => {
    const { api, main } = editorGroupsInBothWindows();
    const explorerItem = document.createElement('button');
    document.body.appendChild(explorerItem);
    explorerItem.focus();
    window.dispatchEvent(new FocusEvent('focus'));
    expect(api.activeGroup).toBe(main.group);
    expect(useEditorStore.getState().activeGroupId).toBe('editor');
    expect(document.activeElement).toBe(explorerItem);
  });

  it('活动组本就在主窗 → 不动', () => {
    const { api, main } = editorGroupsInBothWindows();
    main.api.setActive();
    const other = api.addPanel({ id: 'term', component: 'terminal', title: 'zsh', position: { referencePanel: main, direction: 'below' } });
    other.api.setActive();
    window.dispatchEvent(new FocusEvent('focus'));
    expect(api.activePanel).toBe(other);
  });

  it('停止跟踪后不再响应主窗焦点', () => {
    const { api, child } = editorGroupsInBothWindows();
    for (const d of disposers.splice(0)) d.dispose();
    window.dispatchEvent(new FocusEvent('focus'));
    expect(api.activePanel).toBe(child);
  });
});

describe('重启恢复挂上 popout 子窗(dockview 把子窗组设为活动组)→ 落定时改回主窗的组', () => {
  function restoring() {
    vi.useFakeTimers();
    useEditorStore.setState({
      tabs: [A, B].map((p) => createTab(p, p)),
      groups: [
        { id: 'editor', tabIds: [A], activeTabId: A },
        { id: 'editor:2', tabIds: [B], activeTabId: B },
      ],
      activeGroupId: 'editor',
      activeTabId: A,
    });
    const api = createDock();
    const main = api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
    const child = api.addPanel({ id: 'editor:2', component: 'editor', title: 'Editor', position: { direction: 'right' } });
    main.api.setActive(); // fromJSON 恢复的活动组
    const tracking = trackPopoutRestore(api, 1);
    disposers.push(tracking, trackGroupMru(api), trackEditorGroups(api));
    const win = childWindow();
    // dockview addPopoutGroup:挂进子窗后 doSetGroupAndPanelActive(popout 组)
    act(() => {
      popOut(child.group, win);
      child.group.api.setActive();
    });
    expect(useEditorStore.getState().activeGroupId).toBe('editor:2');
    return { api, main, child, win };
  }

  it('子窗没有焦点 → 活动组 / 活动编辑器组改回持久化的主窗组', async () => {
    const { api, main } = restoring();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POPOUT_RESTORE_POLL_MS * 2);
    });
    expect(api.activeGroup).toBe(main.group);
    expect(useEditorStore.getState().activeGroupId).toBe('editor');
  });

  it('恢复期间用户已切到子窗(子窗有焦点)→ 不改', async () => {
    const { api, child, win } = restoring();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POPOUT_RESTORE_POLL_MS * 2);
    });
    expect(api.activeGroup).toBe(child.group);
  });
});

describe('编辑器组类命令作用于触发窗口的编辑器组(活动编辑器组仍在子窗时主窗按键 / 主窗命令面板)', () => {
  it('⌘\\ 拆分编辑器 → 拆主窗的组(新组在主窗、打开主窗的活动文件),不在子窗新建组', () => {
    const { api, win } = editorGroupsInBothWindows();
    expect(inMain(() => splitEditor('right'))).toBe(true);
    const created = api.getPanel('editor:3')!;
    expect(created.group.api.location.type).toBe('grid');
    expect(groupTabsOf(useEditorStore.getState(), 'editor:3').map((t) => t.id)).toEqual([A]);
    expect(api.groups.filter((g) => g.api.location.type === 'popout' && g.api.location.getWindow() === win)).toHaveLength(1);
  });

  it('关闭组中的所有编辑器 / 其它 / 右侧 / 已保存 → 关主窗组的 tab,不关子窗的', () => {
    editorGroupsInBothWindows();
    const mainClose = vi.fn();
    const childClose = vi.fn();
    const noop = { save: vi.fn(async () => {}), closeActiveTab: () => false };
    disposers.push({ dispose: registerEditorPanelActions({ ...noop, closeTabs: mainClose }, 'editor') });
    disposers.push({ dispose: registerEditorPanelActions({ ...noop, closeTabs: childClose }, 'editor:2') });
    inMain(() => closeActiveGroupEditors('all'));
    inMain(() => closeActiveGroupEditors('others'));
    expect(mainClose).toHaveBeenNthCalledWith(1, [A, A2]);
    expect(mainClose).toHaveBeenNthCalledWith(2, [A2]);
    expect(childClose).not.toHaveBeenCalled();
  });

  it('⌘S 保存 → 保存主窗组(不保存子窗组)', async () => {
    editorGroupsInBothWindows();
    const mainSave = vi.fn(async () => {});
    const childSave = vi.fn(async () => {});
    const rest = { closeActiveTab: () => false, closeTabs: vi.fn() };
    disposers.push({ dispose: registerEditorPanelActions({ ...rest, save: mainSave }, 'editor') });
    disposers.push({ dispose: registerEditorPanelActions({ ...rest, save: childSave }, 'editor:2') });
    await inMain(() => saveActiveEditor());
    expect(mainSave).toHaveBeenCalledTimes(1);
    expect(childSave).not.toHaveBeenCalled();
  });

  it('Markdown 模式切换 → 主窗组的编辑器', () => {
    editorGroupsInBothWindows();
    const mainMode = vi.fn();
    const childMode = vi.fn();
    disposers.push({ dispose: registerMarkdownModeAction(mainMode, 'editor') });
    disposers.push({ dispose: registerMarkdownModeAction(childMode, 'editor:2') });
    const spec = editorCommandSpecs('mac').find((c) => c.id === 'markdown.switchToPreviewMode')!;
    inMain(() => spec.fn());
    expect(mainMode).toHaveBeenCalledWith('preview');
    expect(childMode).not.toHaveBeenCalled();
  });

  it('复制活动文件路径 / 还原文件 → 主窗组的活动文件', async () => {
    editorGroupsInBothWindows();
    const copy = editorCommandSpecs('mac').find((c) => c.id === 'copyFilePath')!;
    inMain(() => copy.fn());
    expect(mocks.writeText).toHaveBeenCalledWith(A);
    mocks.readFile.mockResolvedValue({ ok: true, data: 'disk' });
    await inMain(() => revertActiveEditor());
    expect(mocks.readFile).toHaveBeenCalledWith(A);
  });

  it('下一个编辑器 → 在主窗组内切换', () => {
    editorGroupsInBothWindows();
    inMain(() => openAdjacentEditor(1));
    const s = useEditorStore.getState();
    expect(groupActiveTabIdOf(s, 'editor')).toBe(A2);
    expect(groupActiveTabIdOf(s, 'editor:2')).toBe(B);
  });

  it('主窗活动面板是终端 → 取主窗的编辑器组(不取子窗的活动编辑器组)', () => {
    const { api, main } = editorGroupsInBothWindows();
    const term = api.addPanel({ id: 'term', component: 'terminal', title: 'zsh', position: { referencePanel: main, direction: 'below' } });
    term.api.setActive();
    api.getPanel('editor:2')!.api.setActive();
    inMain(() => openAdjacentEditor(1));
    expect(groupActiveTabIdOf(useEditorStore.getState(), 'editor')).toBe(A2);
  });

  it('子窗里触发 → 子窗的组', () => {
    const { main, win } = editorGroupsInBothWindows();
    main.api.setActive();
    runInCommandDocument(win.document, () => openAdjacentEditor(1));
    const s = useEditorStore.getState();
    expect(groupActiveTabIdOf(s, 'editor:2')).toBe(B2);
    expect(groupActiveTabIdOf(s, 'editor')).toBe(A);
  });
});

describe('同源:⇧⌘Enter 最大化终端作用于触发窗口的终端', () => {
  it('活动组在子窗、主窗里按 → 最大化主窗正显示的终端', () => {
    const api = createDock();
    const term = api.addPanel({ id: 'term', component: 'terminal', title: 'zsh' });
    api.addPanel({ id: 'term-2', component: 'terminal', title: 'zsh', position: { referencePanel: term, direction: 'right' } });
    const output = api.addPanel({ id: 'output', component: 'output', title: 'Output', position: { direction: 'right' } });
    disposers.push(trackGroupMru(api));
    act(() => popOut(output.group, childWindow()));
    term.api.setActive();
    output.api.setActive();
    const maximize = vi.spyOn(api, 'maximizeGroup').mockImplementation(() => {});
    inMain(() => toggleActiveTerminalZoom(api));
    expect(maximize).toHaveBeenCalledWith(term);
  });
});

describe('同源:「将组移到新窗口」作用于触发窗口的活动面板', () => {
  it('活动组在子窗、主窗命令面板执行 → 弹出主窗正显示的面板(此前因活动面板已在子窗而无反应)', () => {
    const { api, main } = editorGroupsInBothWindows();
    const addPopout = vi.spyOn(api, 'addPopoutGroup').mockResolvedValue(true);
    const spec = dockCommandSpecs().find((c) => c.id === 'workbench.action.moveEditorGroupToNewWindow')!;
    inMain(() => spec.fn());
    expect(addPopout).toHaveBeenCalledWith(main, expect.anything());
  });
});
