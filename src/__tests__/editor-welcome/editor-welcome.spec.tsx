// @vitest-environment jsdom
// BDD:编辑区无 tab 时的空状态(对齐 VSCode 空编辑区水印:Show All Commands / Open Folder / Go to File + 快捷键)。
// 无工作区 →「打开文件夹 ⌘O」「显示所有命令 ⇧⌘P」;有工作区 →「快速打开文件 ⌘P」「显示所有命令 ⇧⌘P」。
// 每项是可聚焦按钮,快捷键标签取命令的实际生效绑定(改键 / 解绑后跟随)。
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, render, cleanup, fireEvent, screen } from '@testing-library/react';
import { notifyLocaleChange, setLocale, t } from '@/i18n';
import { EditorWelcome } from '../../panels/Editor/EditorWelcome';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { useQuickOpenStore } from '../../plugins/quick-open/store';
import { coApp } from '../../plugins/co-app';
import { OPEN_FOLDER_COMMAND } from '../../panels/Explorer/explorer-commands';

let platformDesc: PropertyDescriptor | undefined;
function setPlatform(value: string): void {
  Object.defineProperty(navigator, 'platform', { value, configurable: true });
}

beforeEach(() => {
  platformDesc = Object.getOwnPropertyDescriptor(navigator, 'platform');
  setPlatform('MacIntel');
  act(() => {
    setLocale('zh');
    notifyLocaleChange();
  });
  useWorkspaceStore.setState({ root: null });
  useKeybindingsStore.setState({ overrides: {} });
  useCommandPaletteStore.getState().close();
  useQuickOpenStore.getState().close();
});

afterEach(() => {
  cleanup();
  if (platformDesc) Object.defineProperty(navigator, 'platform', platformDesc);
});

/** 按钮里的 KeyCap 文本(逐个 kbd)。 */
function keycaps(button: HTMLElement): string[] {
  return [...button.querySelectorAll('kbd')].map((k) => k.textContent ?? '');
}

describe('EditorWelcome · 无工作区', () => {
  it('显示「打开文件夹 ⌘O」「显示所有命令 ⇧⌘P」两个按钮,不再提示「在资源管理器中单击文件」', () => {
    const { container } = render(<EditorWelcome />);
    expect(container.textContent).toContain(t('editor.welcome.title'));
    const open = screen.getByRole('button', { name: new RegExp(t('editor.welcome.open_folder')) });
    const cmds = screen.getByRole('button', { name: new RegExp(t('editor.welcome.show_commands')) });
    expect(keycaps(open)).toEqual(['⌘', 'O']);
    expect(keycaps(cmds)).toEqual(['⇧', '⌘', 'P']);
    expect(screen.queryByRole('button', { name: new RegExp(t('editor.welcome.quick_open')) })).toBeNull();
    expect(container.textContent).not.toContain('单击文件');
    expect(container.querySelector('[aria-hidden="true"] svg')).not.toBeNull();
  });

  it('点「打开文件夹」执行已注册的打开文件夹命令', () => {
    const fn = vi.fn();
    const reg = coApp.commands.register({ ...OPEN_FOLDER_COMMAND, title: 'Open Folder…', fn });
    try {
      render(<EditorWelcome />);
      fireEvent.click(screen.getByRole('button', { name: new RegExp(t('editor.welcome.open_folder')) }));
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      reg.dispose();
    }
  });

  it('点「显示所有命令」打开命令面板', () => {
    render(<EditorWelcome />);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(t('editor.welcome.show_commands')) }));
    expect(useCommandPaletteStore.getState().isOpen).toBe(true);
  });

  it('打开文件夹改键后标签跟随;解绑后不显示快捷键', () => {
    const reg = coApp.commands.register({ ...OPEN_FOLDER_COMMAND, title: 'Open Folder…', fn: vi.fn() });
    try {
      render(<EditorWelcome />);
      const name = new RegExp(t('editor.welcome.open_folder'));
      act(() => useKeybindingsStore.getState().setHotkey(OPEN_FOLDER_COMMAND.id, 'mod+alt+k'));
      expect(keycaps(screen.getByRole('button', { name }))).toEqual(['⌥', '⌘', 'K']);
      act(() => useKeybindingsStore.getState().setHotkey(OPEN_FOLDER_COMMAND.id, ''));
      expect(keycaps(screen.getByRole('button', { name }))).toEqual([]);
    } finally {
      reg.dispose();
    }
  });

  it('非 mac 平台按 Ctrl 显示', () => {
    setPlatform('Linux x86_64');
    render(<EditorWelcome />);
    const cmds = screen.getByRole('button', { name: new RegExp(t('editor.welcome.show_commands')) });
    expect(keycaps(cmds)).toEqual(['Ctrl', 'Shift', 'P']);
  });
});

describe('EditorWelcome · 有工作区', () => {
  it('显示「快速打开文件 ⌘P」「显示所有命令 ⇧⌘P」,点快速打开打开文件选择器', () => {
    useWorkspaceStore.setState({ root: '/ws' });
    render(<EditorWelcome />);
    expect(screen.queryByRole('button', { name: new RegExp(t('editor.welcome.open_folder')) })).toBeNull();
    const qo = screen.getByRole('button', { name: new RegExp(t('editor.welcome.quick_open')) });
    expect(keycaps(qo)).toEqual(['⌘', 'P']);
    fireEvent.click(qo);
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
  });
});

describe('EditorWelcome · 三语', () => {
  it.each([
    ['en', 'No file open', 'Open Folder', 'Show All Commands'],
    ['ko', '열린 파일 없음', '폴더 열기', '모든 명령 표시'],
  ] as const)('%s', (locale, title, open, cmds) => {
    act(() => {
      setLocale(locale);
      notifyLocaleChange();
    });
    const { container } = render(<EditorWelcome />);
    expect(container.textContent).toContain(title);
    expect(container.textContent).toContain(open);
    expect(container.textContent).toContain(cmds);
  });
});
