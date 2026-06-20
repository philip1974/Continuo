// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
import { KeybindingsTabContent } from '../../plugins/settings/KeybindingsTabContent';
import { coApp } from '../../plugins/co-app';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import { useKeybindingsStore } from '../../plugins/keybindings/keybindings-store';

beforeEach(() => {
  (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
  useKeybindingsStore.setState({ overrides: {} });
});

afterEach(() => cleanup());

describe('KeybindingsTabContent — 列表', () => {
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
      'button[aria-label=恢复默认]',
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
      'button[aria-label=恢复默认]',
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
      'button[aria-label=编辑快捷键]',
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
