// @vitest-environment jsdom
// 打磨 R28(codex 性能):CommandPalette 把 effective hotkey 段预计算进
// displayCommands(deps: allCommands/tk/overrides),行渲染只读 d.hotkeyParts。
// selectedIndex 改变(ArrowUp/Down)让整列重渲时,不再逐行调 getEffectiveHotkey。
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

vi.mock('../../notifications/notify', () => ({ notify: { error: vi.fn() } }));

vi.mock('../../plugins/keybindings/keybindings-store', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../plugins/keybindings/keybindings-store')
    >();
  return { ...actual, getEffectiveHotkey: vi.fn(actual.getEffectiveHotkey) };
});

import {
  buildDisplayCommands,
  CommandPalette,
} from '../../plugins/command-palette/CommandPalette';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import type { CommandSpec } from '../../plugins/registries/CommandRegistry';
import {
  getEffectiveHotkey,
  useKeybindingsStore,
} from '../../plugins/keybindings/keybindings-store';

const getEffSpy = getEffectiveHotkey as unknown as ReturnType<typeof vi.fn>;

function makeReg(): CommandRegistry {
  const r = new CommandRegistry();
  r.register({ id: 'a', title: 'A', hotkey: 'mod+a', fn: vi.fn() });
  r.register({ id: 'b', title: 'B', hotkey: 'mod+b', fn: vi.fn() });
  r.register({ id: 'c', title: 'C', hotkey: 'mod+c', fn: vi.fn() });
  return r;
}

beforeEach(() => {
  useCommandPaletteStore.setState({ isOpen: false, query: '', selectedIndex: 0 });
  useKeybindingsStore.setState({ overrides: {} });
  getEffSpy.mockClear();
});
afterEach(() => cleanup());

describe('打磨 R28 — CommandPalette hotkey 预计算', () => {
  it('displayCommands 构造预分配数组,不调用 allCommands.map', () => {
    const commands: CommandSpec[] = [
      { id: 'a', title: 'A', hotkey: 'mod+a', fn: vi.fn() },
      { id: 'b', title: 'B', category: 'Tools', fn: vi.fn() },
    ];
    const mapSpy = vi.spyOn(commands, 'map');
    try {
      const out = buildDisplayCommands(
        commands,
        (_key, fallback) => fallback,
        'other',
      );

      expect(out.map((d) => d.cmd.id)).toEqual(['a', 'b']);
      expect(out[0]?.hotkeyParts).toEqual(['Ctrl', 'A']);
      expect(out[1]?.matchSourceLower).toBe('tools b');
      expect(mapSpy).not.toHaveBeenCalled();
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('selectedIndex 变化 → 不再逐行调 getEffectiveHotkey', () => {
    render(<CommandPalette commands={makeReg()} />);
    act(() => useCommandPaletteStore.getState().open());
    const afterOpen = getEffSpy.mock.calls.length;
    expect(afterOpen).toBeGreaterThan(0); // 预计算时调过

    // ↓↓↓ 改 selectedIndex,整列重渲但 hotkey 已预计算,不应再调
    act(() => useCommandPaletteStore.getState().moveSelection(1, 3));
    act(() => useCommandPaletteStore.getState().moveSelection(1, 3));

    expect(getEffSpy.mock.calls.length).toBe(afterOpen);
  });

  it('hotkey 段仍正确渲染(预计算结果)', () => {
    render(<CommandPalette commands={makeReg()} />);
    act(() => useCommandPaletteStore.getState().open());
    const firstRow = document.querySelector('.wm-modal-content li')!;
    // mod 平台感知:jsdom='other' → Ctrl;KeyCap 含 A
    expect(firstRow.textContent).toContain('A');
  });

  it('搜索输入变化 → 不再逐行 lower-case fuzzy target', () => {
    render(<CommandPalette commands={makeReg()} />);
    act(() => useCommandPaletteStore.getState().open());
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    act(() => useCommandPaletteStore.getState().setQuery('a'));
    act(() => useCommandPaletteStore.getState().setQuery('ab'));

    const contexts = lowerSpy.mock.contexts.map((ctx) => String(ctx));
    lowerSpy.mockRestore();
    expect(contexts.some((ctx) => ctx === 'A')).toBe(false);
    expect(contexts.some((ctx) => ctx === 'B')).toBe(false);
    expect(contexts.some((ctx) => ctx === 'C')).toBe(false);
  });
});
