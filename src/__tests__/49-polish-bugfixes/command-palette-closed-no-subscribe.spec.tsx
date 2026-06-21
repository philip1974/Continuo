// @vitest-environment jsdom
// 打磨 R32(codex 性能):CommandPalette 常驻挂在 App 顶层。拆成 shell + body 后,
// 关闭状态(isOpen=false)下不挂载 CommandPaletteBody → 不订阅 commands registry
// (也不订阅 recent/overrides/locale、不重算 display/filter)。仅打开时才订阅+派生。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 30,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({ index: i, start: i * 30, size: 30, key: i })),
    scrollToIndex: vi.fn(),
  }),
}));
import { render, cleanup, act } from '@testing-library/react';
import { CommandPalette } from '../../plugins/command-palette/CommandPalette';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';

beforeEach(() => {
  useCommandPaletteStore.setState({ isOpen: false, query: '', selectedIndex: 0 });
});
afterEach(() => cleanup());

describe('打磨 R32 — 关闭时不订阅命令 registry', () => {
  it('isOpen=false → body 不挂载,commands.subscribe 不被调用', () => {
    const reg = new CommandRegistry();
    const subSpy = vi.spyOn(reg, 'subscribe');
    render(<CommandPalette commands={reg} />);
    expect(subSpy).not.toHaveBeenCalled();
    // 也无列表 DOM
    expect(document.querySelector('[role=listbox]')).toBeNull();
  });

  it('open() → body 挂载,开始订阅 registry + 渲染列表', () => {
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', fn: vi.fn() });
    const subSpy = vi.spyOn(reg, 'subscribe');
    render(<CommandPalette commands={reg} />);
    expect(subSpy).not.toHaveBeenCalled();

    act(() => useCommandPaletteStore.getState().open());
    expect(subSpy).toHaveBeenCalled();
    expect(document.querySelector('[role=listbox]')).not.toBeNull();
  });
});
