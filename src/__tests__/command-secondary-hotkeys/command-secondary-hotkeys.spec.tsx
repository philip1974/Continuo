// @vitest-environment jsdom
// BDD: command-secondary-hotkeys —— 一个命令多个默认键(VSCode primary + secondary):都能触发、改键覆盖全部、显示取主键。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { coApp } from '@/plugins/co-app';
import { CommandRegistry, type CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import {
  isHotkeyShadowed,
  selectShadowedBindings,
  useCommandHotkeys,
  winningCommandFor,
} from '@/plugins/command-palette/useCommandHotkeys';
import { buildDisplayCommands } from '@/plugins/command-palette/CommandPalette';
import { resolveDisplayHotkey } from '@/plugins/picker/use-picker-toggle-hotkey';
import { commandHotkeyText } from '@/lib/hotkey-label';
import { selectKeybindingConflicts } from '@/plugins/keybindings/KeybindingCaptureModal';
import { buildKeybindingDisplayCommands, KeybindingsTabContent } from '@/plugins/settings/KeybindingsTabContent';

const tk = (_key: string | undefined, fallback: string) => fallback;

let originalCommands: CommandRegistry;
function useCommands(...specs: CommandSpec[]): CommandRegistry {
  const reg = new CommandRegistry('other');
  for (const s of specs) reg.register(s);
  (coApp as { commands: CommandRegistry }).commands = reg;
  return reg;
}
beforeEach(() => {
  originalCommands = coApp.commands;
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => {
  cleanup();
  (coApp as { commands: CommandRegistry }).commands = originalCommands;
  useKeybindingsStore.setState({ overrides: {} });
});

// jsdom detectPlatform()='other' → mod = Ctrl
function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(e);
  return e;
}

function nextEditor(fn: () => void = vi.fn()): CommandSpec {
  return { id: 'demo.next', title: 'Next', hotkey: 'mod+k', secondaryHotkeys: ['mod+j'], fn };
}

describe('分发:主键与附加默认键都触发', () => {
  it('主键 / 附加默认键各按一次 → 命令各执行一次', () => {
    const fn = vi.fn();
    const reg = useCommands(nextEditor(fn));
    renderHook(() => useCommandHotkeys(reg));
    keydown('k', { ctrlKey: true });
    keydown('j', { ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('面板 / 终端的裁决(winningCommandFor)同样认附加默认键', () => {
    const reg = useCommands(nextEditor());
    const e = new KeyboardEvent('keydown', { key: 'j', ctrlKey: true });
    expect(winningCommandFor(e, reg.getAll(), 'other', {})?.id).toBe('demo.next');
  });

  it('用户改键覆盖全部默认键;解绑全部失效;恢复默认后两键都回来', () => {
    const fn = vi.fn();
    const reg = useCommands(nextEditor(fn));
    renderHook(() => useCommandHotkeys(reg));

    act(() => useKeybindingsStore.getState().setHotkey('demo.next', 'mod+l'));
    keydown('k', { ctrlKey: true });
    keydown('j', { ctrlKey: true });
    expect(fn).not.toHaveBeenCalled();
    keydown('l', { ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(1);

    act(() => useKeybindingsStore.getState().setHotkey('demo.next', ''));
    keydown('l', { ctrlKey: true });
    keydown('j', { ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(1);

    act(() => useKeybindingsStore.getState().reset('demo.next'));
    keydown('k', { ctrlKey: true });
    keydown('j', { ctrlKey: true });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('显示所有命令(保留键 ⇧⌘P 归 picker)的附加默认键 F1 进命令分发;显示仍是 ⇧⌘P', () => {
    const fn = vi.fn();
    const reg = useCommands({
      id: 'workbench.action.showCommands',
      title: 'Show All Commands',
      secondaryHotkeys: ['f1'],
      fn,
    });
    renderHook(() => useCommandHotkeys(reg));
    keydown('F1', { code: 'F1' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(resolveDisplayHotkey(reg.get('workbench.action.showCommands')!, {}, 'other')).toBe('mod+shift+p');
  });
});

describe('注册校验', () => {
  it('附加默认键须是形态合法的字符串数组', () => {
    const reg = new CommandRegistry('other');
    const bad = [
      { secondaryHotkeys: 'mod+j' },
      { secondaryHotkeys: ['mod++j'] },
      { secondaryHotkeys: [42] },
      { secondaryHotkeys: Array.from({ length: 9 }, (_, i) => `mod+${i}`) },
    ];
    for (const extra of bad) {
      expect(() => reg.register({ id: 'x', title: 'X', fn: () => {}, ...(extra as object) })).toThrow();
    }
  });

  it('附加默认键与别的命令默认键相同 → 注册告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new CommandRegistry('other');
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+j', fn: () => {} });
    reg.register(nextEditor());
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mod+j'));
    warn.mockRestore();
  });
});

describe('冲突与显示', () => {
  const OTHER: CommandSpec = { id: 'demo.other', title: 'Other', hotkey: 'mod+j', fn: () => {} };

  it('附加默认键落败 → 设置页标冲突,但主键照常显示', () => {
    const commands = [OTHER, nextEditor()];
    expect(selectShadowedBindings(commands, 'other', {}).get('demo.next')?.id).toBe('demo.other');
    expect(isHotkeyShadowed('demo.next', commands, 'other', {})).toBe(false);
    const [, next] = buildDisplayCommands(commands, tk, 'other', {});
    expect(next!.hotkeyParts).toEqual(['Ctrl', 'K']);
  });

  it('主键落败 → 主键不显示', () => {
    const commands = [{ ...OTHER, hotkey: 'mod+k' }, nextEditor()];
    expect(isHotkeyShadowed('demo.next', commands, 'other', {})).toBe(true);
  });

  it('命令面板 / tooltip 只显示主键', () => {
    useCommands(nextEditor());
    const [next] = buildDisplayCommands(coApp.commands.getAll(), tk, 'other', {});
    expect(next!.hotkeyParts).toEqual(['Ctrl', 'K']);
    expect(commandHotkeyText(coApp.commands.get('demo.next'))).toBe('Ctrl+K');
  });

  it('录键弹窗:别的命令的附加默认键与录到的键相同 → 列为冲突', () => {
    const conflicts = selectKeybindingConflicts([nextEditor()], 'demo.other', 'mod+j');
    expect(conflicts.map((c) => c.id)).toEqual(['demo.next']);
  });

  it('录键弹窗:保留键命令的附加默认键(F1)同样算冲突', () => {
    const show: CommandSpec = { id: 'workbench.action.showCommands', title: 'S', secondaryHotkeys: ['f1'], fn: () => {} };
    expect(selectKeybindingConflicts([show], 'demo.other', 'f1').map((c) => c.id)).toEqual([show.id]);
  });
});

describe('快捷键设置页', () => {
  it('行内显示全部默认键(主键在前);改键后只剩新键', () => {
    const [d] = buildKeybindingDisplayCommands([nextEditor()], tk, {}, 'other');
    expect(d!.hotkeyParts).toEqual(['Ctrl', 'K']);
    expect(d!.secondaryHotkeyParts).toEqual([['Ctrl', 'J']]);
    const [o] = buildKeybindingDisplayCommands([nextEditor()], tk, { 'demo.next': 'mod+l' }, 'other');
    expect(o!.hotkeyParts).toEqual(['Ctrl', 'L']);
    expect(o!.secondaryHotkeyParts).toBeUndefined();
  });

  it('按附加默认键搜索也能找到该命令', () => {
    useCommands(nextEditor(), { id: 'demo.unrelated', title: 'Unrelated', fn: () => {} });
    render(<KeybindingsTabContent />);
    const input = screen.getAllByRole('textbox')[0]!;
    fireEvent.change(input, { target: { value: 'ctrl+j' } });
    expect(screen.queryByText('Next')).not.toBeNull();
    expect(screen.queryByText('Unrelated')).toBeNull();
    const keys = screen.getByText('Next').closest('li')!.querySelector('[data-testid="keybinding-keys"]')!;
    expect(keys.textContent).toContain('J');
    expect(keys.textContent).toContain('K');
  });
});
