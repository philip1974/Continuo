// @vitest-environment jsdom
// BDD:编辑区无 tab 时的空状态(对齐 VSCode 空编辑区水印:Show All Commands / Open Folder / Go to File + 快捷键)。
// 无工作区 →「打开文件夹 ⌘O」「显示所有命令 ⇧⌘P」;有工作区 →「转到文件 ⌘P」「在文件中查找 ⇧⌘F」「新建终端 ⌘T」
//「显示所有命令 ⇧⌘P」。
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
import { en } from '@shared/i18n-locales/en';
import { zh } from '@shared/i18n-locales/zh';
import { ko } from '@shared/i18n-locales/ko';

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
  it('显示「转到文件 ⌘P」「显示所有命令 ⇧⌘P」,点转到文件打开文件选择器', () => {
    useWorkspaceStore.setState({ root: '/ws' });
    render(<EditorWelcome />);
    expect(screen.queryByRole('button', { name: new RegExp(t('editor.welcome.open_folder')) })).toBeNull();
    const qo = screen.getByRole('button', { name: new RegExp(t('editor.welcome.quick_open')) });
    expect(keycaps(qo)).toEqual(['⌘', 'P']);
    fireEvent.click(qo);
    expect(useQuickOpenStore.getState().isOpen).toBe(true);
  });
});

// VSCode 有工作区时的水印还列 Find in Files / Toggle Terminal:首次使用时终端与全局搜索也有入口。
describe('EditorWelcome · 有工作区:在文件中查找 / 新建终端', () => {
  const FIND = { id: 'workbench.action.findInFiles', hotkey: 'mod+shift+f' } as const;
  const TERMINAL = { id: 'terminal.new', hotkey: 'mod+t' } as const;
  /** 注册两条命令(核心插件里的同 id / 默认键)。 */
  function registerCommands(find = vi.fn(), terminal = vi.fn()) {
    const regs = [
      coApp.commands.register({ ...FIND, title: 'Find in Files', fn: find }),
      coApp.commands.register({ ...TERMINAL, title: 'New Terminal', fn: terminal }),
    ];
    return { find, terminal, dispose: () => regs.forEach((r) => r.dispose()) };
  }
  const findName = () => new RegExp(t('editor.welcome.find_in_files'));
  const terminalName = () => new RegExp(t('editor.welcome.new_terminal'));

  it('列「在文件中查找 ⇧⌘F」「新建终端 ⌘T」,顺序:转到文件 → 在文件中查找 → 新建终端 → 显示所有命令', () => {
    useWorkspaceStore.setState({ root: '/ws' });
    const cmds = registerCommands();
    try {
      const { container } = render(<EditorWelcome />);
      expect(keycaps(screen.getByRole('button', { name: findName() }))).toEqual(['⇧', '⌘', 'F']);
      expect(keycaps(screen.getByRole('button', { name: terminalName() }))).toEqual(['⌘', 'T']);
      const order = [...container.querySelectorAll('[data-welcome-action]')].map((b) => b.getAttribute('data-welcome-action'));
      expect(order).toEqual(['quick-open', 'find-in-files', 'new-terminal', 'show-commands']);
    } finally {
      cmds.dispose();
    }
  });

  it('点击执行已注册的对应命令', () => {
    useWorkspaceStore.setState({ root: '/ws' });
    const cmds = registerCommands();
    try {
      render(<EditorWelcome />);
      fireEvent.click(screen.getByRole('button', { name: findName() }));
      expect(cmds.find).toHaveBeenCalledTimes(1);
      fireEvent.click(screen.getByRole('button', { name: terminalName() }));
      expect(cmds.terminal).toHaveBeenCalledTimes(1);
    } finally {
      cmds.dispose();
    }
  });

  it('快捷键取实际生效绑定:改键后跟随、解绑后不显示、被别的命令抢占(冲突落败)后不显示', () => {
    useWorkspaceStore.setState({ root: '/ws' });
    const cmds = registerCommands();
    try {
      render(<EditorWelcome />);
      act(() => useKeybindingsStore.getState().setHotkey(TERMINAL.id, 'mod+alt+j'));
      expect(keycaps(screen.getByRole('button', { name: terminalName() }))).toEqual(['⌥', '⌘', 'J']);
      act(() => useKeybindingsStore.getState().setHotkey(TERMINAL.id, ''));
      expect(keycaps(screen.getByRole('button', { name: terminalName() }))).toEqual([]);
      // 别的命令改绑到 ⇧⌘F:按下执行它(后者胜)→「在文件中查找」不再显示 ⇧⌘F
      const other = coApp.commands.register({ id: 'test.other', title: 'Other', hotkey: 'mod+alt+o', fn: vi.fn() });
      try {
        act(() => useKeybindingsStore.getState().setHotkey('test.other', 'mod+shift+f'));
        expect(keycaps(screen.getByRole('button', { name: findName() }))).toEqual([]);
      } finally {
        other.dispose();
      }
    } finally {
      cmds.dispose();
    }
  });

  it('命令晚于界面注册 → 补上这两行(订阅命令注册表)', () => {
    useWorkspaceStore.setState({ root: '/ws' });
    render(<EditorWelcome />);
    expect(screen.queryByRole('button', { name: findName() })).toBeNull();
    let cmds: ReturnType<typeof registerCommands> | undefined;
    act(() => {
      cmds = registerCommands();
    });
    try {
      expect(keycaps(screen.getByRole('button', { name: findName() }))).toEqual(['⇧', '⌘', 'F']);
      expect(screen.getByRole('button', { name: terminalName() })).toBeTruthy();
    } finally {
      cmds?.dispose();
    }
  });

  it('无工作区不列这两行', () => {
    const cmds = registerCommands();
    try {
      render(<EditorWelcome />);
      expect(screen.queryByRole('button', { name: findName() })).toBeNull();
      expect(screen.queryByRole('button', { name: terminalName() })).toBeNull();
    } finally {
      cmds.dispose();
    }
  });
});

describe('EditorWelcome · 文案与命令标题一致', () => {
  // VSCode 水印同款:水印项 = 对应命令标题去掉末尾「…」(命令面板 / 快捷键页显示「转到文件…」,水印显示「转到文件」)。
  it.each([
    ['en', en],
    ['zh', zh],
    ['ko', ko],
  ] as const)('%s', (_locale, catalog) => {
    const pairs = [
      ['editor.welcome.open_folder', 'commands.file.open_folder.title'],
      ['editor.welcome.quick_open', 'commands.quick_open.title'],
      ['editor.welcome.show_commands', 'commands.show_commands.title'],
      ['editor.welcome.find_in_files', 'commands.search.find_in_files.title'],
      ['editor.welcome.new_terminal', 'commands.terminal.new.title'],
    ] as const;
    for (const [watermark, command] of pairs) {
      expect(catalog[watermark], watermark).toBe(catalog[command].replace(/…$/, ''));
    }
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
