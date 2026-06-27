// @vitest-environment jsdom
// 打磨 R29(codex 性能 + 契约):KeybindingsTabContent 把 effectiveHotkey/hotkeyParts/
// isOverridden 预计算进 displayCommands(deps: allCommands/tk/overrides),行渲染只读
// 派生字段;搜索 haystack 改用 effective hotkey(override 后能按新组合搜到)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';

vi.mock('../../plugins/keybindings/keybindings-store', async (importActual) => {
  const actual =
    await importActual<
      typeof import('../../plugins/keybindings/keybindings-store')
    >();
  return { ...actual, getEffectiveHotkey: vi.fn(actual.getEffectiveHotkey) };
});

import {
  KeybindingsTabContent,
  groupByCategory,
} from '../../plugins/settings/KeybindingsTabContent';
import { coApp } from '../../plugins/co-app';
import { CommandRegistry } from '../../plugins/registries/CommandRegistry';
import {
  getEffectiveHotkey,
  useKeybindingsStore,
} from '../../plugins/keybindings/keybindings-store';

const getEffSpy = getEffectiveHotkey as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  (coApp as { commands: CommandRegistry }).commands = new CommandRegistry();
  useKeybindingsStore.setState({ overrides: {} });
  coApp.commands.register({ id: 'save', title: 'Save', hotkey: 'mod+s', fn: vi.fn() });
  coApp.commands.register({ id: 'find', title: 'Find', hotkey: 'mod+f', fn: vi.fn() });
  getEffSpy.mockClear();
});
afterEach(() => cleanup());

describe('打磨 R29 — Keybindings hotkey 预计算', () => {
  it('分组命令时不通过 Array.from(entries).map 生成中间数组', () => {
    const commandA = {
      cmd: { id: 'a', title: 'Alpha', hotkey: 'mod+a', fn: vi.fn() },
      displayTitle: 'Alpha',
      displayCategory: 'Editor',
      effectiveHotkey: 'mod+a',
      hotkeyParts: ['mod', 'a'],
      isOverridden: false,
      searchHaystack: 'alpha editor a mod+a',
    };
    const commandB = {
      cmd: { id: 'b', title: 'Beta', hotkey: 'mod+b', fn: vi.fn() },
      displayTitle: 'Beta',
      displayCategory: '',
      effectiveHotkey: 'mod+b',
      hotkeyParts: ['mod', 'b'],
      isOverridden: false,
      searchHaystack: 'beta b mod+b',
    };
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      const buckets = groupByCategory([commandA, commandB], 'Other');
      expect(arrayFromSpy).not.toHaveBeenCalled();
      expect(buckets.map((bucket) => bucket.category)).toEqual([
        'Editor',
        'Other',
      ]);
      expect(buckets[0]?.items).toEqual([commandA]);
      expect(buckets[1]?.items).toEqual([commandB]);
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('搜索输入变化 → 不再逐行调 getEffectiveHotkey', () => {
    const { container } = render(<KeybindingsTabContent />);
    const afterRender = getEffSpy.mock.calls.length;
    expect(afterRender).toBeGreaterThan(0);

    const input = container.querySelector('input')!;
    act(() => {
      fireEvent.change(input, { target: { value: 'sa' } });
    });
    act(() => {
      fireEvent.change(input, { target: { value: 'sav' } });
    });

    // displayCommands memo 不依赖 query,搜索打字不应触发 getEffectiveHotkey 重算
    expect(getEffSpy.mock.calls.length).toBe(afterRender);
  });

  it('override 后可按新 hotkey 搜到(haystack 用 effective)', () => {
    const { container } = render(<KeybindingsTabContent />);
    // 把 'save' override 到 mod+k
    act(() => {
      useKeybindingsStore.getState().setHotkey('save', 'mod+k');
    });
    const input = container.querySelector('input')!;
    act(() => {
      fireEvent.change(input, { target: { value: 'mod+k' } });
    });
    // Save 行应仍在(按新 hotkey 命中);Find 行(mod+f)被过滤掉
    expect(container.textContent).toContain('Save');
    expect(container.textContent).not.toContain('Find');
  });

  it('搜索输入变化 → 不再逐行重建小写 haystack', () => {
    const { container } = render(<KeybindingsTabContent />);
    const input = container.querySelector('input')!;
    const lowerSpy = vi.spyOn(String.prototype, 'toLowerCase');

    act(() => {
      fireEvent.change(input, { target: { value: 'sa' } });
    });
    act(() => {
      fireEvent.change(input, { target: { value: 'sav' } });
    });

    // 搜索源应随 displayCommands 预计算;打字只 lower-case query,不再对每行
    // "title category id hotkey" haystack 反复 lower-case。
    const contexts = lowerSpy.mock.contexts.map((ctx) => String(ctx));
    lowerSpy.mockRestore();
    expect(contexts.some((ctx) => ctx.includes('Save'))).toBe(false);
    expect(contexts.some((ctx) => ctx.includes('Find'))).toBe(false);
  });
});
