// @vitest-environment jsdom
// BDD: entry-discoverability 第 1 / 7 条 —— 活动栏「搜索」「运行和调试」、设置搜索框旁「筛选设置」菜单、状态栏「侧栏已隐藏」可点。
// jsdom 平台非 mac:键位按 Windows / Linux 格式。见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/toggle-settings-panel', () => ({ toggleSettingsPanel: vi.fn() }));

import { coApp } from '@/plugins/co-app';
import { CommandRegistry } from '@/plugins/registries/CommandRegistry';
import { RibbonRegistry } from '@/plugins/registries/RibbonRegistry';
import { SettingTabRegistry } from '@/plugins/registries/SettingTabRegistry';
import { SettingItemRegistry } from '@/plugins/registries/SettingItemRegistry';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { setLocale, t } from '@/i18n';
import { IconSidebar } from '@/shell/IconSidebar';
import { StatusBar } from '@/shell/StatusBar';
import {
  SettingsPanel,
  appendSettingsQueryTag,
  hasSettingsQueryTag,
  toggleSettingsQueryTag,
} from '@/plugins/settings/SettingsPanel';
import { useSettingsStore } from '@/plugins/settings/store';
import { useSettingsValuesStore } from '@/plugins/settings/values-store';
import { EDITOR_FONT_SIZE, TERMINAL_FONT_SIZE } from '@/plugins/settings/core-setting-specs';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import { _resetLmApiForTest, captureLmApi } from '@/lib/co-api';

const ran: string[] = [];

function registerCommands(): void {
  const commands = new CommandRegistry('other');
  for (const [id, hotkey] of [
    ['explorer.toggleSidebar', 'mod+b'],
    ['settings.toggle', 'mod+,'],
    ['workbench.action.findInFiles', 'mod+shift+f'],
    ['workbench.view.debug', 'mod+shift+d'],
  ] as const) {
    commands.register({ id, title: id, hotkey, fn: () => void ran.push(id) });
  }
  (coApp as { commands: CommandRegistry }).commands = commands;
}

