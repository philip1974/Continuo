// @vitest-environment jsdom
// BDD: win-linux-parity / 7 Windows 终端右键 = 有选区复制并清除、无选区粘贴(VSCode rightClickBehavior 默认 copyPaste);
// Shift+右键 / 键盘打开 / mac / Linux 照常弹菜单
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  isTerminalRightClickCopyPaste,
  TerminalContextMenu,
  type TerminalContextMenuActions,
} from '../../panels/Terminal/TerminalContextMenu';
import { setLocale } from '../../i18n';

function actions(selected: boolean): TerminalContextMenuActions {
  return {
    hasSelection: () => selected,
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    clearSelection: vi.fn(),
    clear: vi.fn(),
    focus: vi.fn(),
  };
}

let platformDescriptor: PropertyDescriptor | undefined;
const setPlatform = (value: string) =>
  Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => value });

beforeEach(() => {
  platformDescriptor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'platform');
  setLocale('zh');
});
afterEach(() => {
  cleanup();
  setLocale('en');
  if (platformDescriptor) Object.defineProperty(Navigator.prototype, 'platform', platformDescriptor);
});

function rightClick(a: TerminalContextMenuActions, init: MouseEventInit = { button: 2 }) {
  render(
    <TerminalContextMenu actions={a} onSplit={vi.fn(async () => 'new')}>
      <div data-testid="term">xterm</div>
    </TerminalContextMenu>,
  );
  fireEvent.contextMenu(screen.getByTestId('term'), init);
}

const menuOpen = () => screen.queryAllByRole('menuitem').length > 0;

describe('判定:仅 Windows 的鼠标右键(button 2、不带 Shift)', () => {
  it.each([
    ['windows', { button: 2, shiftKey: false }, true],
    ['windows', { button: 2, shiftKey: true }, false],
    ['windows', { button: 0, shiftKey: false }, false],
    ['linux', { button: 2, shiftKey: false }, false],
    ['mac', { button: 2, shiftKey: false }, false],
  ] as const)('%s %o → %s', (os, event, expected) => {
    expect(isTerminalRightClickCopyPaste(event, os)).toBe(expected);
  });
});

describe('Windows 右键', () => {
  beforeEach(() => setPlatform('Win32'));
  it('有选区 → 复制并清除选区,不弹菜单', () => {
    const a = actions(true);
    rightClick(a);
    expect(a.copy).toHaveBeenCalledTimes(1);
    expect(a.clearSelection).toHaveBeenCalledTimes(1);
    expect(a.paste).not.toHaveBeenCalled();
    expect(menuOpen()).toBe(false);
  });
  it('没有选区 → 粘贴,不弹菜单', () => {
    const a = actions(false);
    rightClick(a);
    expect(a.paste).toHaveBeenCalledTimes(1);
    expect(a.copy).not.toHaveBeenCalled();
    expect(menuOpen()).toBe(false);
  });
  it('Shift+右键、键盘打开(Shift+F10 / 菜单键,button 0)→ 弹菜单', () => {
    const a = actions(true);
    rightClick(a, { button: 2, shiftKey: true });
    expect(menuOpen()).toBe(true);
    cleanup();
    rightClick(a, { button: 0 });
    expect(menuOpen()).toBe(true);
    expect(a.copy).not.toHaveBeenCalled();
    expect(a.paste).not.toHaveBeenCalled();
  });
});

describe.each([
  ['Linux', 'Linux x86_64'],
  ['mac', 'MacIntel'],
])('%s 右键照常弹菜单', (_name, platform) => {
  it('不复制 / 不粘贴', () => {
    setPlatform(platform);
    const a = actions(true);
    rightClick(a);
    expect(menuOpen()).toBe(true);
    expect(a.copy).not.toHaveBeenCalled();
    expect(a.paste).not.toHaveBeenCalled();
  });
});
