// @vitest-environment jsdom
// BDD: app-menu-bar 第 3 条 —— 菜单命令作用于获焦的窗口(popout 子窗获焦 → 命令文档是该子窗,同热键分发 runInCommandDocument);
// 编辑器命令从菜单点击作用于活动文本编辑器(同命令面板),accelerator 触发(viaKey)时按上下文条件重新判定。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { DockviewComponent, type DockviewApi } from 'dockview-react';
import { EditorView } from '@codemirror/view';
import { EditorSelection, EditorState } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';

const electronMock = vi.hoisted(() => {
  class FakeBrowserWindow {
    destroyed = false;
    url = 'file:///renderer/index.html';
    readonly webContents = {
      send: vi.fn(),
      getURL: () => this.url,
      opener: null as object | null,
    };
    constructor() {
      owner.set(this.webContents, this);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
  }
  const owner = new WeakMap<object, FakeBrowserWindow>();
  const frames = new Map<object, object>();
  return { FakeBrowserWindow, owner, frames };
});

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(electronMock.FakeBrowserWindow, {
    fromWebContents: (wc: object) => electronMock.owner.get(wc) ?? null,
  }),
  webContents: { fromFrame: (frame: object) => electronMock.frames.get(frame) },
}));

import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { sendMenuCommand } from '../../../electron/main/lib/menu-command';
import { runMenuCommand } from '@/shell/menu-commands';
import { CommandRegistry } from '@/plugins/registries/CommandRegistry';
import { setDockApi } from '@/shell/dock/dock-api-ref';
import { getCommandDocument, trackPopoutDocuments } from '@/shell/dock/popout-documents';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { createTab, useEditorStore } from '@/stores/editor.store';
import { codeEditorBasicSetup } from '@/panels/Editor/codemirror-basic-setup';
import { codeEditorTextCommands } from '@/panels/Editor/codemirror-text-commands';

type FakeWin = InstanceType<typeof electronMock.FakeBrowserWindow>;

const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

describe('main:菜单命令发给哪个窗口、带什么', () => {
  it('主窗获焦 → 发给它,fromPopout=false;accelerator 触发 → viaKey=true', () => {
    const main = new electronMock.FakeBrowserWindow();
    expect(sendMenuCommand(main as never, 'editor.action.commentLine')).toBe(true);
    expect(main.webContents.send).toHaveBeenLastCalledWith(WINDOW_CHANNELS.RUN_MENU_COMMAND, {
      id: 'editor.action.commentLine',
      fromPopout: false,
      viaKey: false,
    });
    sendMenuCommand(main as never, 'editor.action.commentLine', true);
    expect(main.webContents.send).toHaveBeenLastCalledWith(WINDOW_CHANNELS.RUN_MENU_COMMAND, {
      id: 'editor.action.commentLine',
      fromPopout: false,
      viaKey: true,
    });
  });

  it('popout 子窗获焦 → 发给打开它的主窗,fromPopout=true(命令作用于该子窗)', () => {
    const main: FakeWin = new electronMock.FakeBrowserWindow();
    const popout: FakeWin = new electronMock.FakeBrowserWindow();
    popout.url = 'file:///renderer/index.html?popout=1';
    const frame = {};
    popout.webContents.opener = frame;
    electronMock.frames.set(frame, main.webContents);
    expect(sendMenuCommand(popout as never, 'workbench.action.terminal.toggleTerminal')).toBe(true);
    expect(main.webContents.send).toHaveBeenCalledWith(WINDOW_CHANNELS.RUN_MENU_COMMAND, {
      id: 'workbench.action.terminal.toggleTerminal',
      fromPopout: true,
      viaKey: false,
    });
    expect(popout.webContents.send).not.toHaveBeenCalled();
  });
});

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const disposers: { dispose(): void }[] = [];

/** 主窗 + 一个 popout 子窗(iframe 充当子窗 document)。 */
function withPopout(): { api: DockviewApi; win: Window } {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  setDockApi(dock.api);
  dock.api.addPanel({ id: 'term', component: 'terminal', title: 'zsh' });
  const output = dock.api.addPanel({ id: 'output', component: 'output', title: 'Output', position: { direction: 'right' } });
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow!;
  disposers.push(trackPopoutDocuments(dock.api));
  act(() => {
    (output.group as unknown as { model: { location: unknown } }).model.location = { type: 'popout', getWindow: () => win };
  });
  return { api: dock.api, win };
}

