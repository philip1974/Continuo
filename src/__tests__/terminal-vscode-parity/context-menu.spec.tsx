// @vitest-environment jsdom
// BDD: terminal-vscode-parity / 9 终端右键菜单(拆分终端 / 复制 / 粘贴 / 全选 / 清除;拆分见 terminal-split),Shift+F10 / 菜单键可打开
import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TerminalContextMenu, type TerminalContextMenuActions } from '../../panels/Terminal/TerminalContextMenu';
import { isTerminalContextMenuKey } from '../../panels/Terminal/terminal-hotkeys';
import { setLocale } from '../../i18n';

function actions(over: Partial<TerminalContextMenuActions> = {}): TerminalContextMenuActions {
  return {
    hasSelection: () => false,
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
    ...over,
  };
}

function open(a: TerminalContextMenuActions, onSplit: () => void = vi.fn()) {
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
  it('「拆分终端」→ onSplit(关闭菜单后焦点交给新终端,不回本终端:jsdom 不触发 onCloseAutoFocus,见 e2e terminal-split)', () => {
    const onSplit = vi.fn();
    open(actions(), onSplit);
    act(() => fireEvent.click(screen.getByRole('menuitem', { name: '拆分终端' })));
    expect(onSplit).toHaveBeenCalledTimes(1);
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
