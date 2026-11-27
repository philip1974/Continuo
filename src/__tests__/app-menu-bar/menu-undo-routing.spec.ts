// @vitest-environment jsdom
// BDD: app-menu-bar 第 6 条 —— 应用菜单「编辑 → 撤销 / 重做」按焦点分派(VSCode UndoCommand / RedoCommand 多实现,资源管理器
// 实现优先):鼠标点击 → 发给目标主窗;renderer 里文件树聚焦 → 撤销 / 重做文件操作,否则请 main 做原生撤销(作用于获焦窗口,
// popout 子窗获焦 → 该子窗);按键触发 / 无可用主窗 / DevTools 获焦 → 直接原生。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
  class FakeBrowserWindow {
    url = 'file:///renderer/index.html';
    readonly webContents = {
      send: vi.fn(),
      getURL: () => this.url,
      opener: null as object | null,
      undo: vi.fn(),
      redo: vi.fn(),
      isDestroyed: () => false,
    };
    constructor() {
      owner.set(this.webContents, this);
    }
    isDestroyed(): boolean {
      return false;
    }
  }
  const owner = new WeakMap<object, FakeBrowserWindow>();
  const state = { focused: null as object | null };
  return { FakeBrowserWindow, owner, state };
});

vi.mock('electron', () => ({
  BrowserWindow: Object.assign(electronMock.FakeBrowserWindow, {
    fromWebContents: (wc: object) => electronMock.owner.get(wc) ?? null,
  }),
  webContents: { fromFrame: () => undefined, getFocusedWebContents: () => electronMock.state.focused },
}));

const coApiMock = vi.hoisted(() => ({ viewAction: vi.fn(async () => ({ ok: true, data: undefined })) }));
vi.mock('@/lib/co-api', () => ({ coApi: { window: coApiMock } }));

import { WINDOW_CHANNELS } from '../../../electron/shared/window-channels';
import { runEditUndoRedo as mainRunEditUndoRedo } from '../../../electron/main/lib/menu-command';
import { runEditUndoRedo } from '@/shell/menu-commands';
import { EXPLORER_FILE_TREE_ATTR } from '@/panels/Explorer/tree-keyboard';
import { onExplorerRequest, __resetExplorerRequestsForTest, type ExplorerRequest } from '@/panels/Explorer/explorer-requests';
import { useWorkspaceStore } from '@/stores/workspace.store';

describe('main:点击 / 按键', () => {
  beforeEach(() => {
    electronMock.state.focused = null;
  });

  it('鼠标点击 → 发 EDIT_UNDO_REDO 给主窗,不做原生撤销', () => {
    const win = new electronMock.FakeBrowserWindow();
    electronMock.state.focused = win.webContents;
    mainRunEditUndoRedo(win as never, 'undo', false);
    expect(win.webContents.send).toHaveBeenCalledWith(WINDOW_CHANNELS.EDIT_UNDO_REDO, { op: 'undo', fromPopout: false });
    expect(win.webContents.undo).not.toHaveBeenCalled();
  });

  it('按键触发(renderer 没处理的 ⌘Z)→ 获焦 webContents 原生撤销 / 重做(同原 role 项),不发给 renderer', () => {
    const win = new electronMock.FakeBrowserWindow();
    electronMock.state.focused = win.webContents;
    mainRunEditUndoRedo(win as never, 'redo', true);
    expect(win.webContents.redo).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('DevTools 获焦(webContents 不属于任何窗口)→ 原生撤销作用于 DevTools', () => {
    const win = new electronMock.FakeBrowserWindow();
    const devtools = { undo: vi.fn(), redo: vi.fn(), isDestroyed: () => false };
    electronMock.state.focused = devtools;
    mainRunEditUndoRedo(win as never, 'undo', false);
    expect(devtools.undo).toHaveBeenCalledTimes(1);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });
});

describe('renderer:按焦点分派', () => {
  const requests: ExplorerRequest[] = [];
  let off: () => void = () => {};
  beforeEach(() => {
    __resetExplorerRequestsForTest();
    requests.length = 0;
    off = onExplorerRequest((r) => {
      requests.push(r);
      return true;
    });
    coApiMock.viewAction.mockClear();
    useWorkspaceStore.setState({ root: '/ws' });
    document.body.innerHTML = `
      <div ${EXPLORER_FILE_TREE_ATTR} role="tree" tabindex="0">
        <div role="treeitem" tabindex="0" id="row">a.ts</div>
        <div role="treeitem"><input id="rename" /></div>
      </div>
      <input id="other" />`;
  });
  afterEach(() => {
    off();
    document.body.innerHTML = '';
  });

  it('文件树的行聚焦 → 撤销 / 重做文件操作,不做原生撤销', () => {
    (document.getElementById('row') as HTMLElement).focus();
    runEditUndoRedo({ op: 'undo', fromPopout: false });
    runEditUndoRedo({ op: 'redo', fromPopout: false });
    expect(requests).toEqual([{ kind: 'undo' }, { kind: 'redo' }]);
    expect(coApiMock.viewAction).not.toHaveBeenCalled();
  });

  it('焦点在别处(编辑器 / 输入框 / 树里的改名输入框)→ 请 main 原生撤销,不碰文件操作', async () => {
    for (const id of ['other', 'rename']) {
      (document.getElementById(id) as HTMLElement).focus();
      runEditUndoRedo({ op: 'undo', fromPopout: false });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual([]);
    expect(coApiMock.viewAction).toHaveBeenCalledTimes(2);
    expect(coApiMock.viewAction).toHaveBeenCalledWith('undo');
  });

  it('没有工作区 / 畸形 payload → 不撤销文件操作', async () => {
    useWorkspaceStore.setState({ root: null });
    (document.getElementById('row') as HTMLElement).focus();
    runEditUndoRedo({ op: 'undo', fromPopout: false });
    runEditUndoRedo({ op: 'rm -rf', fromPopout: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual([]);
    expect(coApiMock.viewAction).toHaveBeenCalledTimes(1);
  });
});
