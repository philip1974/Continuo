// @vitest-environment jsdom
// BDD: hotkey-ime-composition —— 输入法组字中的按键不触发工作台快捷键(对齐 VSCode KEY_IN_COMPOSITION)。见同目录 README。
// jsdom detectPlatform() = 'other' → mod = Ctrl。
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCommandHotkeys } from '../../plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { useQuickOpenHotkey } from '../../plugins/quick-open/useQuickOpenHotkey';

vi.mock('../../plugins/settings/values-store', () => ({
  useSettingValue: <T,>(_id: string, fallback: T) => fallback,
}));

function press(target: Document | Element, init: KeyboardEventInit): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    target.dispatchEvent(ev);
  });
  return ev;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => {
  cleanup();
  act(() => useQuickOpenStore.getState().close());
});

describe('全局命令分发:组字中不执行、不 preventDefault', () => {
  function workbench() {
    const reg = new CommandRegistry();
    const escape = vi.fn();
    const save = vi.fn();
    const f6 = vi.fn();
    reg.register({ id: 'test.escape', title: 'Escape', hotkey: 'escape', fn: escape });
    reg.register({ id: 'test.save', title: 'Save', hotkey: 'mod+s', fn: save });
    reg.register({ id: 'test.f6', title: 'F6', hotkey: 'f6', fn: f6 });
    renderHook(() => useCommandHotkeys(reg));
    return { escape, save, f6 };
  }

  it('isComposing / keyCode 229 的 Esc、F6、⌘S 都不执行命令,事件不被取消;组字结束后照常', async () => {
    const { escape, save, f6 } = workbench();
    const evs = [
      press(document.body, { key: 'Escape', code: 'Escape', keyCode: 229, isComposing: true }),
      press(document.body, { key: 'Escape', code: 'Escape', keyCode: 229 }),
      press(document.body, { key: 'F6', code: 'F6', keyCode: 229, isComposing: true }),
      press(document.body, { key: 's', code: 'KeyS', ctrlKey: true, keyCode: 229, isComposing: true }),
    ];
    await flush();
    expect(escape).not.toHaveBeenCalled();
    expect(f6).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    for (const ev of evs) expect(ev.defaultPrevented).toBe(false);

    press(document.body, { key: 'Escape', code: 'Escape', keyCode: 27 });
    press(document.body, { key: 's', code: 'KeyS', ctrlKey: true, keyCode: 83 });
    await flush();
    expect(escape).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('Quick Open 开关键:组字中不打开', () => {
  it('组字中按 Ctrl+P 不打开 Quick Open;组字结束后照常', () => {
    render(<QuickOpenHost />);
    const ev = press(document.body, { key: 'p', code: 'KeyP', ctrlKey: true, keyCode: 229, isComposing: true });
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    expect(ev.defaultPrevented).toBe(false);
    press(document.body, { key: 'p', code: 'KeyP', ctrlKey: true, keyCode: 80 });
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
  });
});

function QuickOpenHost() {
  useQuickOpenHotkey();
  return null;
}
