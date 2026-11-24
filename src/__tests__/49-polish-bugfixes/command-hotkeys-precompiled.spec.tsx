// @vitest-environment jsdom
// 打磨 R26(性能):全局命令 hotkey 匹配表预编译。原先每次 keydown 都遍历
// 命令逐条 getEffectiveHotkey + split/lowercase/Set 解析 combo;现在只在命令集 /
// overrides 变化时用 useMemo 预编译一次,keydown 路径只做字段比较。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, cleanup } from '@testing-library/react';

vi.mock('../../plugins/keybindings/keybindings-store', async (importActual) => {
  const actual = await importActual<typeof import('../../plugins/keybindings/keybindings-store')>();
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
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
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

  it('keydown 与预编译都不逐命令调 getEffectiveHotkey', () => {
    const reg = new CommandRegistry();
    reg.register({ id: 'a', title: 'A', hotkey: 'mod+s', fn: vi.fn() });
    reg.register({ id: 'b', title: 'B', hotkey: 'mod+p', fn: vi.fn() });
    renderHook(() => useCommandHotkeys(reg));

    const afterCompile = getEffSpy.mock.calls.length;
    expect(afterCompile).toBe(0);

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

  it('用传入 overrides 预编译绑定,不逐命令读 keybindings store', () => {
    const commands = [
      { id: 'a', title: 'A', hotkey: 'mod+a', fn: vi.fn() },
      { id: 'b', title: 'B', fn: vi.fn() },
      { id: 'c', title: 'C', fn: vi.fn() },
    ];
    useKeybindingsStore.setState({ overrides: {} });

    const bindings = buildCompiledBindings(commands, 'other', { c: 'mod+c' });

    expect(bindings).toHaveLength(2);
    // 用户 override 的命令排前(用户绑定优先于默认,见 keybinding-user-priority)。
    expect(bindings.map((binding) => binding.cmd.id)).toEqual(['c', 'a']);
    expect(getEffSpy).not.toHaveBeenCalled();
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

// 保留键(⌘P / ⌘⇧P 归 Quick Open / 命令面板):升级前已存的 override / 插件默认 hotkey 落在这里 → 不入分发表(否则一键两动作)。
describe('buildCompiledBindings · 保留键', () => {
  it('effective hotkey 为 mod+p / mod+shift+p → 不入表;其它照常', () => {
    const fn = () => {};
    const cmds = [
      { id: 'a', title: 'A', hotkey: 'mod+k', fn },
      { id: 'b', title: 'B', hotkey: 'mod+p', fn },
      { id: 'c', title: 'C', hotkey: 'mod+j', fn },
    ];
    const ids = buildCompiledBindings(cmds as never, 'other', { c: 'mod+shift+p' }).map((b) => b.cmd.id);
    expect(ids).toEqual(['a']);
  });
});

