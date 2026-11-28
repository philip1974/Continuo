// @vitest-environment jsdom
// BDD: workbench-editor-commands / 7 ⌘W 只作用于按键所在的窗口;popout 子窗获焦时其组成为活动组。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { DockviewComponent, type DockviewApi, type IDockviewPanel } from 'dockview-react';
import { setDockApi } from '../../shell/dock/dock-api-ref';
import { activePanelInDocument, trackGroupMru } from '../../shell/dock/group-mru';
import { trackPopoutDocuments } from '../../shell/dock/popout-documents';
import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { CLOSE_ACTIVE_EDITOR_COMMAND, closeActiveEditor } from '../../panels/Editor/editor-commands';
import { registerTerminalPanelHandles } from '../../panels/Terminal/terminal-panel-handles';
import { runInCommandDocument } from '../../shell/dock/popout-documents';
import TerminalPlugin from '../../core-plugins/TerminalPlugin';

const mocks = vi.hoisted(() => ({ closeWindow: vi.fn() }));
vi.mock('../../lib/co-api', () => ({ coApi: { window: { close: mocks.closeWindow } } }));

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

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

/** 一个 popout 子窗(iframe 充当子窗的 window / document)。 */
function childWindow(): Window {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  return frame.contentWindow!;
}

/** 把组标成挂在 win 子窗里的 popout 组(dockview addPopoutGroup 挂上后的 location;setter 派发 onDidLocationChange)。 */
function popOut(group: IDockviewPanel['group'], win: Window): void {
  (group as unknown as { model: { location: unknown } }).model.location = { type: 'popout', getWindow: () => win };
}

/** 主窗:终端 term;子窗:输出 output。 */
function mainAndPopout() {
  const api = createDock();
  const term = api.addPanel({ id: 'term', component: 'terminal', title: 'zsh' });
  const output = api.addPanel({ id: 'output', component: 'output', title: 'Output', position: { direction: 'right' } });
  const win = childWindow();
  disposers.push(trackGroupMru(api), trackPopoutDocuments(api));
  act(() => popOut(output.group, win));
  return { api, term, output, win };
}

function mountHotkeys(): void {
  const reg = new CommandRegistry();
  reg.register({ ...CLOSE_ACTIVE_EDITOR_COMMAND, title: 'Close Editor', fn: closeActiveEditor });
  renderHook(() => useCommandHotkeys(reg));
}

