// @vitest-environment jsdom
// BDD: workbench-editor-commands / 5 popout 子窗里的 ⌘W 与下一个 / 上一个编辑器
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { POPOUT_HOTKEY_COMMAND_IDS, useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { trackPopoutDocuments } from '../../shell/dock/popout-documents';
import {
  CLOSE_ACTIVE_EDITOR_COMMAND,
  NEXT_EDITOR_COMMAND_ID,
  PREVIOUS_EDITOR_COMMAND_ID,
  REOPEN_CLOSED_EDITOR_COMMAND,
  SAVE_COMMAND,
} from '../../panels/Editor/editor-commands';

function popoutDocument(): Document {
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  return frame.contentDocument!;
}

function trackAsPopout(doc: Document) {
  const noop = { dispose: () => {} };
  const group = { api: { location: { type: 'popout', getWindow: () => ({ document: doc }) }, onDidLocationChange: () => noop } };
  return trackPopoutDocuments({ groups: [group], onDidAddGroup: () => noop, onDidRemoveGroup: () => noop } as never);
}

// jsdom detectPlatform() = 'other' → mod = Ctrl
function press(target: Document | Element, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(ev);
  return ev;
}

function registry() {
  const reg = new CommandRegistry();
  const close = vi.fn();
  const next = vi.fn();
  const save = vi.fn();
  const newTerminal = vi.fn();
  reg.register({ ...CLOSE_ACTIVE_EDITOR_COMMAND, title: 'Close Editor', fn: close });
  reg.register({ id: NEXT_EDITOR_COMMAND_ID, title: 'Next', hotkey: 'ctrl+pagedown', fn: next });
  reg.register({ ...SAVE_COMMAND, title: 'Save', fn: save });
  reg.register({ id: 'terminal.new', title: 'New Terminal', hotkey: 'mod+t', fn: newTerminal });
  return { reg, close, next, save, newTerminal };
}

beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => {
  cleanup();
  for (const frame of document.querySelectorAll('iframe')) frame.remove();
});

