// @vitest-environment jsdom
// BDD: popout-picker —— 选择器画在触发它的窗口(popout 子窗里打开 → 画进子窗,焦点 / Esc 都在子窗);在主窗打开面板而焦点
// 在子窗 → 激活主窗。见同目录 README。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { DockviewComponent, type DockviewApi, type IDockviewPanel } from 'dockview-react';

vi.mock('@/plugins/quick-open/walk-files', () => ({ walkWorkspaceFiles: vi.fn(async () => []) }));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ index: i, start: i * 28, size: 28, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));

import { runMenuCommand } from '@/shell/menu-commands';
import { PickerModals } from '@/shell/PickerModals';
import { markDockLayoutRestored, openOrFocusPanelNow, setDockApi } from '@/shell/dock/dock-api-ref';
import { trackPopoutDocuments } from '@/shell/dock/popout-documents';
import { reconcileTerminalPanels } from '@/shell/dock/DockReconciler';
import { showExplorer } from '@/panels/Explorer/explorer-commands';
import { bootCorePlugins, shutdownCorePlugins } from '@/core-plugins';
import { coApp } from '@/plugins/co-app';
import { useCommandHotkeys } from '@/plugins/command-palette/useCommandHotkeys';
import { useCommandPaletteHotkey } from '@/plugins/command-palette/useCommandPaletteHotkey';
import { useQuickOpenHotkey } from '@/plugins/quick-open/useQuickOpenHotkey';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { useOpenRecentStore } from '@/plugins/open-recent/store';
import { detectPlatform } from '@/plugins/command-palette/format-hotkey';
import { _resetLmApiForTest } from '@/lib/co-api';

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const focusWindow = vi.fn(async () => ({ ok: true, data: undefined }));
const disposers: { dispose(): void }[] = [];

/** 主窗(editor)+ 一个 popout 子窗(iframe 充当子窗 document,组里是 popped)。 */
function withPopout(): { api: DockviewApi; win: Window; popped: IDockviewPanel } {
  vi.stubGlobal('ResizeObserver', NoopResizeObserver);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const dock = new DockviewComponent(container, {
    createComponent: () => ({ element: document.createElement('div'), init: () => {} }),
  });
  setDockApi(dock.api);
  markDockLayoutRestored(dock.api);
  dock.api.addPanel({ id: 'editor', component: 'editor', title: 'Editor' });
  const popped = dock.api.addPanel({ id: 'popped', component: 'plugin', title: 'P', position: { direction: 'right' } });
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const win = frame.contentWindow!;
  disposers.push(trackPopoutDocuments(dock.api));
  act(() => {
    (popped.group as unknown as { model: { location: unknown } }).model.location = { type: 'popout', getWindow: () => win };
  });
  return { api: dock.api, win, popped };
}

function Harness() {
  useQuickOpenHotkey();
  useCommandPaletteHotkey();
  useCommandHotkeys(coApp.commands);
  return <PickerModals commands={coApp.commands} />;
}

const dialogIn = (doc: Document) => doc.querySelector('[role="dialog"]');
const menu = (id: string, fromPopout: boolean, viaKey = false) =>
  act(() => runMenuCommand(coApp.commands, { id, fromPopout, viaKey }));
const isMac = detectPlatform() === 'mac';
const mod = isMac ? { metaKey: true } : { ctrlKey: true };

beforeAll(() => bootCorePlugins());
afterAll(() => shutdownCorePlugins());

beforeEach(() => {
  focusWindow.mockClear();
  _resetLmApiForTest();
  vi.stubGlobal('api', { window: { focus: focusWindow, setMenuKeybindings: vi.fn(async () => ({ ok: true })) } });
  for (const store of [useQuickOpenStore, useCommandPaletteStore, useOpenRecentStore]) store.getState().close();
});