// jsdom detectPlatform() = 'other' → mod = Ctrl
async function pressCloseIn(doc: Document): Promise<void> {
  doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true, bubbles: true, cancelable: true }));
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.closeWindow.mockResolvedValue({ ok: true, data: undefined });
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => {
  cleanup();
  for (const d of disposers.splice(0)) d.dispose();
  setDockApi(null);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('⌘W 只作用于按键所在的窗口', () => {
  it('子窗里按(活动面板仍在主窗:点子窗标题栏 / ⌘` 切过去)→ 关子窗里的活动面板;主窗面板与主窗都不动', async () => {
    const { api, term, win } = mainAndPopout();
    term.api.setActive();
    mountHotkeys();
    await pressCloseIn(win.document);
    expect(api.getPanel('output')).toBeUndefined();
    expect(api.getPanel('term')).toBeDefined();
    expect(mocks.closeWindow).not.toHaveBeenCalled();
  });

  it('子窗里没有可关的面板 → 只关这个子窗,不关主窗、不关主窗面板', async () => {
    const { api, term } = mainAndPopout();
    const emptyWin = childWindow();
    const close = vi.spyOn(emptyWin, 'close').mockImplementation(() => {});
    const empty = api.addGroup({ direction: 'right' });
    act(() => popOut(empty as unknown as IDockviewPanel['group'], emptyWin));
    term.api.setActive();
    mountHotkeys();
    await pressCloseIn(emptyWin.document);
    expect(close).toHaveBeenCalledTimes(1);
    expect(mocks.closeWindow).not.toHaveBeenCalled();
    expect(api.getPanel('term')).toBeDefined();
    expect(api.getPanel('output')).toBeDefined();
  });

  it('主窗里按(活动组仍在子窗:从子窗点主窗标题栏切回)→ 关主窗正显示的面板,不关子窗的', async () => {
    const { api, output } = mainAndPopout();
    output.api.setActive();
    mountHotkeys();
    await pressCloseIn(document);
    expect(api.getPanel('term')).toBeUndefined();
    expect(api.getPanel('output')).toBeDefined();
    expect(mocks.closeWindow).not.toHaveBeenCalled();
  });

  it('主窗没有可关的面板(都在子窗)→ 关主窗(window:close)', async () => {
    const { api, term } = mainAndPopout();
    term.api.close();
    api.getPanel('output')!.api.setActive();
    mountHotkeys();
    await pressCloseIn(document);
    expect(mocks.closeWindow).toHaveBeenCalledTimes(1);
    expect(api.getPanel('output')).toBeDefined();
  });

  it('窗口级命令取触发窗口的活动面板:主窗 → 主窗正显示的面板;子窗 → 该子窗组的活动面板', () => {
    const { api, term, output, win } = mainAndPopout();
    output.api.setActive();
    expect(activePanelInDocument(api, document)).toBe(term);
    term.api.setActive();
    expect(activePanelInDocument(api, win.document)).toBe(output);
  });
});

describe('同源的窗口级命令:终端查找 / 清屏作用于触发窗口的终端', () => {
  function terminalCommands() {
    const fns = new Map<string, () => unknown>();
    const app = {
      commands: { register: (spec: { id: string; fn: () => unknown }) => (fns.set(spec.id, spec.fn), { dispose: () => {} }) },
      panels: { register: () => ({ dispose: () => {} }) },
    };
    new TerminalPlugin(app as never, { id: 'continuo.terminal', name: 'Terminal' } as never).onload();
    return fns;
  }

  function terminalsInBothWindows() {
    const api = createDock();
    const mainTerm = api.addPanel({ id: 'term-main', component: 'terminal', title: 'zsh' });
    const childTerm = api.addPanel({ id: 'term-child', component: 'terminal', title: 'zsh', position: { direction: 'right' } });
    const win = childWindow();
    act(() => popOut(childTerm.group, win));
    const handles = (id: string) => {
      const h = { focus: vi.fn(), openSearch: vi.fn(), clear: vi.fn(), scroll: vi.fn(), clipboard: vi.fn(), readText: vi.fn(() => ''), readViewport: vi.fn(() => null) };
      disposers.push({ dispose: registerTerminalPanelHandles(id, h) });
      return h;
    };
    return { mainTerm, childTerm, win, main: handles('term-main'), child: handles('term-child') };
  }

  it('主窗按 ⌘K / ⌘F(活动组仍在子窗)→ 清 / 查主窗正显示的终端,不动子窗的终端', () => {
    const fns = terminalCommands();
    const { childTerm, main, child } = terminalsInBothWindows();
    childTerm.api.setActive();
    runInCommandDocument(document, () => fns.get('terminal.clear')!());
    runInCommandDocument(document, () => fns.get('terminal.search.toggle')!());
    expect(main.clear).toHaveBeenCalledTimes(1);
    expect(main.openSearch).toHaveBeenCalledTimes(1);
    expect(child.clear).not.toHaveBeenCalled();
    expect(child.openSearch).not.toHaveBeenCalled();
  });
});

describe('popout 子窗获得焦点 → 其组成为活动组(VSCode:辅助窗口获焦时其编辑器组成为活动组)', () => {
  it('子窗窗口获焦(点标题栏 / ⌘`)→ 活动组 / 活动面板切到子窗', () => {
    const { api, term, output, win } = mainAndPopout();
    term.api.setActive();
    win.dispatchEvent(new FocusEvent('focus'));
    expect(api.activeGroup).toBe(output.group);
    expect(api.activePanel).toBe(output);
  });

  it('焦点进入子窗里的元素(focusin)→ 同样切到子窗', () => {
    const { api, term, output, win } = mainAndPopout();
    term.api.setActive();
    win.document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(api.activePanel).toBe(output);
  });

  it('停止跟踪后不再响应子窗焦点', () => {
    const { api, term, win } = mainAndPopout();
    term.api.setActive();
    for (const d of disposers.splice(0)) d.dispose();
    win.dispatchEvent(new FocusEvent('focus'));
    expect(api.activePanel).toBe(term);
  });
});
