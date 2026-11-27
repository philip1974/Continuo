// @vitest-environment jsdom
// 设置页窄宽下被省略号截断的 id 文本悬停可看全文(title);快捷键页「或 ⇧⌘P …」提示按整句模板渲染,
// 键帽与 ko 助词之间不插空格。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, cleanup } from '@testing-library/react';
import { SettingItemRow } from '../../plugins/settings/SettingItemRow';
import { KeybindingsTabContent } from '../../plugins/settings/KeybindingsTabContent';
import { PluginsTabContent } from '../../plugins/settings/PluginsTabContent';
import type { SettingItemSpec } from '../../plugins/registries/SettingItemRegistry';
import { useSettingsValuesStore } from '../../plugins/settings/values-store';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { coApp } from '../../plugins/co-app';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { getLocale, setLocale } from '../../i18n';
import { notifyLocaleChange } from '../../i18n/react';

const initialLocale = getLocale();
afterEach(() => {
  cleanup();
  act(() => {
    setLocale(initialLocale);
    notifyLocaleChange();
  });
});

describe('截断的 id 文本带 title', () => {
  const originalCommands = coApp.commands;
  beforeEach(() => {
    (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
    useKeybindingsStore.setState({ overrides: {} });
    useSettingsValuesStore.setState({ values: {} });
  });
  afterEach(() => {
    (coApp as { commands: CommandRegistry }).commands = originalCommands;
  });

  it('快捷键页命令 id 徽标:title = 完整命令 id', () => {
    const id = 'workbench.action.some.really.long.command.identifier';
    coApp.commands.register({ id, title: 'Long', hotkey: 'mod+alt+l', category: 'X', fn: vi.fn() });
    const { container } = render(<KeybindingsTabContent />);
    const code = container.querySelector(`li[data-keybinding-row="${id}"] code`)!;
    expect(code.textContent).toBe(id);
    expect(code.getAttribute('title')).toBe(id);
  });

  it('插件页内置插件 id 与贡献点示例列:title = 全文', () => {
    const { container } = render(<PluginsTabContent />);
    const codes = container.querySelectorAll('[data-plugins-section="builtin"] code');
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) expect(c.getAttribute('title')).toBe(c.textContent);
    const rows = container.querySelectorAll('[data-plugins-section="contributions"] .rounded-md > div');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const samples = row.lastElementChild!;
      expect(samples.getAttribute('title')).toBe(samples.textContent);
    }
  });

  it('设置项 id 徽标:title = 完整设置 id', () => {
    const spec: SettingItemSpec = {
      id: 'editor.some.very.long.setting.identifier',
      category: 'editor',
      title: 'Long setting',
      type: 'boolean',
      default: false,
    };
    const { container } = render(<SettingItemRow spec={spec} />);
    const code = container.querySelector('code')!;
    expect(code.getAttribute('title')).toBe(spec.id);
  });
});

describe('快捷键页命令面板提示:整句模板', () => {
  const originalCommands = coApp.commands;
  beforeEach(() => {
    (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
    coApp.commands.register({ id: 'a', title: 'A', hotkey: 'mod+a', fn: vi.fn() });
  });
  afterEach(() => {
    (coApp as { commands: CommandRegistry }).commands = originalCommands;
  });

  const hintParts = (locale: 'en' | 'zh' | 'ko') => {
    act(() => {
      setLocale(locale);
      notifyLocaleChange();
    });
    const { container } = render(<KeybindingsTabContent />);
    const hint = container.querySelector('[data-testid="keybindings-palette-hint"]')!;
    const keys = hint.querySelector('[data-testid="keybindings-palette-keys"]')!;
    // 键帽组前后的文字是同一个 inline 元素里的文本节点(不是 flex 项,不被 gap 插入间距)
    const before = keys.previousSibling?.textContent ?? '';
    const after = keys.nextSibling?.textContent ?? '';
    cleanup();
    return { before, after, keysInHint: hint.contains(keys) };
  };

  it('ko:助词「로」紧贴键帽,前面没有空格', () => {
    const { before, after, keysInHint } = hintParts('ko');
    expect(keysInHint).toBe(true);
    expect(before).toBe('또는 ');
    expect(after.startsWith('로')).toBe(true);
  });

  it('en / zh:键帽前后各一个空格', () => {
    for (const locale of ['en', 'zh'] as const) {
      const { before, after } = hintParts(locale);
      expect(before.endsWith(' ')).toBe(true);
      expect(after.startsWith(' ')).toBe(true);
    }
  });
});