let originalCommands: CommandRegistry;
let originalRibbon: RibbonRegistry;
beforeEach(() => {
  setLocale('zh');
  ran.length = 0;
  originalCommands = coApp.commands;
  originalRibbon = coApp.ribbon;
  (coApp as { ribbon: RibbonRegistry }).ribbon = new RibbonRegistry();
  registerCommands();
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => {
  cleanup();
  (coApp as { commands: CommandRegistry }).commands = originalCommands;
  (coApp as { ribbon: RibbonRegistry }).ribbon = originalRibbon;
  useKeybindingsStore.setState({ overrides: {} });
  setLocale('en');
});

const flush = () => act(async () => {});

describe('活动栏:资源管理器 / 搜索 / 运行和调试(VSCode 活动栏默认顺序,本项目有的视图)', () => {
  it('顺序 资源管理器、搜索、运行和调试 在设置之前;tooltip「名称 (键位)」随改键;点击执行对应命令', async () => {
    useLayoutUiStore.setState({ sidebarOpen: true });
    render(<IconSidebar />);
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    expect(names).toEqual([
      t('shell.iconbar.hide_explorer'),
      t('shell.iconbar.search'),
      t('shell.iconbar.run_debug'),
      t('shell.iconbar.settings'),
    ]);
    const search = screen.getByRole('button', { name: '搜索' });
    const debug = screen.getByRole('button', { name: '运行和调试' });
    expect(search.getAttribute('title')).toBe('搜索 (Ctrl+Shift+F)');
    expect(debug.getAttribute('title')).toBe('运行和调试 (Ctrl+Shift+D)');
    act(() => useKeybindingsStore.setState({ overrides: { 'workbench.view.debug': 'mod+alt+d', 'workbench.action.findInFiles': '' } }));
    expect(debug.getAttribute('title')).toBe('运行和调试 (Ctrl+Alt+D)');
    expect(search.getAttribute('title')).toBe('搜索');
    fireEvent.click(search);
    fireEvent.click(debug);
    await flush();
    expect(ran).toEqual(['workbench.action.findInFiles', 'workbench.view.debug']);
  });
});

describe('设置搜索框旁「筛选设置」菜单(VSCode settingsSearchMenu)', () => {
  beforeEach(() => {
    useSettingsStore.setState({ activeTabId: null, pendingSearchQuery: null });
    useSettingsValuesStore.setState({ values: { 'editor.fontSize': 16 } });
  });

  it('查询标签 helper:勾选项追加 / 去掉整词;普通项追加到末尾', () => {
    expect(toggleSettingsQueryTag('', '@modified')).toBe('@modified');
    expect(toggleSettingsQueryTag('font  ', '@modified')).toBe('font @modified');
    expect(toggleSettingsQueryTag('font @modified', '@modified')).toBe('font');
    expect(toggleSettingsQueryTag('@modifiedx', '@modified')).toBe('@modifiedx @modified');
    expect(hasSettingsQueryTag('a @modified b', '@modified')).toBe(true);
    expect(hasSettingsQueryTag('@modifiedx', '@modified')).toBe(false);
    expect(appendSettingsQueryTag('', '@id:')).toBe('@id:');
    expect(appendSettingsQueryTag('font ', '@id:')).toBe('font @id:');
  });

  function renderPanel() {
    const tabs = new SettingTabRegistry();
    tabs.register({ id: 'general', title: '通用', render: () => '通用内容', priority: 10 });
    const items = new SettingItemRegistry();
    items.register(EDITOR_FONT_SIZE);
    items.register(TERMINAL_FONT_SIZE);
    return render(<SettingsPanel registry={tabs} itemRegistry={items} />);
  }

  it('按钮「筛选设置」(aria-haspopup=menu);「已修改」勾选切换 @modified 并只列已修改项,焦点回搜索框;「设置 ID…」追加 @id:', () => {
    const { container } = renderPanel();
    const input = screen.getByRole('textbox', { name: t('settings.panel.search_placeholder') }) as HTMLInputElement;
    const filter = screen.getByRole('button', { name: '筛选设置' });
    expect(filter.getAttribute('title')).toBe('筛选设置');
    expect(filter.getAttribute('aria-haspopup')).toBe('menu');

    fireEvent.click(filter);
    const modified = screen.getByRole('menuitemcheckbox', { name: '已修改' });
    expect(modified.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(modified);
    expect(input.value).toBe('@modified');
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(container.querySelector('[data-setting-row="editor.fontSize"]')).not.toBeNull();
    expect(container.querySelector('[data-setting-row="terminal.integrated.fontSize"]')).toBeNull();

    fireEvent.click(filter);
    expect(screen.getByRole('menuitemcheckbox', { name: '已修改' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('menuitem', { name: '设置 ID…' }));
    expect(input.value).toBe('@modified @id:');

    fireEvent.click(filter);
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: '已修改' }));
    expect(input.value).toBe('@id:');
  });
});

describe('状态栏「侧栏已隐藏」可点', () => {
  beforeEach(() => {
    _resetLmApiForTest();
    Object.defineProperty(window, 'api', { value: {}, writable: true, configurable: true });
    captureLmApi();
    useWorkspaceStore.setState({ root: null, recentRoots: [] });
  });
  afterEach(() => {
    delete (window as { api?: unknown }).api;
  });

  it('侧栏隐藏时是按钮:title「显示侧栏 (键位)」随改键;点击执行 explorer.toggleSidebar;侧栏显示时不出现', async () => {
    useLayoutUiStore.setState({ sidebarOpen: false });
    const { rerender } = render(<StatusBar />);
    const btn = screen.getByRole('button', { name: '侧栏已隐藏' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('title')).toBe('显示侧栏 (Ctrl+B)');
    act(() => useKeybindingsStore.setState({ overrides: { 'explorer.toggleSidebar': 'mod+alt+b' } }));
    expect(btn.getAttribute('title')).toBe('显示侧栏 (Ctrl+Alt+B)');
    fireEvent.click(btn);
    await flush();
    expect(ran).toEqual(['explorer.toggleSidebar']);
    act(() => useLayoutUiStore.setState({ sidebarOpen: true }));
    rerender(<StatusBar />);
    expect(screen.queryByRole('button', { name: '侧栏已隐藏' })).toBeNull();
  });
});