describe('renderer:命令文档 = 获焦的窗口', () => {
  let reg: CommandRegistry;
  let seen: Document[];
  beforeEach(() => {
    seen = [];
    reg = new CommandRegistry();
    reg.register({ id: 'workbench.action.terminal.toggleTerminal', title: 'Toggle Terminal', fn: () => void seen.push(getCommandDocument()) });
  });
  afterEach(() => {
    cleanup();
    for (const d of disposers.splice(0)) d.dispose();
    setDockApi(null);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('fromPopout → 获焦的子窗文档;主窗来的 → 主窗文档(哪怕某个子窗 hasFocus)', async () => {
    const { win } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    runMenuCommand(reg, { id: 'workbench.action.terminal.toggleTerminal', fromPopout: true, viaKey: false });
    await flush();
    runMenuCommand(reg, { id: 'workbench.action.terminal.toggleTerminal', fromPopout: false, viaKey: false });
    await flush();
    expect(seen).toEqual([win.document, document]);
  });

  it('fromPopout 但没有子窗报告获焦:只有一个子窗 → 就是它', async () => {
    const { win } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(false);
    runMenuCommand(reg, { id: 'workbench.action.terminal.toggleTerminal', fromPopout: true, viaKey: false });
    await flush();
    expect(seen).toEqual([win.document]);
  });

  it('payload 不合法(旧格式裸 id / 非菜单命令 / 缺字段)→ 忽略', async () => {
    reg.register({ id: 'other.cmd', title: 'Other', fn: () => void seen.push(document) });
    runMenuCommand(reg, 'workbench.action.terminal.toggleTerminal');
    runMenuCommand(reg, { id: 'other.cmd', fromPopout: false, viaKey: false });
    runMenuCommand(reg, { id: 'workbench.action.terminal.toggleTerminal', fromPopout: false });
    await flush();
    expect(seen).toEqual([]);
  });
});

describe('renderer:编辑器命令从菜单执行', () => {
  const views: { tabId: string; view: EditorView }[] = [];
  function mount(tabId: string, doc: string): EditorView {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: EditorSelection.single(0),
        extensions: [codeEditorBasicSetup, codeEditorTextCommands(), javascript()],
      }),
      parent,
    });
    useEditorStore.getState().openTab(createTab(tabId, doc), { groupId: 'editor' });
    useEditorStore.getState().registerView(tabId, view, 'editor');
    views.push({ tabId, view });
    return view;
  }
  const menu = (id: string, viaKey: boolean) => runMenuCommand(coApp.commands, { id, fromPopout: false, viaKey });

  beforeAll(() => bootCorePlugins());
  afterAll(() => shutdownCorePlugins());
  beforeEach(() => {
    Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
    useEditorStore.setState({
      tabs: [],
      activeTabId: null,
      groups: [{ id: 'editor', tabIds: [], activeTabId: null }],
      activeGroupId: 'editor',
      viewRefs: new Map(),
    });
  });
  afterEach(() => {
    cleanup();
    for (const { tabId, view } of views.splice(0)) {
      useEditorStore.getState().unregisterView(tabId, view);
      view.destroy();
    }
    document.body.innerHTML = '';
  });

  it('点击:焦点不在编辑器(如在终端)也作用于活动文本编辑器,焦点交回编辑器(同命令面板)', async () => {
    const v = mount('/w/a.js', 'let a = 1;');
    const terminalInput = document.body.appendChild(document.createElement('textarea'));
    terminalInput.focus();
    menu('editor.action.commentLine', false);
    await flush();
    expect(v.state.doc.toString()).toBe('// let a = 1;');
    expect(v.dom.contains(document.activeElement)).toBe(true);
  });

  it('accelerator 触发(viaKey):焦点不在代码编辑器正文 → 不执行;在正文里 → 执行', async () => {
    const v = mount('/w/a.js', 'let a = 1;');
    const terminalInput = document.body.appendChild(document.createElement('textarea'));
    terminalInput.focus();
    menu('editor.action.commentLine', true);
    await flush();
    expect(v.state.doc.toString()).toBe('let a = 1;');
    v.contentDOM.focus();
    menu('editor.action.commentLine', true);
    await flush();
    expect(v.state.doc.toString()).toBe('// let a = 1;');
  });

  it('没有文本编辑器 → 静默', async () => {
    menu('editor.action.commentLine', false);
    await flush();
    expect(document.querySelector('.cm-editor')).toBeNull();
  });

  it('查找 / 替换:打开活动编辑器的查找面板,焦点留在面板里(替换 → 替换框)', async () => {
    const v = mount('/w/a.js', 'let a = 1;');
    menu('actions.find', false);
    await flush();
    const panel = v.dom.querySelector('.cm-search');
    expect(panel).not.toBeNull();
    expect(panel!.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLInputElement).name).toBe('search');
    menu('editor.action.startFindReplaceAction', false);
    await flush();
    expect((document.activeElement as HTMLInputElement).name).toBe('replace');
  });
});
