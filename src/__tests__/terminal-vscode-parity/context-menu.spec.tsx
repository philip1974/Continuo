// @vitest-environment jsdom
// BDD: terminal-vscode-parity / 9 终端右键菜单(拆分终端 / 复制 / 粘贴 / 全选 / 清除;拆分见 terminal-split),Shift+F10 / 菜单键可打开
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TerminalContextMenu, type TerminalContextMenuActions } from '../../panels/Terminal/TerminalContextMenu';
import {
  isTerminalContextMenuKey,
  TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND_ID,
  TERMINAL_COPY_SELECTION_COMMAND_ID,
  TERMINAL_PASTE_COMMAND_ID,
} from '../../panels/Terminal/terminal-hotkeys';
import { setLocale } from '../../i18n';
import { coApp } from '../../plugins/co-app';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';

function actions(over: Partial<TerminalContextMenuActions> = {}): TerminalContextMenuActions {
  return {
    hasSelection: () => false,
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    ...over,
  };
}

function open(a: TerminalContextMenuActions, onSplit: () => Promise<string | null> = vi.fn(async () => 'new')) {
  render(
    <TerminalContextMenu actions={a} onSplit={onSplit}>
      <div data-testid="term">xterm</div>
    </TerminalContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('term'));
}

beforeEach(() => setLocale('zh'));
afterEach(() => {
  cleanup();
  setLocale('en');
});

describe('终端右键菜单', () => {
  it('五项:拆分终端 / 复制 / 粘贴 / 全选 / 清除终端;无选区时复制不可用', () => {
    open(actions());
    const items = screen.getAllByRole('menuitem').map((el) => el.textContent);
    expect(items).toEqual(['拆分终端', '复制', '粘贴', '全选', '清除终端']);
    expect((screen.getByRole('menuitem', { name: '复制' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('有选区时复制可用,选中执行对应动作', () => {
    const a = actions({ hasSelection: () => true });
    open(a);
    expect((screen.getByRole('menuitem', { name: '复制' }) as HTMLButtonElement).disabled).toBe(false);
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: '复制' })));
    expect(a.copy).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['粘贴', 'paste'],
    ['全选', 'selectAll'],
    ['清除终端', 'clear'],
  ] as const)('「%s」→ %s', (label, key) => {
    const a = actions();
    open(a);
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: label })));
    expect(a[key]).toHaveBeenCalledTimes(1);
  });
  it('「拆分终端」→ onSplit(关闭菜单后焦点交给新终端,不回本终端:jsdom 不触发 onCloseAutoFocus,见 e2e terminal-split)', async () => {
    const onSplit = vi.fn(async () => 'new');
    const a = actions();
    open(a, onSplit);
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: '拆分终端' })));
    expect(onSplit).toHaveBeenCalledTimes(1);
    await act(async () => {});
    expect(a.focus).not.toHaveBeenCalled();
  });
  it.each([
    ['新建失败(null)', () => Promise.resolve(null)],
    ['抛错', () => Promise.reject(new Error('boom'))],
  ] as const)('「拆分终端」%s → 焦点还给本终端(不掉到 body)', async (_label, impl) => {
    const a = actions();
    open(a, vi.fn(impl));
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: '拆分终端' })));
    await act(async () => {});
    expect(a.focus).toHaveBeenCalledTimes(1);
  });
  it('「拆分终端」失败前焦点已去了别处 → 不抢焦点', async () => {
    let fail!: (v: null) => void;
    const a = actions();
    open(a, () => new Promise<string | null>((r) => (fail = r)));
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: '拆分终端' })));
    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    await act(async () => fail(null));
    expect(a.focus).not.toHaveBeenCalled();
    other.remove();
  });
  it('三语文案齐全', async () => {
    const { en } = await import('../../../electron/shared/i18n-locales/en');
    const { zh } = await import('../../../electron/shared/i18n-locales/zh');
    const { ko } = await import('../../../electron/shared/i18n-locales/ko');
    for (const cat of [en, zh, ko] as Array<Record<string, string>>) {
      for (const k of ['copy', 'paste', 'select_all', 'copy_failed', 'paste_failed']) {
        expect(cat[`panels.terminal.ctx.${k}`]).toBeTruthy();
      }
    }
  });
});