afterEach(() => {
  cleanup();
  for (const d of disposers.splice(0)) d.dispose();
  setDockApi(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('1. 选择器画在触发它的窗口', () => {
  it.each([
    ['workbench.action.quickOpen', ''],
    ['workbench.action.gotoLine', ':'],
    ['workbench.action.showCommands', ''],
    ['workbench.action.openRecent', ''],
  ])('子窗获焦时经菜单执行 %s → 画在子窗,焦点在子窗的输入框,Esc 在子窗关闭', async (id, query) => {
    const { win } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    render(<Harness />);
    menu(id, true);
    const dialog = await waitFor(() => {
      const d = dialogIn(win.document);
      expect(d).not.toBeNull();
      return d!;
    });
    expect(dialogIn(document)).toBeNull();
    await waitFor(() => expect(dialog.contains(win.document.activeElement)).toBe(true));
    expect((win.document.activeElement as HTMLInputElement).value).toBe(query);
    // 选择器画在子窗:不需要激活主窗
    expect(focusWindow).not.toHaveBeenCalled();
    fireEvent.keyDown(win.document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(dialogIn(win.document)).toBeNull());
  });

  it('主窗触发(fromPopout=false)→ 画在主窗', async () => {
    withPopout();
    render(<Harness />);
    menu('workbench.action.quickOpen', false);
    await waitFor(() => expect(dialogIn(document)).not.toBeNull());
  });

  it('热键:子窗里 ⌘P / ⇧⌘P / F1 / ⌃G 打开在子窗;同一窗口再按 ⌘P 关闭', async () => {
    const { win } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    render(<Harness />);
    const press = (init: KeyboardEventInit) => act(() => void fireEvent.keyDown(win.document.body, init));

    press({ key: 'p', ...mod });
    await waitFor(() => expect(dialogIn(win.document)).not.toBeNull());
    expect(useQuickOpenStore.getState().hostDocument).toBe(win.document);
    press({ key: 'p', ...mod });
    await waitFor(() => expect(dialogIn(win.document)).toBeNull());

    press({ key: 'P', shiftKey: true, ...mod });
    await waitFor(() => expect(useCommandPaletteStore.getState().isOpen).toBe(true));
    expect(useCommandPaletteStore.getState().hostDocument).toBe(win.document);
    act(() => useCommandPaletteStore.getState().close());

    press({ key: 'F1' });
    await waitFor(() => expect(useCommandPaletteStore.getState().isOpen).toBe(true));
    expect(useCommandPaletteStore.getState().hostDocument).toBe(win.document);
    act(() => useCommandPaletteStore.getState().close());

    press({ key: 'g', ctrlKey: true });
    await waitFor(() => expect(useQuickOpenStore.getState().isOpen).toBe(true));
    expect(useQuickOpenStore.getState().query).toBe(':');
    expect(useQuickOpenStore.getState().hostDocument).toBe(win.document);
    expect(dialogIn(document)).toBeNull();
  });

  it.runIf(isMac)('热键:子窗里 ⌃R(mac)打开最近在子窗', async () => {
    const { win } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    render(<Harness />);
    act(() => void fireEvent.keyDown(win.document.body, { key: 'r', ctrlKey: true }));
    await waitFor(() => expect(dialogIn(win.document)).not.toBeNull());
    expect(useOpenRecentStore.getState().hostDocument).toBe(win.document);
  });

  it('已在主窗开着,在子窗按 ⌘P → 移到子窗(不关闭)', async () => {
    const { win } = withPopout();
    render(<Harness />);
    menu('workbench.action.quickOpen', false);
    await waitFor(() => expect(dialogIn(document)).not.toBeNull());
    act(() => void fireEvent.keyDown(win.document.body, { key: 'p', ...mod }));
    await waitFor(() => expect(dialogIn(win.document)).not.toBeNull());
    expect(dialogIn(document)).toBeNull();
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
  });

  it('选择器所在子窗关闭 → 选择器关闭(不退回主窗)', async () => {
    const { win, popped } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    render(<Harness />);
    menu('workbench.action.showCommands', true);
    await waitFor(() => expect(dialogIn(win.document)).not.toBeNull());
    act(() => {
      (popped.group as unknown as { model: { location: unknown } }).model.location = { type: 'grid' };
    });
    await waitFor(() => expect(useCommandPaletteStore.getState().isOpen).toBe(false));
    expect(dialogIn(document)).toBeNull();
  });
});

describe('2. 在主窗打开面板 / 视图而焦点在子窗 → 激活主窗', () => {
  it('新建的面板落在主窗(⌘, / ⇧⌘F / 显示输出…)→ 请求激活主窗;主窗本就获焦 → 不请求', () => {
    const { api, win } = withPopout();
    const hasFocus = vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    openOrFocusPanelNow(api, 'settings', 'settings', 'Settings');
    expect(api.getPanel('settings')!.api.location.type).not.toBe('popout');
    expect(focusWindow).toHaveBeenCalledTimes(1);

    hasFocus.mockReturnValue(false);
    openOrFocusPanelNow(api, 'search', 'search', 'Search');
    expect(focusWindow).toHaveBeenCalledTimes(1);
  });

  it('已存在于主窗的面板被重新显示 → 激活主窗;面板在子窗 → 不激活主窗(聚焦子窗)', () => {
    const { api, win } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    const focusPopout = vi.spyOn(win, 'focus').mockImplementation(() => undefined);
    openOrFocusPanelNow(api, 'editor', 'editor', 'Editor');
    expect(focusWindow).toHaveBeenCalledTimes(1);
    openOrFocusPanelNow(api, 'popped', 'plugin', 'P');
    expect(focusWindow).toHaveBeenCalledTimes(1);
    expect(focusPopout).toHaveBeenCalled();
  });

  it('子窗「⋯」菜单在子窗组里新建 → 不激活主窗', () => {
    const { api, win, popped } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    openOrFocusPanelNow(api, 'output', 'output', 'Output', undefined, { referenceGroup: popped.group, direction: 'within' });
    expect(api.getPanel('output')!.api.location.type).toBe('popout');
    expect(focusWindow).not.toHaveBeenCalled();
  });

  it('用户新建的终端落在主窗 → 激活主窗', () => {
    const { api, win } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    reconcileTerminalPanels(api, {
      previousSessions: [],
      nextSessions: [{ id: 's1', title: 'zsh', originHint: 'user', createdAt: 1, status: 'running' } as never],
    } as never);
    expect(focusWindow).toHaveBeenCalledTimes(1);
  });

  it('agent 新建的终端(不抢焦点)→ 不激活主窗', () => {
    const { api, win } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    reconcileTerminalPanels(api, {
      previousSessions: [],
      nextSessions: [{ id: 's2', title: 'zsh', originHint: 'agent', createdAt: 1, status: 'running' } as never],
    } as never);
    expect(focusWindow).not.toHaveBeenCalled();
  });

  it('显示资源管理器(侧栏在主窗)→ 激活主窗', () => {
    const { win } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    showExplorer();
    expect(focusWindow).toHaveBeenCalledTimes(1);
  });

  it('选择器画在主窗而焦点在子窗 → 激活主窗', async () => {
    const { win } = withPopout();
    vi.spyOn(win.document, 'hasFocus').mockReturnValue(true);
    render(<Harness />);
    menu('workbench.action.quickOpen', false);
    await waitFor(() => expect(dialogIn(document)).not.toBeNull());
    expect(focusWindow).toHaveBeenCalledTimes(1);
  });
});
