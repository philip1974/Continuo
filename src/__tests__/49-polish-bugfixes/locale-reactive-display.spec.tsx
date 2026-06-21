// @vitest-environment jsdom
// 打磨 R31(codex 一致性/i18n):CommandPalette / KeybindingsTabContent 的本地化
// displayCommands memo 之前 deps 只有 [..., tk](useTWithFallback 返回函数 identity
// 稳定),切语言只重渲不重算 memo → 标题停留旧语言。加 useLocale() 失效键后,
// 切语言立即重算显示文案。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ index: i, start: i * 30, size: 30, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));
import { render, cleanup, act } from '@testing-library/react';
import { setLocale, notifyLocaleChange } from '../../i18n';

import { CommandPalette } from '../../plugins/command-palette/CommandPalette';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { KeybindingsTabContent } from '../../plugins/settings/KeybindingsTabContent';
import { coApp } from '../../plugins/co-app';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';

// 'settings.terminal.font_size' → en 'Font size' / zh '字号'(真实 catalog key)
const KEY = 'settings.terminal.font_size';

beforeEach(() => {
  setLocale('en');
  useCommandPaletteStore.setState({ isOpen: false, query: '', selectedIndex: 0 });
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => {
  setLocale('en');
  notifyLocaleChange();
  cleanup();
});

describe('打磨 R31 — 切语言后命令显示文案立即更新', () => {
  it('CommandPalette displayTitle 随 locale 重算', () => {
    const reg = new CommandRegistry();
    reg.register({ id: 'x', title: 'RAW', titleKey: KEY, hotkey: 'mod+x', fn: vi.fn() });
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    expect(document.body.textContent).toContain('Font size');

    act(() => {
      setLocale('zh');
      notifyLocaleChange();
    });
    expect(document.body.textContent).toContain('字号');
    expect(document.body.textContent).not.toContain('Font size');
  });

  it('KeybindingsTabContent displayTitle 随 locale 重算', () => {
    (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
    coApp.commands.register({
      id: 'y',
      title: 'RAW',
      titleKey: KEY,
      hotkey: 'mod+y',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    expect(container.textContent).toContain('Font size');

    act(() => {
      setLocale('zh');
      notifyLocaleChange();
    });
    expect(container.textContent).toContain('字号');
    expect(container.textContent).not.toContain('Font size');
  });
});
