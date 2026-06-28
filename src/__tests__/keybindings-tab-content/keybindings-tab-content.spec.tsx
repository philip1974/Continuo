// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import {
  KeybindingsTabContent,
  buildCommandSearchHaystack,
  groupByCategory,
  selectVisibleKeybindingCommands,
  type DisplayCommand,
} from '../../plugins/settings/KeybindingsTabContent';
import { coApp } from '../../plugins/co-app';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';

beforeEach(() => {
  (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
  useKeybindingsStore.setState({ overrides: {} });
});

afterEach(() => cleanup());

describe('KeybindingsTabContent — 列表', () => {
  it('搜索框 placeholder label 复用,aria-label 与 placeholder 不重复查 catalog', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/settings/KeybindingsTabContent.tsx'),
      'utf8',
    );

    expect(src).toContain('const searchPlaceholderLabel = t(');
    expect(src).toContain('aria-label={searchPlaceholderLabel}');
    expect(src).toContain('placeholder={searchPlaceholderLabel}');
    expect(src).not.toContain("aria-label={t('keybindings.search_placeholder')}");
    expect(src).not.toContain("placeholder={t('keybindings.search_placeholder')}");
  });

  it('行内固定 label 在 render 内复用,不随每个命令重复查 catalog', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/settings/KeybindingsTabContent.tsx'),
      'utf8',
    );

    expect(src).toContain("const unboundLabel = t('keybindings.unbound');");
    expect(src).toContain("const editHotkeyLabel = t('keybindings.edit_hotkey');");
    expect(src).toContain('{unboundLabel}');
    expect(src).toContain('title={editHotkeyLabel}');
    expect(src).toContain('hotkey: cmd.hotkey ?? unboundLabel');
    expect(src).not.toContain("{t('keybindings.unbound')}");
    expect(src).not.toContain("title={t('keybindings.edit_hotkey')}");
    expect(src).not.toContain("cmd.hotkey ?? t('keybindings.unbound')");
  });

  it('行按钮 icon 预创建,不随每个命令重复创建 svg element', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/plugins/settings/KeybindingsTabContent.tsx'),
      'utf8',
    );

    expect(src).toContain('const EDIT_HOTKEY_ICON = (');
    expect(src).toContain('const RESET_HOTKEY_ICON = (');
    expect(src).toContain('{EDIT_HOTKEY_ICON}');
    expect(src).toContain('{RESET_HOTKEY_ICON}');
  });

  it('一条命令都没注册 → 「暂无注册了快捷键的命令」', () => {
    const { container } = render(<KeybindingsTabContent />);
    expect(container.textContent).toContain('暂无注册了快捷键的命令');
  });

  it('注册的命令都没 hotkey → 仍空态', () => {
    coApp.commands.register({ id: 'a', title: 'A', fn: vi.fn() });
    const { container } = render(<KeybindingsTabContent />);
    expect(container.textContent).toContain('暂无注册了快捷键的命令');
  });

  it('有 hotkey 的命令 → 列出 + 显示 hotkey 切片', () => {
    coApp.commands.register({
      id: 'a',
      title: 'Save',
      hotkey: 'mod+s',
      category: 'Editor',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    expect(container.textContent).toContain('Save');
    expect(container.textContent).toContain('Editor');
    // KeyCap 切片含 S 字符
    expect(container.textContent).toMatch(/S/);
  });

  // a11y(A76,A75 同族):多命令行的编辑/重置按钮可访问名须含命令名以区分(否则全读「编辑快捷键」)。
  it('a11y · 编辑按钮 aria-label 含命令名(多行可区分)', () => {
    coApp.commands.register({
      id: 'save',
      title: 'Save',
      hotkey: 'mod+s',
      category: 'X',
      fn: vi.fn(),
    });
    coApp.commands.register({
      id: 'open',
      title: 'Open',
      hotkey: 'mod+o',
      category: 'X',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    const editLabels = Array.from(container.querySelectorAll('button'))
      .map((b) => b.getAttribute('aria-label') ?? '')
      .filter((l) => l.includes('编辑'));
    expect(editLabels.some((l) => l.includes('Save'))).toBe(true);
    expect(editLabels.some((l) => l.includes('Open'))).toBe(true);
  });

  it('category 缺 → 归「其他」分组', () => {
    coApp.commands.register({
      id: 'misc',
      title: 'Misc',
      hotkey: 'mod+m',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    expect(
      Array.from(container.querySelectorAll('h3')).map((h) => h.textContent),
    ).toContain('其他');
  });

  it('同 category 内按 title 字母序', () => {
    coApp.commands.register({
      id: 'b',
      title: 'Beta',
      hotkey: 'mod+b',
      category: 'X',
      fn: vi.fn(),
    });
    coApp.commands.register({
      id: 'a',
      title: 'Alpha',
      hotkey: 'mod+a',
      category: 'X',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    const items = container.querySelectorAll('li');
    expect(items[0]!.textContent).toContain('Alpha');
    expect(items[1]!.textContent).toContain('Beta');
  });
});

describe('KeybindingsTabContent — 搜索', () => {
  it('已小写搜索 haystack 源不调用 toLowerCase', () => {
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    try {
      expect(buildCommandSearchHaystack('save', 'file', 'cmd.save', 'mod+s')).toBe(
        'save file cmd.save mod+s',
      );
      expect(
        lowerSpy.mock.contexts.some(
          (ctx) => String(ctx) === 'save file cmd.save mod+s',
        ),
      ).toBe(false);
      expect(buildCommandSearchHaystack('Save', 'File', 'CMD.Save', 'MOD+S')).toBe(
        'save file cmd.save mod+s',
      );
    } finally {
      lowerSpy.mockRestore();
    }
  });

  it('空 query 且全部命令可见时复用输入引用,不做 query lowercase', () => {
    const commands = [
      {
        cmd: {
          id: 'a',
          title: 'Save',
          hotkey: 'mod+s',
          fn: vi.fn(),
        },
        displayTitle: 'Save',
        displayCategory: '',
        effectiveHotkey: 'mod+s',
        hotkeyParts: ['⌘', 'S'],
        isOverridden: false,
        searchHaystack: 'save a mod+s',
      },
    ] satisfies readonly DisplayCommand[];
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    try {
      expect(selectVisibleKeybindingCommands(commands, '')).toBe(commands);
      expect(lowerSpy).not.toHaveBeenCalled();
    } finally {
      lowerSpy.mockRestore();
    }
  });

  it('小写 query 搜索不调用 toLowerCase', () => {
    const commands = [
      {
        cmd: {
          id: 'a',
          title: 'Save',
          hotkey: 'mod+s',
          fn: vi.fn(),
        },
        displayTitle: 'Save',
        displayCategory: '',
        effectiveHotkey: 'mod+s',
        hotkeyParts: ['⌘', 'S'],
        isOverridden: false,
        searchHaystack: 'save a mod+s',
      },
    ] satisfies readonly DisplayCommand[];
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    try {
      expect(selectVisibleKeybindingCommands(commands, 'save')).toEqual([
        commands[0],
      ]);
      expect(
        lowerSpy.mock.contexts.some((ctx) => String(ctx) === 'save'),
      ).toBe(false);
      expect(selectVisibleKeybindingCommands(commands, 'SAVE')).toEqual([
        commands[0],
      ]);
    } finally {
      lowerSpy.mockRestore();
    }
  });

  it('过滤掉无 hotkey/override 命令时返回新数组', () => {
    const visible = {
      cmd: {
        id: 'a',
        title: 'Save',
        hotkey: 'mod+s',
        fn: vi.fn(),
      },
      displayTitle: 'Save',
      displayCategory: '',
      effectiveHotkey: 'mod+s',
      hotkeyParts: ['⌘', 'S'],
      isOverridden: false,
      searchHaystack: 'save a mod+s',
    } satisfies DisplayCommand;
    const hidden = {
      cmd: {
        id: 'b',
        title: 'No Hotkey',
        fn: vi.fn(),
      },
      displayTitle: 'No Hotkey',
      displayCategory: '',
      effectiveHotkey: undefined,
      hotkeyParts: [],
      isOverridden: false,
      searchHaystack: 'no hotkey b',
    } satisfies DisplayCommand;
    const commands = [visible, hidden] satisfies readonly DisplayCommand[];

    const selected = selectVisibleKeybindingCommands(commands, '');
    expect(selected).not.toBe(commands);
    expect(selected).toEqual([visible]);
  });

  it('单个分组单个命令时走快路径,不构造 Map 且不调用 sort', () => {
    const commands = [
      {
        cmd: {
          id: 'a',
          title: 'Save',
          hotkey: 'mod+s',
          fn: vi.fn(),
        },
        displayTitle: 'Save',
        displayCategory: 'Editor',
        effectiveHotkey: 'mod+s',
        hotkeyParts: ['⌘', 'S'],
        isOverridden: false,
        searchHaystack: 'save editor a mod+s',
      },
    ] satisfies readonly DisplayCommand[];
    const mapGetSpy = vi.spyOn(Map.prototype, 'get');
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const buckets = groupByCategory(commands, '其他');
      expect(buckets).toHaveLength(1);
      expect(buckets[0]?.items).toBe(commands);
      expect(mapGetSpy).not.toHaveBeenCalled();
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      mapGetSpy.mockRestore();
      sortSpy.mockRestore();
    }
  });

  it('空命令分组 → 稳定空 buckets,不构造 Map', () => {
    const mapGetSpy = vi.spyOn(Map.prototype, 'get');

    try {
      expect(groupByCategory([], '其他')).toEqual([]);
      expect(groupByCategory([], '其他')).toBe(groupByCategory([], 'Other'));
      expect(mapGetSpy).not.toHaveBeenCalled();
    } finally {
      mapGetSpy.mockRestore();
    }
  });

  it('query 过滤 title 大小写不敏感', () => {
    coApp.commands.register({
      id: 'a',
      title: 'Save File',
      hotkey: 'mod+s',
      fn: vi.fn(),
    });
    coApp.commands.register({
      id: 'b',
      title: 'Open File',
      hotkey: 'mod+o',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'save' } });
    expect(container.textContent).toContain('Save File');
    expect(container.textContent).not.toContain('Open File');
  });

  it('过滤后无匹配 → 「无匹配命令」', () => {
    coApp.commands.register({
      id: 'a',
      title: 'A',
      hotkey: 'mod+a',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(container.textContent).toContain('无匹配命令');
    // a11y(A57):空态须在 live region(role=status)播报无匹配,焦点在搜索框时也能听到。
    const status = container.querySelector('[role=status]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain('无匹配命令');
  });

  it('query 匹配 hotkey', () => {
    coApp.commands.register({
      id: 'a',
      title: 'Save',
      hotkey: 'mod+shift+x',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    const input = container.querySelector('input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'shift' } });
    expect(container.textContent).toContain('Save');
  });
});

describe('KeybindingsTabContent — override', () => {
  it('未 override → reset 按钮 invisible', () => {
    coApp.commands.register({
      id: 'a',
      title: 'A',
      hotkey: 'mod+a',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    const resetBtn = container.querySelector(
      'button[aria-label*="恢复默认"]',
    ) as HTMLButtonElement;
    expect(resetBtn.className).toContain('invisible');
  });

  it('已 override → reset 可见 + 点击调 store.reset', () => {
    coApp.commands.register({
      id: 'a',
      title: 'A',
      hotkey: 'mod+a',
      fn: vi.fn(),
    });
    useKeybindingsStore.setState({ overrides: { a: 'mod+x' } });
    const { container } = render(<KeybindingsTabContent />);
    const resetBtn = container.querySelector(
      'button[aria-label*="恢复默认"]',
    ) as HTMLButtonElement;
    expect(resetBtn.className).not.toContain('invisible');
    fireEvent.click(resetBtn);
    expect(useKeybindingsStore.getState().overrides.a).toBeUndefined();
  });

  it('显式 unbind 空字符串 → hotkey 显「未绑定」', () => {
    coApp.commands.register({
      id: 'a',
      title: 'A',
      hotkey: 'mod+a',
      fn: vi.fn(),
    });
    useKeybindingsStore.setState({ overrides: { a: '' } });
    const { container } = render(<KeybindingsTabContent />);
    expect(container.textContent).toContain('未绑定');
  });

  // 打磨 R3:删除组件内多余的第二个 overrides 裸订阅后,保留的单订阅必须仍能在
  // 挂载后 live setHotkey/reset 时触发重渲(reset 按钮可见性)。
  it('挂载后 live override(setHotkey)→ 组件重渲,reset 按钮变可见', () => {
    coApp.commands.register({
      id: 'a',
      title: 'A',
      hotkey: 'mod+a',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    const resetBtn0 = container.querySelector(
      'button[aria-label*="恢复默认"]',
    ) as HTMLButtonElement;
    expect(resetBtn0.className).toContain('invisible');

    act(() => {
      useKeybindingsStore.getState().setHotkey('a', 'mod+x');
    });

    const resetBtn1 = container.querySelector(
      'button[aria-label*="恢复默认"]',
    ) as HTMLButtonElement;
    expect(resetBtn1.className).not.toContain('invisible');
  });
});

describe('KeybindingsTabContent — 编辑 Modal', () => {
  it('点编辑按钮 → 弹出 Modal,onSave 调 store.setHotkey', () => {
    coApp.commands.register({
      id: 'a',
      title: 'A',
      hotkey: 'mod+a',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    const editBtn = container.querySelector(
      'button[aria-label*="编辑"]',
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);
    expect(document.querySelector('.wm-modal-content')).not.toBeNull();

    // 模拟用户按下新组合。R16:eventToCombo 平台感知,jsdom(detectPlatform()='other')下
    // 'mod' 主修饰键 = Ctrl,故用 ctrlKey → 编成 'mod+k'。
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'k',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    const saveBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.wm-modal-content button'),
    ).find((b) => b.textContent === '保存')!;
    fireEvent.click(saveBtn);
    expect(useKeybindingsStore.getState().overrides.a).toBe('mod+k');
  });
});

describe('race(R50) — 编辑弹窗打开期间命令被移除', () => {
  it('插件 reload/disable 移除命令 → 自动关闭弹窗,不写 override 到已不存在命令', () => {
    const disp = coApp.commands.register({
      id: 'a',
      title: 'A',
      hotkey: 'mod+a',
      fn: vi.fn(),
    });
    const { container } = render(<KeybindingsTabContent />);
    const editBtn = container.querySelector(
      'button[aria-label*="编辑"]',
    ) as HTMLButtonElement;
    fireEvent.click(editBtn);
    expect(document.querySelector('.wm-modal-content')).not.toBeNull();

    // 弹窗打开期间插件 reload/disable 把命令移出 registry。
    act(() => {
      disp.dispose();
    });

    // R50:命令从 allCommands 消失 → 弹窗自动关闭,不会对已不存在的命令写 override。
    expect(document.querySelector('.wm-modal-content')).toBeNull();
    expect(useKeybindingsStore.getState().overrides.a).toBeUndefined();
  });
});

describe('KeybindingsTabContent — overrides 让 unbound 命令也显示', () => {
  it('原本无 hotkey + override 加了一个 → 列表里显示', () => {
    coApp.commands.register({ id: 'a', title: 'A', fn: vi.fn() });
    useKeybindingsStore.setState({ overrides: { a: 'mod+x' } });
    const { container } = render(<KeybindingsTabContent />);
    expect(container.textContent).toContain('A');
  });
});

describe('KeybindingsTabContent — registry 订阅', () => {
  it('后注册命令立即出现', () => {
    const { container } = render(<KeybindingsTabContent />);
    expect(container.textContent).toContain('暂无');

    act(() => {
      coApp.commands.register({
        id: 'late',
        title: 'Late',
        hotkey: 'mod+l',
        fn: vi.fn(),
      });
    });
    expect(container.textContent).toContain('Late');
  });
});

describe('KeybindingsTabContent — 计数', () => {
  it('显示有 hotkey 的命令总数', () => {
    coApp.commands.register({
      id: 'a',
      title: 'A',
      hotkey: 'mod+a',
      fn: vi.fn(),
    });
    coApp.commands.register({
      id: 'b',
      title: 'B',
      hotkey: 'mod+b',
      fn: vi.fn(),
    });
    coApp.commands.register({ id: 'c', title: 'C', fn: vi.fn() });
    const { container } = render(<KeybindingsTabContent />);
    expect(container.textContent).toMatch(/共\s*2\s*个/);
  });
});
