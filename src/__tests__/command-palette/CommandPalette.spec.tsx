// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ index: i, start: i * 30, size: 30, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));
import { fireEvent, render, cleanup, act } from '@testing-library/react';

const notifyError = vi.fn();
vi.mock('../../notifications/notify', () => ({
  notify: { error: (...a: unknown[]) => notifyError(...a) },
}));

import {
  CommandPalette,
  commandPaletteRowClassName,
} from '../../plugins/command-palette/CommandPalette';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';

beforeEach(() => {
  useCommandPaletteStore.setState({
    isOpen: false,
    query: '',
    selectedIndex: 0,
  });
});
afterEach(() => cleanup());

function makeReg(): CommandRegistry {
  const r = new CommandRegistry();
  r.register({ id: 'save.file', title: '保存文件', hotkey: 'mod+s', fn: vi.fn() });
  r.register({ id: 'open.folder', title: '打开文件夹', fn: vi.fn() });
  r.register({ id: 'quit.app', title: '退出应用', fn: vi.fn() });
  return r;
}

describe('CommandPalette UI', () => {
  it('行 className 不通过数组 join 重建', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');

    try {
      expect(commandPaletteRowClassName(true)).toContain('bg-hover text-fg');
      expect(commandPaletteRowClassName(false)).toContain(
        'text-fg-muted hover:bg-hover/50',
      );
      expect(joinSpy).not.toHaveBeenCalled();
    } finally {
      joinSpy.mockRestore();
    }
  });

  it('isOpen=false → 不渲染 Modal 内容', () => {
    const { container } = render(<CommandPalette commands={makeReg()} />);
    expect(container.querySelector('.wm-modal-content')).toBeNull();
  });

  it('open 后渲染 Input + 全部命令', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const items = document.querySelectorAll('.wm-modal-content li');
    expect(items.length).toBe(3);
    expect(items[0]!.textContent).toContain('保存文件');
  });

  // a11y(A1):搜索框须有稳定可访问名(aria-label),否则屏幕阅读器聚焦时只读「编辑框」无名。
  // placeholder 不算可靠可访问名。locale-无关:断言 aria-label 非空且与 placeholder 一致。
  it('a11y · 搜索 Input 有 aria-label 可访问名(非仅 placeholder)', () => {
    render(<CommandPalette commands={makeReg()} />);
    act(() => useCommandPaletteStore.getState().open());
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();
    const ariaLabel = input!.getAttribute('aria-label') ?? '';
    expect(ariaLabel.length).toBeGreaterThan(0);
    expect(ariaLabel).toBe(input!.getAttribute('placeholder'));
  });

  // a11y(A15):combobox 模式 —— input 经 aria-activedescendant 指向当前高亮 option(焦点
  // 留 input),否则屏幕阅读器按上下键不知高亮哪条。断言 role=combobox + activedescendant
  // 指向存在的 option,且随 selectedIndex 移动。
  it('a11y · input 是 combobox,aria-activedescendant 跟随 selectedIndex', () => {
    render(<CommandPalette commands={makeReg()} />);
    act(() => useCommandPaletteStore.getState().open());
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-controls')).toBe('command-palette-listbox');
    const ad0 = input.getAttribute('aria-activedescendant');
    expect(ad0).toBe('command-palette-option-0');
    expect(document.getElementById(ad0!)).not.toBeNull(); // 指向真实存在的 option
    act(() => useCommandPaletteStore.setState({ selectedIndex: 1 }));
    expect(input.getAttribute('aria-activedescendant')).toBe(
      'command-palette-option-1',
    );
    // a11y(A111):selectedIndex 越界(结果变短遗留旧下标)→ aria-activedescendant 须移除,
    // 不能指向不存在的 option id。
    act(() => useCommandPaletteStore.setState({ selectedIndex: 999 }));
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('输入 query → fuzzy 过滤', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    act(() => useCommandPaletteStore.getState().setQuery('退出'));
    const items = document.querySelectorAll('.wm-modal-content li');
    expect(items.length).toBe(1);
    expect(items[0]!.textContent).toContain('退出应用');
  });

  it('无匹配 → 显空态文案', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    act(() => useCommandPaletteStore.getState().setQuery('xyzabc'));
    expect(
      document.querySelector('.wm-modal-content')!.textContent,
    ).toContain('无匹配');
    // a11y(A56):空态须在 live region(role=status)播报「无匹配」,焦点在搜索框时也能听到。
    const status = document.querySelector('.wm-modal-content [role=status]');
    expect(status).not.toBeNull();
    expect(status!.textContent).toContain('无匹配');
    // a11y(A100):无结果时 combobox 仍是展开态(弹层可见显示空态),aria-expanded 须保持 true,
    // 不能随结果数变 false(否则与可见状态矛盾);aria-activedescendant 此时移除。
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-activedescendant')).toBeNull();
    // a11y(A101):listbox 不存在(无结果)→ aria-controls 移除,避免引用悬空。
    expect(input.getAttribute('aria-controls')).toBeNull();
  });

  it('点击命令行 → 执行 fn 并关闭', async () => {
    const reg = new CommandRegistry();
    const fn = vi.fn();
    reg.register({ id: 'do.it', title: 'Do It', fn });
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const li = document.querySelector('.wm-modal-content li')!;
    fireEvent.click(li);
    // close synchronously, fn runs after
    await Promise.resolve();
    expect(fn).toHaveBeenCalled();
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('显示 hotkey 后缀(KeyCap 渲染:jsdom → other → 多个 kbd 拼成 "CtrlS")', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const firstLi = document.querySelector('.wm-modal-content li')!;
    // jsdom navigator.platform 默认空,detectPlatform 返 'other';
    // KeyCap 拆开 ['Ctrl', 'S'] 各自一个 kbd,textContent 串起来 = "CtrlS"
    const kbds = firstLi.querySelectorAll('kbd.wm-keycap');
    expect(kbds.length).toBe(2);
    expect(kbds[0]?.textContent).toBe('Ctrl');
    expect(kbds[1]?.textContent).toBe('S');
  });
});

