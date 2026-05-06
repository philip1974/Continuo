// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, cleanup, act } from '@testing-library/react';
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

  it('显示 hotkey 后缀(formatHotkey 转后:jsdom navigator → other → "Ctrl+S")', () => {
    const reg = makeReg();
    render(<CommandPalette commands={reg} />);
    act(() => useCommandPaletteStore.getState().open());
    const firstLi = document.querySelector('.wm-modal-content li')!;
    // jsdom navigator.platform 默认空,detectPlatform 返 'other'
    expect(firstLi.textContent).toContain('Ctrl+S');
  });
});