describe('「清除终端」右侧显示键位(VSCode 终端右键同显示 ⌘K)', () => {
  let original: CommandRegistry;
  beforeEach(() => {
    original = coApp.commands;
    const commands = new CommandRegistry('other');
    commands.register({ id: 'terminal.clear', title: 'Clear', hotkey: 'mod+k', fn: vi.fn() });
    (coApp as { commands: CommandRegistry }).commands = commands;
    useKeybindingsStore.setState({ overrides: {} });
  });
  afterEach(() => {
    (coApp as { commands: CommandRegistry }).commands = original;
    useKeybindingsStore.setState({ overrides: {} });
  });
  const shortcut = () =>
    screen.getByRole('menuitem', { name: '清除终端' }).querySelector('.wm-menu-item__shortcut')?.textContent ?? null;

  it('取当前生效绑定:默认 Ctrl+K(jsdom 非 mac);改键跟随;解绑不显示', () => {
    open(actions());
    expect(shortcut()).toBe('Ctrl+K');
    cleanup();
    useKeybindingsStore.setState({ overrides: { 'terminal.clear': 'mod+alt+k' } });
    open(actions());
    expect(shortcut()).toBe('Ctrl+Alt+K');
    cleanup();
    useKeybindingsStore.setState({ overrides: { 'terminal.clear': '' } });
    open(actions());
    expect(shortcut()).toBeNull();
  });
});

// VSCode 终端右键菜单的「复制」「粘贴」就是 copySelection / paste 命令,右侧显示其主键位(Windows / Linux 复制 Ctrl+Shift+C ——
// Windows 的 Ctrl+C 属于 copyAndClearSelection,菜单不显示;粘贴 Ctrl+V / Linux Ctrl+Shift+V);mac 两命令无默认键 → 不显示。
describe('「复制」「粘贴」右侧显示 copySelection / paste 的当前生效键位', () => {
  let original: CommandRegistry;
  const install = (copy: string | undefined, paste: string | undefined): void => {
    const commands = new CommandRegistry('other');
    commands.register({ id: TERMINAL_COPY_SELECTION_COMMAND_ID, title: 'Copy Selection', hotkey: copy, fn: vi.fn() });
    commands.register({ id: TERMINAL_COPY_AND_CLEAR_SELECTION_COMMAND_ID, title: 'Copy and Clear', hotkey: 'ctrl+c', fn: vi.fn() });
    commands.register({
      id: TERMINAL_PASTE_COMMAND_ID,
      title: 'Paste',
      hotkey: paste,
      secondaryHotkeys: paste === undefined ? undefined : ['ctrl+shift+v'],
      fn: vi.fn(),
    });
    (coApp as { commands: CommandRegistry }).commands = commands;
  };
  beforeEach(() => {
    original = coApp.commands;
    useKeybindingsStore.setState({ overrides: {} });
  });
  afterEach(() => {
    (coApp as { commands: CommandRegistry }).commands = original;
    useKeybindingsStore.setState({ overrides: {} });
  });
  const shortcutOf = (name: string) =>
    screen.getByRole('menuitem', { name: new RegExp(`^${name}`) }).querySelector('.wm-menu-item__shortcut')?.textContent ??
    null;

  it('Windows 默认键:复制 Ctrl+Shift+C(不是 copyAndClearSelection 的 Ctrl+C)、粘贴 Ctrl+V;改键跟随', () => {
    install('ctrl+shift+c', 'ctrl+v');
    open(actions({ hasSelection: () => true }));
    expect(shortcutOf('复制')).toBe('Ctrl+Shift+C');
    expect(shortcutOf('粘贴')).toBe('Ctrl+V');
    cleanup();
    useKeybindingsStore.setState({ overrides: { [TERMINAL_PASTE_COMMAND_ID]: 'ctrl+alt+v' } });
    open(actions());
    expect(shortcutOf('粘贴')).toBe('Ctrl+Alt+V');
  });

  it('mac(两命令无默认键)→ 不显示', () => {
    install(undefined, undefined);
    open(actions());
    expect(shortcutOf('复制')).toBeNull();
    expect(shortcutOf('粘贴')).toBeNull();
  });
});

describe('键盘打开', () => {
  const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
  it('Shift+F10 与菜单键打开;F10 / 带其它修饰的 Shift+F10 不打开', () => {
    expect(isTerminalContextMenuKey(key({ key: 'F10', shiftKey: true }))).toBe(true);
    expect(isTerminalContextMenuKey(key({ key: 'ContextMenu' }))).toBe(true);
    expect(isTerminalContextMenuKey(key({ key: 'F10' }))).toBe(false);
    expect(isTerminalContextMenuKey(key({ key: 'F10', shiftKey: true, ctrlKey: true }))).toBe(false);
    expect(isTerminalContextMenuKey(new KeyboardEvent('keyup', { key: 'ContextMenu' }))).toBe(false);
  });
  it('useTerminal 键处理:命中即在终端光标处派发 contextmenu,并用 TerminalContextMenu 包住终端', () => {
    const hook = readFileSync('src/panels/Terminal/useTerminal.ts', 'utf-8');
    expect(hook).toContain('isTerminalContextMenuKey(event)');
    const view = readFileSync('src/panels/Terminal/TerminalPanelView.tsx', 'utf-8');
    expect(view).toContain('<TerminalContextMenu');
  });
});
