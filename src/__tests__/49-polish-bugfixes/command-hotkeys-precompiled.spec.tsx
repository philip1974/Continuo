// @vitest-environment jsdom
// 打磨 R26(codex 性能):全局命令 hotkey 匹配表预编译。原先每次 keydown 都遍历
// 命令逐条 getEffectiveHotkey + split/lowercase/Set 解析 combo;现在只在命令集 /
// overrides 变化时用 useMemo 预编译一次,keydown 路径只做字段比较。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

vi.mock('../../plugins/keybindings/keybindings-store', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../plugins/keybindings/keybindings-store')
    >();
  return { ...actual, getEffectiveHotkey: vi.fn(actual.getEffectiveHotkey) };
});

import {
  buildCompiledBindings,
  matchesHotkey,
  useCommandHotkeys,
} from '../../plugins/command-palette/useCommandHotkeys';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import {
  getEffectiveHotkey,
  useKeybindingsStore,
} from '../../plugins/keybindings/keybindings-store';

const getEffSpy = getEffectiveHotkey as unknown as ReturnType<typeof vi.fn>;

function fireKey(key: string): void {
  document.dispatchEvent(
    new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
  );
}

beforeEach(() => {
  useKeybindingsStore.setState({ overrides: {} });
  getEffSpy.mockClear();
});
afterEach(() => cleanup());

describe('打磨 R26 — 命令 hotkey 预编译', () => {
  it('hotkey 预编译不再通过 split/map/Set 解析组合键', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      expect(
        matchesHotkey(
          'mod+shift+h',
          new KeyboardEvent('keydown', {
            key: 'h',
            ctrlKey: true,
            shiftKey: true,
          }),
          'other',
        ),
      ).toBe(true);
      expect(splitSpy).not.toHaveBeenCalled();
    } finally {
      splitSpy.mockRestore();
    }
  });

  it('keydown 不再逐键调 getEffectiveHotkey(已移到预编译表)', () => {
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn: vi.fn() });
    reg.register({ id: 'b', title: 'B', hotkey: 'mod+p', fn: vi.fn() });
    renderHook(() => useCommandHotkeys(reg));

    const afterCompile = getEffSpy.mock.calls.length;
    expect(afterCompile).toBeGreaterThan(0); // 预编译时调过

    // 连打 5 个不相关的键:不应再触发任何 getEffectiveHotkey
    for (const k of ['x', 'y', 'z', 'q', 'w']) fireKey(k);

    expect(getEffSpy.mock.calls.length).toBe(afterCompile);
  });

  it('预编译绑定表按命令数预分配,不通过 out.push 扩容', () => {
    const commands = [
      { id: 'a', title: 'A', hotkey: 'mod+a', fn: vi.fn() },
      { id: 'b', title: 'B', fn: vi.fn() },
      { id: 'c', title: 'C', hotkey: 'mod+c', fn: vi.fn() },
    ];

    expect(buildCompiledBindings(commands, 'other')).toHaveLength(2);
    expect(buildCompiledBindings.toString()).not.toContain('out.push(');
  });

  it('无 hotkey 且无 override 的命令不调用 getEffectiveHotkey', () => {
    const commands = [
      { id: 'a', title: 'A', hotkey: 'mod+a', fn: vi.fn() },
      { id: 'b', title: 'B', fn: vi.fn() },
      { id: 'c', title: 'C', fn: vi.fn() },
    ];
    useKeybindingsStore.setState({ overrides: { c: 'mod+c' } });

    const bindings = buildCompiledBindings(commands, 'other', { c: 'mod+c' });

    expect(bindings).toHaveLength(2);
    expect(bindings.map((binding) => binding.cmd.id)).toEqual(['a', 'c']);
    expect(getEffSpy).toHaveBeenCalledTimes(2);
  });

  it('命中的 hotkey 仍正确触发命令(预编译表匹配)', () => {
    const fn = vi.fn();
    const reg = new CommandRegistry();
    // jsdom detectPlatform()='other' → 'mod' = ctrlKey
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+k', fn });
    renderHook(() => useCommandHotkeys(reg));

    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
