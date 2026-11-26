// @vitest-environment jsdom
// BDD: shadowed-hotkey-display —— 冲突落败(按下执行别的命令)的键位不在命令面板 / tooltip / 菜单 / 提示文案里显示。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { coApp } from '@/plugins/co-app';
import { CommandRegistry, type CommandSpec } from '@/plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { buildDisplayCommands } from '@/plugins/command-palette/CommandPalette';
import { selectShadowedBindings } from '@/plugins/command-palette/useCommandHotkeys';
import { commandHotkeyText } from '@/lib/hotkey-label';
import { saveHotkeyLabel } from '@/panels/Editor/editor-commands';
import { IconSidebar } from '@/shell/IconSidebar';
import { setLocale } from '@/i18n';

const noop = () => {};
const tk = (_key: string | undefined, fallback: string) => fallback;
const SIDEBAR: CommandSpec = { id: 'explorer.toggleSidebar', title: 'Toggle Sidebar', hotkey: 'mod+b', fn: noop };
const PLUGIN: CommandSpec = { id: 'demo.plugin.bold', title: 'Plugin Bold', hotkey: 'mod+b', fn: noop };
const SAVE: CommandSpec = { id: 'workbench.action.files.save', title: 'Save', hotkey: 'mod+s', fn: noop };
const OTHER: CommandSpec = { id: 'demo.plugin.other', title: 'Other', fn: noop };

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
  setLocale('en');
});

describe('命令面板', () => {
  it('插件命令默认键与核心命令冲突(核心先注册)→ 插件行不显示键位,胜出的核心命令照常显示', () => {
    const commands = [SIDEBAR, PLUGIN];
    expect(selectShadowedBindings(commands, 'mac', {}).get(PLUGIN.id)?.id).toBe(SIDEBAR.id); // 设置页标冲突的同一判定
    const [sidebar, plugin] = buildDisplayCommands(commands, tk, 'mac', {});
    expect(sidebar!.hotkeyParts).toEqual(['⌘', 'B']);
    expect(plugin!.hotkeyParts).toEqual([]);
  });

  it('用户把插件命令改绑到同键(用户层胜出)→ 插件行显示,核心命令行不显示;改走后核心恢复', () => {
    const commands = [SIDEBAR, { ...PLUGIN, hotkey: undefined }];
    const [s1, p1] = buildDisplayCommands(commands, tk, 'mac', { [PLUGIN.id]: 'mod+b' });
    expect(s1!.hotkeyParts).toEqual([]);
    expect(p1!.hotkeyParts).toEqual(['⌘', 'B']);
    const [s2, p2] = buildDisplayCommands(commands, tk, 'mac', { [PLUGIN.id]: 'mod+shift+b' });
    expect(s2!.hotkeyParts).toEqual(['⌘', 'B']);
    expect(p2!.hotkeyParts).toEqual(['⇧', '⌘', 'B']);
  });
});

describe('tooltip / 菜单键位(hotkey-label)', () => {
  it('commandHotkeyText:落败 → undefined;无冲突照常', () => {
    const commands = [SIDEBAR, PLUGIN];
    expect(commandHotkeyText(PLUGIN, {}, 'mac', commands)).toBeUndefined();
    expect(commandHotkeyText(SIDEBAR, {}, 'mac', commands)).toBe('⌘B');
    expect(commandHotkeyText(PLUGIN, {}, 'mac', [PLUGIN])).toBe('⌘B');
  });

  it('缺省命令表 = 全局命令注册表', () => {
    useCommands(SIDEBAR, PLUGIN);
    expect(commandHotkeyText(PLUGIN, {}, 'mac')).toBeUndefined();
    expect(commandHotkeyText(SIDEBAR, {}, 'mac')).toBe('⌘B');
  });

  it('活动栏 tooltip:用户把插件命令改绑到侧栏键 → 「资源管理器」tooltip 不再带该键;冲突解除后恢复', () => {
    setLocale('en');
    useCommands(SIDEBAR, OTHER);
    render(<IconSidebar />);
    const explorerTooltip = () =>
      Array.from(document.querySelectorAll('[data-tooltip], [title]'))
        .map((el) => el.getAttribute('data-tooltip') ?? el.getAttribute('title') ?? '')
        .find((s) => /explorer/i.test(s));
    expect(explorerTooltip()).toMatch(/\(Ctrl\+B\)/);
    act(() => useKeybindingsStore.setState({ overrides: { [OTHER.id]: 'mod+b' } }));
    expect(explorerTooltip()).toBeDefined();
    expect(explorerTooltip()).not.toMatch(/Ctrl\+B/);
    act(() => useKeybindingsStore.setState({ overrides: {} }));
    expect(explorerTooltip()).toMatch(/\(Ctrl\+B\)/);
  });
});

describe('提示文案里的保存键', () => {
  it('saveHotkeyLabel:保存键被别的命令(用户改绑)抢走 → 退回命令标题', () => {
    useCommands(SAVE, OTHER);
    expect(saveHotkeyLabel('mac')).toBe('⌘S');
    useKeybindingsStore.setState({ overrides: { [OTHER.id]: 'mod+s' } });
    expect(saveHotkeyLabel('mac')).not.toBe('⌘S');
  });
});