describe('CommandPalette · 键盘 + 空 query 排序', () => {
  it('ArrowDown / ArrowUp → 移动 selectedIndex', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(1);
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(useCommandPaletteStore.getState().selectedIndex).toBe(0);
  });

  it('Enter → 执行选中命令 + 关闭', async () => {
    const reg = new CommandRegistry();
    const fn = vi.fn();
    reg.register({ id: 'do', title: 'Do', fn });
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const input = document.querySelector(
      '.wm-modal-content input',
    ) as HTMLInputElement;
    fireEvent.keyDown(input, { key: 'Enter' });
    await Promise.resolve();
    expect(fn).toHaveBeenCalled();
    expect(useCommandPaletteStore.getState().isOpen).toBe(false);
  });

  it('完全没注册任何命令 → 「暂无可用命令」', () => {
    const reg = new CommandRegistry();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    expect(
      document.querySelector('.wm-modal-content')!.textContent,
    ).toContain('暂无可用命令');
  });

  it('category 显示 "Category:" 前缀 + 同时被 fuzzy 匹配', () => {
    const reg = new CommandRegistry();
    reg.register({
      id: 's.open',
      title: 'Open',
      category: 'Settings',
      fn: vi.fn(),
    });
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const li = document.querySelector('.wm-modal-content li')!;
    expect(li.textContent).toContain('Settings');

    // fuzzy 用 "settings" 也能命中
    act(() =>
      useCommandPaletteStore.getState().setQuery('settings'),
    );
    expect(document.querySelectorAll('.wm-modal-content li').length).toBe(1);
  });

  it('subscribe registry → 后注册的命令立即出现在列表', () => {
    const reg = new CommandRegistry();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    expect(
      document.querySelector('.wm-modal-content')!.textContent,
    ).toContain('暂无可用命令');

    act(() => {
      reg.register({ id: 'late', title: 'Late', fn: vi.fn() });
    });
    expect(
      document.querySelector('.wm-modal-content')!.textContent,
    ).toContain('Late');
  });

  // 第二十一轮 P1-AX:命令抛错不再静默 console.warn,而是经 notify.error 弹给用户
  // (面板已关,旧实现下用户看不到任何失败反馈)。
  it('execute 命令抛错 → notify.error(含 title),UI 不抛', async () => {
    notifyError.mockReset();
    const reg = new CommandRegistry();
    reg.register({
      id: 'bad',
      title: 'Bad',
      fn: () => {
        throw new Error('boom');
      },
    });
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const li = document.querySelector('.wm-modal-content li')!;
    fireEvent.click(li);
    // 等 microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyError).toHaveBeenCalled();
    expect(String(notifyError.mock.calls[0]?.[0])).toContain('Bad');
    expect(String(notifyError.mock.calls[0]?.[0])).toContain('boom');
  });
});
