// @vitest-environment jsdom
// 打磨 R29(codex 性能 + 契约):KeybindingsTabContent 把 effectiveHotkey/hotkeyParts/
// isOverridden 预计算进 displayCommands(deps: allCommands/tk/overrides),行渲染只读
// 派生字段;搜索 haystack 改用 effective hotkey(override 后能按新组合搜到)。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
  buildKeybindingDisplayCommands,
  buildCommandSearchHaystack,
  countDefaultHotkeys,
  groupByCategory,
  hasCommandId,
  keybindingRowClassName,
  selectVisibleKeybindingCommands,
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
  it('命令面板提示热键预计算,不在 render 中重复 formatHotkeyParts', () => {
    const src = readFileSync(join(process.cwd(), 'src/plugins/settings/KeybindingsTabContent.tsx'), 'utf8');

    expect(src).toContain('const COMMAND_PALETTE_HOTKEY_PARTS = formatHotkeyParts');
    expect(src).toContain('COMMAND_PALETTE_HOTKEY_PARTS.map');
    expect(src).not.toContain("formatHotkeyParts('mod+shift+p', PLATFORM).map");
  });

  it('displayCommands 构造预分配数组,不调用 allCommands.map', () => {
    const commands = [
      { id: 'save', title: 'Save', hotkey: 'mod+s', fn: vi.fn() },
      { id: 'toggle', title: 'Toggle', category: 'View', fn: vi.fn() },
      { id: 'plain-a', title: 'Plain A', fn: vi.fn() },
      { id: 'plain-b', title: 'Plain B', fn: vi.fn() },
    ];
    const mapSpy = vi.spyOn(commands, 'map');
    useKeybindingsStore.setState({ overrides: { toggle: 'mod+t' } });

    try {
      const out = buildKeybindingDisplayCommands(
        commands,
        (_key, fallback) => fallback,
        { toggle: 'mod+t' },
        'other',
      );

      expect(out.map((d) => d.cmd.id)).toEqual([
        'save',
        'toggle',
        'plain-a',
        'plain-b',
      ]);
      expect(out[0]?.hotkeyParts).toEqual(['Ctrl', 'S']);
      expect(out[1]?.effectiveHotkey).toBe('mod+t');
      expect(out[1]?.isOverridden).toBe(true);
      expect(out[1]?.searchHaystack).toContain('mod+t');
      expect(out[2]?.hotkeyParts).toBe(out[3]?.hotkeyParts);
      expect(mapSpy).not.toHaveBeenCalled();
    } finally {
      mapSpy.mockRestore();
    }
  });

  it('空命令列表 → 稳定空 displayCommands,不读取 hotkey', () => {
    const commands = [] as const;

    const out = buildKeybindingDisplayCommands(
      commands,
      (_key, fallback) => fallback,
      {},
      'other',
    );

    expect(out).toEqual([]);
    expect(out).toBe(
      buildKeybindingDisplayCommands(commands, (_key, fallback) => fallback, {}, 'mac'),
    );
    expect(getEffSpy).not.toHaveBeenCalled();
  });

  it('统计默认 hotkey 数量时不通过 filter(...).length 生成中间数组', () => {
    const commands = [
      { id: 'save', title: 'Save', hotkey: 'mod+s', fn: vi.fn() },
      { id: 'open', title: 'Open', fn: vi.fn() },
      { id: 'find', title: 'Find', hotkey: 'mod+f', fn: vi.fn() },
    ];
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      expect(countDefaultHotkeys(commands)).toBe(2);
      expect(filterSpy.mock.contexts.some((ctx) => ctx === commands)).toBe(false);
    } finally {
      filterSpy.mockRestore();
    }
  });

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
      expect(groupByCategory.toString()).not.toContain('buckets.push(');
      expect(groupByCategory.toString()).not.toContain('.push(');
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('同一分类且已按标题排序时复用输入 items,不 sort', () => {
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
      displayCategory: 'Editor',
      effectiveHotkey: 'mod+b',
      hotkeyParts: ['mod', 'b'],
      isOverridden: false,
      searchHaystack: 'beta editor b mod+b',
    };
    const commands = [commandA, commandB];
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      const buckets = groupByCategory(commands, 'Other');

      expect(buckets).toEqual([{ category: 'Editor', items: commands }]);
      expect(buckets[0]?.items).toBe(commands);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('同一分类但未排序时不构造 Map,仅复制后排序该组', () => {
    const commandA = {
      cmd: { id: 'b', title: 'Beta', hotkey: 'mod+b', fn: vi.fn() },
      displayTitle: 'Beta',
      displayCategory: 'Editor',
      effectiveHotkey: 'mod+b',
      hotkeyParts: ['mod', 'b'],
      isOverridden: false,
      searchHaystack: 'beta editor b mod+b',
    };
    const commandB = {
      cmd: { id: 'a', title: 'Alpha', hotkey: 'mod+a', fn: vi.fn() },
      displayTitle: 'Alpha',
      displayCategory: 'Editor',
      effectiveHotkey: 'mod+a',
      hotkeyParts: ['mod', 'a'],
      isOverridden: false,
      searchHaystack: 'alpha editor a mod+a',
    };
    const commands = [commandA, commandB];
    const OriginalMap = globalThis.Map;
    let mapCtorCount = 0;
    class CountingMap<K, V> extends OriginalMap<K, V> {
      constructor(entries?: readonly (readonly [K, V])[] | null) {
        mapCtorCount += 1;
        super(entries);
      }
    }
    globalThis.Map = CountingMap as MapConstructor;

    try {
      const buckets = groupByCategory(commands, 'Other');

      expect(buckets[0]?.category).toBe('Editor');
      expect(buckets[0]?.items).toEqual([commandB, commandA]);
      expect(buckets[0]?.items).not.toBe(commands);
      expect(commands).toEqual([commandA, commandB]);
      expect(mapCtorCount).toBe(0);
    } finally {
      globalThis.Map = OriginalMap;
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

  it('构建搜索 haystack 不通过数组 join 生成中间数组', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');
    try {
      const haystack = buildCommandSearchHaystack(
        'Save File',
        'Editor',
        'editor.saveFile',
        'mod+s',
      );

      expect(joinSpy).not.toHaveBeenCalled();
      expect(haystack).toContain('save file');
      expect(haystack).toContain('editor');
      expect(haystack).toContain('editor.savefile');
      expect(haystack).toContain('mod+s');
    } finally {
      joinSpy.mockRestore();
    }
  });

  it('选择可见命令时单趟过滤并保留显式 override 命令', () => {
    const visibleHotkey = {
      cmd: { id: 'alpha', title: 'Alpha', hotkey: 'mod+a', fn: vi.fn() },
      displayTitle: 'Alpha',
      displayCategory: 'Editor',
      effectiveHotkey: 'mod+a',
      hotkeyParts: ['mod', 'a'],
      isOverridden: false,
      searchHaystack: 'alpha editor alpha mod+a',
    };
    const hiddenNoHotkey = {
      cmd: { id: 'beta', title: 'Beta', fn: vi.fn() },
      displayTitle: 'Beta',
      displayCategory: 'Editor',
      effectiveHotkey: undefined,
      hotkeyParts: [],
      isOverridden: false,
      searchHaystack: 'beta editor beta',
    };
    const visibleOverride = {
      cmd: { id: 'gamma', title: 'Gamma', fn: vi.fn() },
      displayTitle: 'Gamma',
      displayCategory: 'Editor',
      effectiveHotkey: undefined,
      hotkeyParts: [],
      isOverridden: true,
      searchHaystack: 'gamma editor gamma',
    };
    const commands = [visibleHotkey, hiddenNoHotkey, visibleOverride];
    const filterSpy = vi.spyOn(Array.prototype, 'filter');

    try {
      expect(selectVisibleKeybindingCommands(commands, 'gamma')).toEqual([
        visibleOverride,
      ]);
      expect(filterSpy.mock.contexts.some((ctx) => ctx === commands)).toBe(false);
      expect(selectVisibleKeybindingCommands.toString()).not.toContain(
        'selected.push(',
      );
    } finally {
      filterSpy.mockRestore();
    }
  });

  it('选择可见命令无匹配结果时复用稳定空列表', () => {
    const command = {
      cmd: { id: 'alpha', title: 'Alpha', hotkey: 'mod+a', fn: vi.fn() },
      displayTitle: 'Alpha',
      displayCategory: 'Editor',
      effectiveHotkey: 'mod+a',
      hotkeyParts: ['mod', 'a'],
      isOverridden: false,
      searchHaystack: 'alpha editor alpha mod+a',
    };

    const a = selectVisibleKeybindingCommands([command], 'not-found');
    const b = selectVisibleKeybindingCommands([command], 'still-not-found');

    expect(a).toEqual([]);
    expect(b).toBe(a);
  });

  it('命令行 className 不通过数组 join 重建', () => {
    const joinSpy = vi.spyOn(Array.prototype, 'join');

    try {
      expect(keybindingRowClassName(0)).toContain(
        'flex items-center gap-3 px-4 py-3 text-xs',
      );
      expect(keybindingRowClassName(0)).not.toContain('border-t');
      expect(keybindingRowClassName(1)).toContain('border-t border-line/50');
      expect(joinSpy).not.toHaveBeenCalled();
    } finally {
      joinSpy.mockRestore();
    }
  });

  it('命令存在性检查单趟扫描,不调用 commands.some', () => {
    const commands = [
      { id: 'save', title: 'Save', hotkey: 'mod+s', fn: vi.fn() },
      { id: 'find', title: 'Find', hotkey: 'mod+f', fn: vi.fn() },
    ];
    const someSpy = vi.spyOn(commands, 'some');

    try {
      expect(hasCommandId(commands, 'find')).toBe(true);
      expect(hasCommandId(commands, 'missing')).toBe(false);
      expect(someSpy).not.toHaveBeenCalled();
    } finally {
      someSpy.mockRestore();
    }
  });
});
