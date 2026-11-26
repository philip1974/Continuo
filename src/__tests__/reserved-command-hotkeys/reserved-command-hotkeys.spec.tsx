// @vitest-environment jsdom
// BDD: reserved-command-hotkeys —— 「转到文件…」/「显示所有命令」显示保留键 ⌘P / ⇧⌘P(命令面板、tooltip、快捷键设置页标「保留键，
// 不可更改」),但不进命令分发;新增 workbench.action.showCommands。见同目录 README。
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getLocale, notifyLocaleChange, setLocale, t, type Locale } from '@/i18n';
import { coApp } from '@/plugins/co-app';
import { CommandRegistry, type CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { buildCompiledBindings } from '@/plugins/command-palette/useCommandHotkeys';
import { buildDisplayCommands } from '@/plugins/command-palette/CommandPalette';
import { detectPlatform, formatHotkey, formatHotkeyParts } from '@/plugins/command-palette/format-hotkey';
import { commandHotkeyText } from '@/lib/hotkey-label';
import { selectKeybindingConflicts } from '@/plugins/keybindings/KeybindingCaptureModal';
import {
  KeybindingsTabContent,
  buildKeybindingDisplayCommands,
  selectVisibleKeybindingCommands,
} from '@/plugins/settings/KeybindingsTabContent';
import { PICKER_TOGGLE_HOTKEYS, resolveActiveHotkey } from '@/plugins/picker/use-picker-toggle-hotkey';
import { windowCommandSpecs } from '@/shell/window-commands';
import { useCommandPaletteStore } from '@/plugins/command-palette/store';
import { useQuickOpenStore } from '@/plugins/quick-open/store';
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

const QUICK_OPEN = 'workbench.action.quickOpen';
const SHOW_COMMANDS = 'workbench.action.showCommands';
const PLATFORM = detectPlatform();
const tk = (key: string | undefined, fallback: string) => (key ? t(key as never) : fallback);

function spec(id: string): CommandSpec {
  const found = windowCommandSpecs().find((s) => s.id === id);
  expect(found, id).toBeDefined();
  return found!;
}

let original: Locale;
beforeEach(() => {
  original = getLocale();
  act(() => {
    setLocale('zh');
    notifyLocaleChange();
  });
  (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => {
  cleanup();
  act(() => {
    setLocale(original);
    notifyLocaleChange();
  });
});

describe('显示所有命令', () => {
  it('注册 workbench.action.showCommands:三语标题、无分类、无默认键', () => {
    const s = spec(SHOW_COMMANDS);
    expect(s.hotkey).toBeUndefined();
    expect(s.category).toBeUndefined();
    const key = s.titleKey as keyof typeof en;
    expect(en[key]).toBe('Show All Commands');
    expect(zh[key]).toBe('显示所有命令');
    expect(ko[key]).toBe('모든 명령 표시');
  });

  it('执行 = 打开命令面板并关闭 Quick Open', async () => {
    useQuickOpenStore.getState().open();
    useCommandPaletteStore.getState().close();
    await spec(SHOW_COMMANDS).fn();
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
    expect(useQuickOpenStore.getState().isOpen).toBe(false);
    useCommandPaletteStore.getState().close();
  });
});

describe('显示保留键', () => {
  it('命令面板列表:转到文件… ⌘P、显示所有命令 ⇧⌘P(旧 override 不影响)', () => {
    const overrides = { [QUICK_OPEN]: 'mod+k' };
    const [qo, sc] = buildDisplayCommands([spec(QUICK_OPEN), spec(SHOW_COMMANDS)], tk, 'mac', overrides);
    expect(qo!.hotkeyParts).toEqual(formatHotkeyParts(PICKER_TOGGLE_HOTKEYS.quick_open, 'mac'));
    expect(sc!.hotkeyParts).toEqual(formatHotkeyParts(PICKER_TOGGLE_HOTKEYS.command_palette, 'mac'));
  });

  it('tooltip 键位文案', () => {
    expect(commandHotkeyText(spec(QUICK_OPEN), {}, 'mac')).toBe(formatHotkey('mod+p', 'mac'));
    expect(commandHotkeyText(spec(SHOW_COMMANDS), {}, 'other')).toBe(formatHotkey('mod+shift+p', 'other'));
  });
});

describe('不参与命令分发', () => {
  it('两条命令不进热键表,存有旧 override 也不响应', () => {
    const overrides = { [QUICK_OPEN]: 'mod+k', [SHOW_COMMANDS]: 'mod+j' };
    expect(buildCompiledBindings([spec(QUICK_OPEN), spec(SHOW_COMMANDS)], 'mac', overrides)).toEqual([]);
    expect(resolveActiveHotkey(spec(QUICK_OPEN), overrides, 'mac')).toBeUndefined();
  });

  it('旧 override 不作为改键冲突项列出', () => {
    const other: CommandSpec = { id: 'x.other', title: 'Other', fn: () => {} };
    const conflicts = selectKeybindingConflicts([spec(QUICK_OPEN), other], other.id, 'mod+k', { [QUICK_OPEN]: 'mod+k' });
    expect(conflicts).toEqual([]);
  });
});

describe('快捷键设置页', () => {
  it('行显示保留键键帽 +「保留键，不可更改」,编辑按钮禁用', () => {
    coApp.commands.register(spec(QUICK_OPEN));
    coApp.commands.register(spec(SHOW_COMMANDS));
    render(<KeybindingsTabContent />);
    for (const [id, combo] of [
      [QUICK_OPEN, PICKER_TOGGLE_HOTKEYS.quick_open],
      [SHOW_COMMANDS, PICKER_TOGGLE_HOTKEYS.command_palette],
    ] as const) {
      const edit = document.querySelector<HTMLButtonElement>(`[data-keybinding-edit="${id}"]`)!;
      const row = edit.closest('li')!;
      expect(within(row).getByTestId('keybinding-keys').textContent).toBe(formatHotkeyParts(combo, PLATFORM).join(''));
      expect(within(row).getByText(t('keybindings.reserved_fixed'))).toBeTruthy();
      expect(within(row).queryByText(t('keybindings.unbound'))).toBeNull();
      expect(within(row).queryByText(t('keybindings.reserved_inactive'))).toBeNull();
      expect(edit.disabled).toBe(true);
    }
    expect(screen.getByText(t('keybindings.summary', { total: 2, bound: 2 }))).toBeTruthy();
  });

  it('按快捷键搜索能找到(ctrl+p / cmd+p)', () => {
    const [d] = buildKeybindingDisplayCommands([spec(QUICK_OPEN)], tk, {}, 'mac');
    expect(d!.effectiveHotkey).toBe('mod+p');
    expect(d!.fixed).toBe(true);
    expect(d!.reserved).toBe(false);
    expect(selectVisibleKeybindingCommands([d!], 'cmd+p', 'mac')).toHaveLength(1);
    expect(selectVisibleKeybindingCommands([d!], '"cmd+shift+p"', 'mac')).toHaveLength(0);
  });

  it('「保留键，不可更改」三语', () => {
    expect(en['keybindings.reserved_fixed']).toBe('Reserved — cannot be changed');
    expect(zh['keybindings.reserved_fixed']).toBe('保留键，不可更改');
    expect(ko['keybindings.reserved_fixed']).toBe('예약된 키, 변경할 수 없음');
  });
});