describe('popout 子窗按键分发(只限作用于活动面板的命令)', () => {
  it('白名单:关闭编辑器、重新打开已关闭的编辑器、⌃Tab / ⌃⇧Tab、⌃` 切换终端、后退 / 前进、切换自动换行、放大 / 缩小 / 重置缩放(都只作用于该子窗或不画在主窗;下一个 / 上一个编辑器由编辑器面板自己处理,编辑器不在该子窗时不切主窗编辑器)', () => {
    expect([...POPOUT_HOTKEY_COMMAND_IDS]).toEqual([
      CLOSE_ACTIVE_EDITOR_COMMAND.id,
      REOPEN_CLOSED_EDITOR_COMMAND.id,
      // ⌘N 新建的无标题文件落在该子窗的编辑器组(editor-save-as)
      'workbench.action.files.newUntitledFile',
      'workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup',
      'workbench.action.quickOpenLeastRecentlyUsedEditorInGroup',
      'workbench.action.terminal.toggleTerminal',
      'workbench.action.navigateBack',
      'workbench.action.navigateForward',
      // 切换自动换行只翻转设置(workbench-missing-commands)
      'editor.action.toggleWordWrap',
      // 放大 / 缩小 / 重置缩放:只改设置 window.zoomLevel(所有窗口统一,见 window-zoom)
      'workbench.action.zoomIn',
      'workbench.action.zoomOut',
      'workbench.action.zoomReset',
      // 选择器画在按键所在子窗(popout-picker)
      'workbench.action.gotoLine',
      'workbench.action.openRecent',
      'workbench.action.showCommands',
      // 颜色主题选择器画在按键所在子窗;切换浅深只改设置(theme-commands)
      'workbench.action.selectTheme',
      'workbench.action.toggleLightDarkThemes',
      // F6 / ⇧F6 在按键所在子窗自己的区域间循环(keyboard-focus-parity 第 6 条)
      'workbench.action.focusNextPart',
      'workbench.action.focusPreviousPart',
    ]);
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(NEXT_EDITOR_COMMAND_ID)).toBe(false);
    expect(POPOUT_HOTKEY_COMMAND_IDS.has(PREVIOUS_EDITOR_COMMAND_ID)).toBe(false);
  });

  it('popout 子窗里按关闭编辑器的生效绑定 → 执行同一命令并截住事件', async () => {
    const popDoc = popoutDocument();
    const tracker = trackAsPopout(popDoc);
    const { reg, close, next } = registry();
    renderHook(() => useCommandHotkeys(reg));
    const ev = press(popDoc.body, { key: 'w', ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(close).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
    // 下一个编辑器不经子窗全局分发(由编辑器面板自己处理,只作用于本编辑器)
    press(popDoc.body, { key: 'PageDown', ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(next).not.toHaveBeenCalled();
    tracker.dispose();
  });

  it('其它命令(保存 / 新终端…)在 popout 子窗不经全局分发(效果画在主窗会抢焦点;保存由编辑器面板自己处理)', async () => {
    const popDoc = popoutDocument();
    const tracker = trackAsPopout(popDoc);
    const { reg, save, newTerminal } = registry();
    renderHook(() => useCommandHotkeys(reg));
    const ev = press(popDoc.body, { key: 's', ctrlKey: true });
    press(popDoc.body, { key: 't', ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(save).not.toHaveBeenCalled();
    expect(newTerminal).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    tracker.dispose();
  });

  it('改绑跟随生效绑定:原默认键不再触发,新键触发', async () => {
    useKeybindingsStore.setState({ overrides: { [CLOSE_ACTIVE_EDITOR_COMMAND.id]: 'mod+shift+x' } });
    const popDoc = popoutDocument();
    const tracker = trackAsPopout(popDoc);
    const { reg, close } = registry();
    renderHook(() => useCommandHotkeys(reg));
    press(popDoc.body, { key: 'w', ctrlKey: true });
    press(popDoc.body, { key: 'x', ctrlKey: true, shiftKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(close).toHaveBeenCalledTimes(1);
    tracker.dispose();
  });

  it('与主窗同一张表裁决:别的命令经用户改绑占了关闭编辑器的键 → 子窗该键不关 tab、也不执行该命令', async () => {
    // 用户把「新终端」绑到 mod+w:快捷键页标关闭编辑器落败、主窗执行新终端;子窗不得先滤出关闭编辑器再匹配。
    useKeybindingsStore.setState({ overrides: { 'terminal.new': 'mod+w' } });
    const popDoc = popoutDocument();
    const tracker = trackAsPopout(popDoc);
    const { reg, close, newTerminal } = registry();
    renderHook(() => useCommandHotkeys(reg));
    const ev = press(popDoc.body, { key: 'w', ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(close).not.toHaveBeenCalled();
    expect(newTerminal).not.toHaveBeenCalled(); // 胜者不在子窗白名单 → 子窗不分发(效果画在主窗)
    expect(ev.defaultPrevented).toBe(false);
    tracker.dispose();
  });

  it('子窗关闭(文档不再是 popout)→ 移除监听;卸载 hook 同样移除', async () => {
    const popDoc = popoutDocument();
    const tracker = trackAsPopout(popDoc);
    const { reg, close } = registry();
    const remove = vi.spyOn(popDoc, 'removeEventListener');
    const hook = renderHook(() => useCommandHotkeys(reg));
    act(() => tracker.dispose());
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function));
    press(popDoc.body, { key: 'w', ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(close).not.toHaveBeenCalled();

    const popDoc2 = popoutDocument();
    const remove2 = vi.spyOn(popDoc2, 'removeEventListener');
    let tracker2!: { dispose: () => void };
    act(() => { tracker2 = trackAsPopout(popDoc2); });
    hook.unmount();
    expect(remove2).toHaveBeenCalledWith('keydown', expect.any(Function));
    tracker2.dispose();
  });

  it('主窗分发不变:主窗 document 的按键照常匹配全部命令', async () => {
    const { reg, save } = registry();
    renderHook(() => useCommandHotkeys(reg));
    press(document.body, { key: 's', ctrlKey: true });
    await act(async () => { await Promise.resolve(); });
    expect(save).toHaveBeenCalledTimes(1);
  });
});
