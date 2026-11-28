// @vitest-environment jsdom
// BDD: hotkey-hints —— tooltip「名称 (键位)」与菜单项右侧键位(对齐 VSCode),键位取当前生效绑定,改键后跟随。
// jsdom 平台非 mac:键位按 Windows / Linux 格式(Ctrl+B);mac 格式由 formatHotkey 规则保证(format-hotkey BDD)。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/shell/dock/create-user-terminal', () => ({ createUserTerminal: vi.fn() }));
vi.mock('@/lib/toggle-settings-panel', () => ({ toggleSettingsPanel: vi.fn() }));
vi.mock('@/lib/co-api', () => ({ coApi: { fs: { reveal: vi.fn() } } }));

import { coApp } from '@/plugins/co-app';
import { CommandRegistry } from '@/plugins/registries/CommandRegistry';
import { PanelRegistry } from '@/plugins/registries/PanelRegistry';
import { RibbonRegistry } from '@/plugins/registries/RibbonRegistry';
import { useKeybindingsStore } from '@/plugins/keybindings/keybindings-store';
import { commandHotkeyText, withHotkey } from '@/lib/hotkey-label';
import { setLocale, t } from '@/i18n';
import { IconSidebar } from '@/shell/IconSidebar';
import { HeaderActions } from '@/shell/dock/HeaderActions';
import { EditorHeader } from '@/panels/Editor/EditorHeader';
import { SharedTab } from '@/shell/motion/SharedTab';
import { ContextMenu, type ContextMenuActions } from '@/panels/Explorer/ContextMenu';
import { useEditorStore, type EditorTab } from '@/stores/editor.store';
import { useLayoutUiStore } from '@/stores/layout-ui.store';
import { useWorkspaceStore } from '@/stores/workspace.store';
import type { FileEntry } from '@/lib/fs/types';

const noop = () => {};

function registerCommands(): void {
  const commands = new CommandRegistry('other');
  for (const [id, hotkey] of [
    ['explorer.toggleSidebar', 'mod+b'],
    ['settings.toggle', 'mod+,'],
    ['terminal.new', 'mod+t'],
    ['workbench.action.findInFiles', 'mod+shift+f'],
    ['workbench.view.debug', 'mod+shift+d'],
    ['workbench.view.output', 'mod+shift+u'],
    ['workbench.action.closeActiveEditor', 'mod+w'],
  ] as const) {
    commands.register({ id, title: id, hotkey, fn: noop });
  }
  (coApp as { commands: CommandRegistry }).commands = commands;
}

let originalCommands: CommandRegistry;
let originalPanels: PanelRegistry;
let originalRibbon: RibbonRegistry;
beforeEach(() => {
  setLocale('zh');
  originalCommands = coApp.commands;
  originalPanels = coApp.panels;
  originalRibbon = coApp.ribbon;
  (coApp as { ribbon: RibbonRegistry }).ribbon = new RibbonRegistry();
  registerCommands();
  useKeybindingsStore.setState({ overrides: {} });
});
afterEach(() => {
  cleanup();
  (coApp as { commands: CommandRegistry }).commands = originalCommands;
  (coApp as { panels: PanelRegistry }).panels = originalPanels;
  (coApp as { ribbon: RibbonRegistry }).ribbon = originalRibbon;
  useKeybindingsStore.setState({ overrides: {} });
  setLocale('en');
});

// 键位在 design MenuItem 的 shortcut 槽(aria-hidden:不计入可访问名称,菜单项仍按名称念 / 匹配)
const shortcutOf = (el: Element | undefined) => {
  const span = el?.querySelector('.wm-menu-item__shortcut');
  if (span) expect(span.getAttribute('aria-hidden')).toBe('true');
  return span?.textContent ?? null;
};
const menuItems = () => Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]'));
const menuItem = (label: string) => menuItems().find((el) => el.textContent?.startsWith(label));

describe('键位文案 helper', () => {
  it('取生效绑定:默认键 / 用户改绑 / 解绑 / 落在 ⌘P 保留键', () => {
    const spec = { id: 'x.cmd', hotkey: 'mod+b' };
    expect(commandHotkeyText(spec, {}, 'other')).toBe('Ctrl+B');
    expect(commandHotkeyText(spec, {}, 'mac')).toBe('⌘B');
    expect(commandHotkeyText(spec, { 'x.cmd': 'mod+shift+b' }, 'other')).toBe('Ctrl+Shift+B');
    expect(commandHotkeyText(spec, { 'x.cmd': '' }, 'other')).toBeUndefined();
    expect(commandHotkeyText(spec, { 'x.cmd': 'mod+p' }, 'other')).toBeUndefined();
    expect(commandHotkeyText(undefined, {}, 'other')).toBeUndefined();
    expect(withHotkey('设置', 'Ctrl+,')).toBe('设置 (Ctrl+,)');
    expect(withHotkey('设置', undefined)).toBe('设置');
  });
});

