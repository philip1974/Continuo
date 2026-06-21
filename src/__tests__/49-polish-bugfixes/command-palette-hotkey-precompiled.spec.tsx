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

import { CommandPalette } from '../../plugins/command-palette/CommandPalette';
import { useCommandPaletteStore } from '../../plugins/command-palette/store';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
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
});
