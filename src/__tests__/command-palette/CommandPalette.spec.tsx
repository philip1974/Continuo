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

import { CommandPalette } from '../../plugins/command-palette/CommandPalette';
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