describe('活动栏 tooltip', () => {
  it('隐藏资源管理器 (Ctrl+B) / 设置 (Ctrl+,);可访问名称仍是纯名称;改键后跟随', () => {
    useLayoutUiStore.setState({ sidebarOpen: true });
    render(<IconSidebar />);
    const explorer = screen.getByRole('button', { name: t('shell.iconbar.hide_explorer') });
    expect(explorer.getAttribute('title')).toBe(`${t('shell.iconbar.hide_explorer')} (Ctrl+B)`);
    const settings = screen.getByRole('button', { name: t('shell.iconbar.settings') });
    expect(settings.getAttribute('title')).toBe(`${t('shell.iconbar.settings')} (Ctrl+,)`);
    act(() => useKeybindingsStore.setState({ overrides: { 'explorer.toggleSidebar': 'mod+shift+b', 'settings.toggle': '' } }));
    expect(explorer.getAttribute('title')).toBe(`${t('shell.iconbar.hide_explorer')} (Ctrl+Shift+B)`);
    expect(settings.getAttribute('title')).toBe(t('shell.iconbar.settings'));
  });
});

function editorTab(id: string): EditorTab {
  return { id, filePath: id, content: '', originalContent: '', dirty: false };
}

describe('编辑器 tab 右键菜单', () => {
  it('「关闭」右侧 Ctrl+W、「向右拆分」右侧 Ctrl+\\;改键后下次打开跟随', () => {
    useEditorStore.setState({ tabs: [editorTab('/w/a.ts'), editorTab('/w/b.ts')], activeTabId: '/w/a.ts', mode: 'edit' });
    useWorkspaceStore.setState({ root: '/w' });
    render(<EditorHeader onCloseRequest={vi.fn()} onCloseTabsRequest={vi.fn()} />);
    const tab = () => Array.from(document.querySelectorAll<HTMLElement>('[role=tab]')).find((el) => el.textContent?.startsWith('b.ts'))!;
    fireEvent.contextMenu(tab());
    expect(shortcutOf(menuItem(t('shell.tab.ctx.close')))).toBe('Ctrl+W');
    expect(shortcutOf(menuItem(t('shell.tab.ctx.split_right')))).toBe('Ctrl+\\');
    expect(shortcutOf(menuItem(t('shell.tab.ctx.close_others')))).toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    act(() => useKeybindingsStore.setState({ overrides: { 'workbench.action.closeActiveEditor': 'mod+shift+w' } }));
    fireEvent.contextMenu(tab());
    expect(shortcutOf(menuItem(t('shell.tab.ctx.close')))).toBe('Ctrl+Shift+W');
  });
});

