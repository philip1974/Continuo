// @vitest-environment jsdom
// 打磨 R48(codex 性能):CommandPalette 列表虚拟化(复用 QuickOpen R25 模式)。
// 只渲染 virtualizer 给的可视窗口行,而非把 filtered 全集一次性 map 成 <li>。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { scrollToIndexSpy, virtualizerSpy } = vi.hoisted(() => ({
  scrollToIndexSpy: vi.fn(),
  virtualizerSpy: vi.fn(),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => {
    virtualizerSpy(opts.count);
    return {
      getTotalSize: () => opts.count * 30,
      getVirtualItems: () =>
        [0, 1, 2]
          .filter((i) => i < opts.count)
          .map((i) => ({ index: i, start: i * 30, size: 30, key: i })),
      scrollToIndex: scrollToIndexSpy,
    };
  },
}));

import { render, cleanup, act, fireEvent } from '@testing-library/react';
import { CommandPalette } from '../../plugins/command-palette/CommandPalette';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';

function makeReg(n: number): CommandRegistry {
  const r = new CommandRegistry();
  for (let i = 0; i < n; i++) {
    r.register({ id: `cmd${i}`, title: `Command ${i}`, fn: vi.fn() });
  }
  return r;
}

beforeEach(() => {
  scrollToIndexSpy.mockClear();
  virtualizerSpy.mockClear();
  useCommandPaletteStore.setState({ isOpen: false, query: '', selectedIndex: 0 });
});
afterEach(() => cleanup());

describe('打磨 R48 — CommandPalette 虚拟化', () => {
  it('100 命令 → 只渲染窗口(3 行),virtualizer count = 全集', () => {
    render(<CommandPalette commands={makeReg(100)} />);
    act(() => useCommandPaletteStore.getState().open());
    expect(document.querySelectorAll('[role=option]').length).toBe(3);
    expect(virtualizerSpy).toHaveBeenCalledWith(100);
  });

  it('键盘下移 → scrollToIndex 跟随选中行', () => {
    render(<CommandPalette commands={makeReg(50)} />);
    act(() => useCommandPaletteStore.getState().open());
    const input = document.querySelector('input')!;
    act(() => {
      fireEvent.keyDown(input, { key: 'ArrowDown' });
    });
    expect(scrollToIndexSpy).toHaveBeenCalled();
  });
});