describe('资源管理器右键菜单', () => {
  const actions = (): ContextMenuActions => ({
    onRename: vi.fn(),
    onNewFile: vi.fn(),
    onNewDir: vi.fn(),
    onCopyPath: vi.fn(),
    onCopyRelativePath: vi.fn(),
    onRevealInFinder: vi.fn(),
    onOpenInTerminal: vi.fn(),
    onTrash: vi.fn(),
    onCut: vi.fn(),
    onCopy: vi.fn(),
    onPaste: vi.fn(),
  });
  const open = (target: FileEntry, selected: string[]) => {
    const r = render(
      <ContextMenu target={target} selectedPaths={new Set(selected)} rootPath="/work" actions={actions()} hasClipboard pluginItems={[]}>
        <div data-testid="trigger">row</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(r.getByTestId('trigger'));
  };

  it('剪切 / 复制 / 粘贴 / 重命名 / 移到废纸篓都显示树内键位', () => {
    open({ path: '/work/dir', name: 'dir', isDirectory: true } as FileEntry, ['/work/dir']);
    expect(shortcutOf(menuItem(t('panels.explorer.ctx.cut')))).toBe('Ctrl+X');
    expect(shortcutOf(menuItem(t('panels.explorer.ctx.copy')))).toBe('Ctrl+C');
    expect(shortcutOf(menuItem(t('panels.explorer.ctx.paste')))).toBe('Ctrl+V');
    expect(shortcutOf(menuItem(t('panels.explorer.ctx.rename')))).toBe('F2');
    expect(shortcutOf(menuItem(t('panels.explorer.ctx.trash')))).toBe('Del');
  });

  it('多选时「移到废纸篓」先条目数再键位', () => {
    open({ path: '/work/a.ts', name: 'a.ts', isDirectory: false } as FileEntry, ['/work/a.ts', '/work/b.ts']);
    const trash = menuItem(t('panels.explorer.ctx.trash'));
    expect(trash?.querySelector('.wm-menu-item__trailing')?.textContent).toBe(t('panels.explorer.ctx.items_count', { count: 2 }));
    expect(shortcutOf(trash)).toBe('Del');
  });
});

describe('组「打开视图…」菜单', () => {
  it('终端 / 搜索 / 设置 / 调试 / 输出右侧显示打开命令的键位(与显示菜单 / 命令面板一致),其它面板无;按钮名同 VSCode「打开视图…」', () => {
    const panels = new PanelRegistry();
    for (const type of ['terminal', 'search', 'settings', 'debug', 'output', 'editor']) {
      panels.register({ type, title: type, factory: () => null });
    }
    (coApp as { panels: PanelRegistry }).panels = panels;
    const props = {
      containerApi: { addPanel: vi.fn(), getPanel: vi.fn(() => undefined), addPopoutGroup: vi.fn() },
      group: { id: 'g1', api: { location: { type: 'grid' } } },
      activePanel: { id: 'p1' },
    } as unknown as Parameters<typeof HeaderActions>[0];
    render(<HeaderActions {...props} />);
    fireEvent.click(screen.getByRole('button', { name: t('shell.dock.open_view') }));
    expect(shortcutOf(menuItem('terminal'))).toBe('Ctrl+T');
    expect(shortcutOf(menuItem('search'))).toBe('Ctrl+Shift+F');
    expect(shortcutOf(menuItem('settings'))).toBe('Ctrl+,');
    expect(shortcutOf(menuItem('debug'))).toBe('Ctrl+Shift+D');
    expect(shortcutOf(menuItem('output'))).toBe('Ctrl+Shift+U');
    expect(shortcutOf(menuItem('editor'))).toBeNull();
    const trigger = screen.getByRole('button', { name: '打开视图…' });
    expect(trigger.getAttribute('title')).toBe('打开视图…');
  });
});

describe('tab 关闭按钮 ✕ 的悬停提示「关闭 (⌘W)」(VSCode tab 关闭动作:名称 + 当前生效键位)', () => {
  const closeOf = (tab: Element) => tab.querySelector<HTMLElement>('[role=button]')!;

  it('编辑器文件 tab:每个 tab 的 ✕ title「关闭 (Ctrl+W)」,可访问名称仍含文件名;改键 / 解绑跟随', () => {
    useEditorStore.setState({ tabs: [editorTab('/w/a.ts'), editorTab('/w/b.ts')], activeTabId: '/w/a.ts', mode: 'edit' });
    render(<EditorHeader onCloseRequest={vi.fn()} />);
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role=tab]'));
    expect(tabs.map((el) => closeOf(el).getAttribute('title'))).toEqual(['关闭 (Ctrl+W)', '关闭 (Ctrl+W)']);
    expect(closeOf(tabs[1]!).getAttribute('aria-label')).toBe(t('shell.tab.close', { title: 'b.ts' }));
    act(() => useKeybindingsStore.setState({ overrides: { 'workbench.action.closeActiveEditor': 'mod+shift+w' } }));
    expect(closeOf(tabs[0]!).getAttribute('title')).toBe('关闭 (Ctrl+Shift+W)');
    act(() => useKeybindingsStore.setState({ overrides: { 'workbench.action.closeActiveEditor': '' } }));
    expect(closeOf(tabs[0]!).getAttribute('title')).toBe('关闭');
  });

  it('dock 面板 tab:✕ title「关闭 (Ctrl+W)」,可访问名称「关闭 {标题}」;右键「关闭」右侧 Ctrl+W;改键跟随', () => {
    const api = {
      id: 'p1',
      title: '终端',
      isActive: true,
      isVisible: true,
      group: { id: 'g1', api: { isMaximized: () => false }, panels: [{ id: 'p1', api: { id: 'p1', close: vi.fn() } }] },
      close: vi.fn(),
      setActive: vi.fn(),
      onDidActiveChange: () => ({ dispose: vi.fn() }),
      onDidTitleChange: () => ({ dispose: vi.fn() }),
      onDidVisibilityChange: () => ({ dispose: vi.fn() }),
      onDidGroupChange: () => ({ dispose: vi.fn() }),
    };
    const props = {
      api,
      containerApi: { onDidMaximizedGroupChange: () => ({ dispose: vi.fn() }), exitMaximizedGroup: vi.fn() },
      params: {},
    } as unknown as Parameters<typeof SharedTab>[0];
    render(<SharedTab {...props} />);
    const tab = screen.getByRole('tab');
    const close = tab.querySelector<HTMLElement>('[data-tab-close]')!;
    expect(close.getAttribute('title')).toBe('关闭 (Ctrl+W)');
    expect(close.getAttribute('aria-label')).toBe(t('shell.tab.close', { title: '终端' }));
    fireEvent.contextMenu(tab);
    expect(shortcutOf(menuItem(t('shell.tab.ctx.close')))).toBe('Ctrl+W');
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    act(() => useKeybindingsStore.setState({ overrides: { 'workbench.action.closeActiveEditor': 'mod+alt+w' } }));
    expect(close.getAttribute('title')).toBe('关闭 (Ctrl+Alt+W)');
  });
});
