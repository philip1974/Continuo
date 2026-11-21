// BDD: explorer-context-menu / registry + filterVisible + Plugin proxy

import { describe, it, expect, vi } from 'vitest';
import {
  ExplorerContextMenuRegistry,
  filterVisible,
  isExplorerContextMenuItemVisible,
  type ExplorerContextMenuItemSpec,
  type ExplorerContextMenuItemContext,
} from '../../plugins/registries/ExplorerContextMenuRegistry';
import { Plugin } from '../../plugins/Plugin';
import { createTestApp } from '../../plugins/test-utils';
import type { PluginManifest } from '../../plugins/types';

const ctx: ExplorerContextMenuItemContext = {
  target: { path: '/r/a.ts', name: 'a.ts', isDirectory: false, mtime: 0, ctime: 0 },
  selectedPaths: new Set(['/r/a.ts']),
  rootPath: '/r',
};

// ────────────────────────────────────────────────────────────
// Registry
// ────────────────────────────────────────────────────────────

describe('ExplorerContextMenuRegistry', () => {
  it('空 registry 的 getAll 复用稳定空快照', () => {
    const r = new ExplorerContextMenuRegistry();
    const other = new ExplorerContextMenuRegistry();
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll()).toEqual([]);
      expect(r.getAll()).toBe(other.getAll());
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('register / dispose / getAll', () => {
    const r = new ExplorerContextMenuRegistry();
    const spec: ExplorerContextMenuItemSpec = {
      id: 'foo',
      label: 'Foo',
      fn: () => {},
    };
    const d = r.register(spec);
    expect(r.getAll()).toEqual([spec]);
    d.dispose();
    expect(r.getAll()).toEqual([]);
  });

  it('priority 升序(默认 100)', () => {
    const r = new ExplorerContextMenuRegistry();
    r.register({ id: 'b', label: 'B', priority: 50, fn: () => {} });
    r.register({ id: 'a', label: 'A', priority: 200, fn: () => {} });
    r.register({ id: 'c', label: 'C', fn: () => {} }); // 默认 100
    expect(r.getAll().map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('已按 priority 注册时复用构建顺序,不调用 sort', () => {
    const r = new ExplorerContextMenuRegistry();
    r.register({ id: 'top', label: 'T', priority: 1, fn: () => {} });
    r.register({ id: 'mid', label: 'M', priority: 100, fn: () => {} });
    r.register({ id: 'bot', label: 'B', priority: 200, fn: () => {} });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll().map((s) => s.id)).toEqual(['top', 'mid', 'bot']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('重复 getAll 复用排序结果,register/dispose 后失效重建', () => {
    const r = new ExplorerContextMenuRegistry();
    const d = r.register({ id: 'b', label: 'B', priority: 20, fn: () => {} });
    r.register({ id: 'a', label: 'A', priority: 10, fn: () => {} });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll().map((s) => s.id)).toEqual(['a', 'b']);
      expect(sortSpy).toHaveBeenCalledTimes(1);
      expect(r.getAll().map((s) => s.id)).toEqual(['a', 'b']);
      expect(sortSpy).toHaveBeenCalledTimes(1);

      r.register({ id: 'c', label: 'C', priority: 5, fn: () => {} });
      expect(r.getAll().map((s) => s.id)).toEqual(['c', 'a', 'b']);
      expect(sortSpy).toHaveBeenCalledTimes(2);

      d.dispose();
      expect(r.getAll().map((s) => s.id)).toEqual(['c', 'a']);
      expect(sortSpy).toHaveBeenCalledTimes(3);
      expect(ExplorerContextMenuRegistry.prototype.getAll.toString()).not.toContain(
        'items.push(',
      );
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('单项快照不调用 sort', () => {
    const r = new ExplorerContextMenuRegistry();
    r.register({ id: 'a', label: 'A', fn: () => {} });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll().map((s) => s.id)).toEqual(['a']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('同 id 后入赢 + warn(同 EditorActionRegistry 模式)', () => {
    const r = new ExplorerContextMenuRegistry();
    const original = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      r.register({ id: 'x', label: 'old', fn: () => {} });
      r.register({ id: 'x', label: 'new', fn: () => {} });
      const items = r.getAll();
      expect(items).toHaveLength(1);
      expect(items[0]?.label).toBe('new');
      expect(warned).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  it('subscribe 在 register / dispose 时通知', () => {
    const r = new ExplorerContextMenuRegistry();
    let count = 0;
    const unsub = r.subscribe(() => count++);
    const d = r.register({ id: 'x', label: 'X', fn: () => {} });
    expect(count).toBe(1);
    d.dispose();
    expect(count).toBe(2);
    unsub();
    r.register({ id: 'y', label: 'Y', fn: () => {} });
    expect(count).toBe(2); // 退订后不再增
  });

  it('dispose 多次幂等', () => {
    const r = new ExplorerContextMenuRegistry();
    const d = r.register({ id: 'x', label: 'X', fn: () => {} });
    d.dispose();
    d.dispose();
    d.dispose();
    expect(r.getAll()).toEqual([]);
  });

  // race(R54,R51/R52/R53 同族):菜单 onSelect 捕获 spec,菜单打开期间 unregister 后旧菜单仍可
  // 触发 → select 时按 id 从 live registry 重查 + 复检 when 执行。get(id) 提供 live 查找。
  describe('get(id) live 查找(R54)', () => {
    it('register → get(id) 返回 spec;dispose 后返 undefined', () => {
      const r = new ExplorerContextMenuRegistry();
      const d = r.register({ id: 'a', label: 'A', fn: () => {} });
      expect(r.get('a')?.id).toBe('a');
      d.dispose();
      expect(r.get('a')).toBeUndefined();
    });

    it('已 dispose 项经 get→filterVisible 复检后不执行(stale-skip 语义)', () => {
      const r = new ExplorerContextMenuRegistry();
      const fn = vi.fn();
      const d = r.register({ id: 'a', label: 'A', fn });
      d.dispose();
      const live = r.get('a');
      if (live && filterVisible([live], ctx).length > 0) live.fn(ctx);
      expect(fn).not.toHaveBeenCalled();
    });

    it('live 项当前 ctx 下 when=false → 经复检不执行', () => {
      const r = new ExplorerContextMenuRegistry();
      const fn = vi.fn();
      r.register({ id: 'a', label: 'A', fn, when: () => false });
      const live = r.get('a');
      if (live && filterVisible([live], ctx).length > 0) live.fn(ctx);
      expect(fn).not.toHaveBeenCalled();
    });
  });

  // 边界(E48,E35/E36/E37/E40 兄弟 registry):register 校验 id/label/group 长度 + priority finite
  // + when/fn 为函数。畸形项进 sort/分组渲染或在打开/点击时抛错,坏整个右键菜单。
  describe('E48 · 贡献项边界校验', () => {
    it('合法 spec → ok', () => {
      const r = new ExplorerContextMenuRegistry();
      expect(() =>
        r.register({ id: 'a', label: 'A', fn: () => {} }),
      ).not.toThrow();
    });

    it('超长 id/label/group → 抛,不入 registry', () => {
      const r = new ExplorerContextMenuRegistry();
      expect(() =>
        r.register({ id: 'x'.repeat(257), label: 'L', fn: () => {} }),
      ).toThrow(/id exceeds max length/i);
      expect(() =>
        r.register({ id: 'a', label: 'L'.repeat(513), fn: () => {} }),
      ).toThrow(/label exceeds max length/i);
      expect(() =>
        r.register({
          id: 'b',
          label: 'L',
          group: 'g'.repeat(257),
          fn: () => {},
        }),
      ).toThrow(/group exceeds max length/i);
      expect(r.getAll()).toEqual([]);
    });

    it('空 id/label → 抛', () => {
      const r = new ExplorerContextMenuRegistry();
      expect(() => r.register({ id: '', label: 'L', fn: () => {} })).toThrow(
        /id must be a non-empty/i,
      );
      expect(() => r.register({ id: 'a', label: '', fn: () => {} })).toThrow(
        /label must be a non-empty/i,
      );
    });

    it('非有限 priority / when 非函数 / fn 非函数 → 抛', () => {
      const r = new ExplorerContextMenuRegistry();
      expect(() =>
        r.register({ id: 'a', label: 'L', priority: NaN, fn: () => {} }),
      ).toThrow(/priority must be finite/i);
      expect(() =>
        r.register({
          id: 'b',
          label: 'L',
          fn: () => {},
          when: 'nope' as never,
        }),
      ).toThrow(/when must be a function/i);
      expect(() =>
        r.register({ id: 'c', label: 'L', fn: 'nope' as never }),
      ).toThrow(/fn must be a function/i);
    });

    // 边界(E155,E153/E154 兄弟):可选 group 此前只有 length 上限无 typeof(group:{}/group:123
    // 经 `({}).length === undefined > max` 为 false 绕过)→ 菜单打开 groupPluginItems() 排序
    // localeCompare 崩溃。补 typeof 守卫,非法不入 registry。
    it('E155 group 非字符串(对象/数字)→ 抛,不入 registry', () => {
      const r = new ExplorerContextMenuRegistry();
      expect(() =>
        r.register({ id: 'a', label: 'L', group: {} as never, fn: () => {} }),
      ).toThrow(/group must be a string/i);
      expect(() =>
        r.register({ id: 'b', label: 'L', group: 123 as never, fn: () => {} }),
      ).toThrow(/group must be a string/i);
      expect(r.getAll()).toEqual([]);
    });

    it('E155 合法 string group 仍 ok(回归)', () => {
      const r = new ExplorerContextMenuRegistry();
      expect(() =>
        r.register({ id: 'a', label: 'L', group: 'plugin', fn: () => {} }),
      ).not.toThrow();
    });
  });
});

// ────────────────────────────────────────────────────────────
// filterVisible
// ────────────────────────────────────────────────────────────

describe('filterVisible', () => {
  it('无 when → 始终可见', () => {
    const items: ExplorerContextMenuItemSpec[] = [
      { id: 'a', label: 'A', fn: () => {} },
    ];
    expect(filterVisible(items, ctx)).toBe(items);
  });

  it('全部 when 返 true 时复用输入数组且每个 when 只调用一次', () => {
    const whenA = vi.fn(() => true);
    const whenB = vi.fn(() => true);
    const items: ExplorerContextMenuItemSpec[] = [
      { id: 'a', label: 'A', when: whenA, fn: () => {} },
      { id: 'b', label: 'B', when: whenB, fn: () => {} },
    ];
    const visible = filterVisible(items, ctx);
    expect(visible).toBe(items);
    expect(whenA).toHaveBeenCalledTimes(1);
    expect(whenB).toHaveBeenCalledTimes(1);
  });

  it('when 返 true → 可见;false → 隐藏', () => {
    const items: ExplorerContextMenuItemSpec[] = [
      { id: 'show', label: 'Show', when: () => true, fn: () => {} },
      { id: 'hide', label: 'Hide', when: () => false, fn: () => {} },
    ];
    const visible = filterVisible(items, ctx);
    expect(visible).not.toBe(items);
    expect(visible.map((s) => s.id)).toEqual(['show']);
    expect(filterVisible.toString()).not.toContain('out.push(');
  });

  it('全部隐藏 → 复用稳定空数组', () => {
    const items: ExplorerContextMenuItemSpec[] = [
      { id: 'a', label: 'A', when: () => false, fn: () => {} },
      { id: 'b', label: 'B', when: () => false, fn: () => {} },
    ];
    const a = filterVisible(items, ctx);
    const b = filterVisible(
      [{ id: 'c', label: 'C', when: () => false, fn: () => {} }],
      ctx,
    );

    expect(a).toEqual([]);
    expect(b).toBe(a);
  });

  it('when 拿到 ctx target / selectedPaths / rootPath', () => {
    let captured: ExplorerContextMenuItemContext | undefined;
    const items: ExplorerContextMenuItemSpec[] = [
      {
        id: 'x',
        label: 'X',
        when: (c) => {
          captured = c;
          return true;
        },
        fn: () => {},
      },
    ];
    filterVisible(items, ctx);
    expect(captured?.target?.path).toBe('/r/a.ts');
    expect(captured?.selectedPaths.has('/r/a.ts')).toBe(true);
    expect(captured?.rootPath).toBe('/r');
  });

  it('when 抛错 → 视为 false + warn,不传染', () => {
    const original = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      const items: ExplorerContextMenuItemSpec[] = [
        {
          id: 'boom',
          label: 'Boom',
          when: () => {
            throw new Error('boom');
          },
          fn: () => {},
        },
        { id: 'ok', label: 'OK', fn: () => {} },
      ];
      const visible = filterVisible(items, ctx);
      expect(visible.map((s) => s.id)).toEqual(['ok']);
      expect(warned).toBe(true);
    } finally {
      console.warn = original;
    }
  });

  it('空数组 → 空', () => {
    expect(filterVisible([], ctx)).toEqual([]);
  });

  it('target=null(空白处右键)→ when 仍可调,target 是 null', () => {
    const blankCtx: ExplorerContextMenuItemContext = {
      target: null,
      selectedPaths: new Set(),
      rootPath: '/r',
    };
    let saw: ExplorerContextMenuItemContext | undefined;
    const items: ExplorerContextMenuItemSpec[] = [
      {
        id: 'x',
        label: 'X',
        when: (c) => {
          saw = c;
          return c.target === null;
        },
        fn: () => {},
      },
    ];
    expect(filterVisible(items, blankCtx)).toHaveLength(1);
    expect(saw?.target).toBeNull();
  });
});

describe('isExplorerContextMenuItemVisible', () => {
  it('单项复检不需要经 filterVisible 构造临时数组', () => {
    expect(
      isExplorerContextMenuItemVisible(
        { id: 'a', label: 'A', fn: () => {} },
        ctx,
      ),
    ).toBe(true);
    expect(
      isExplorerContextMenuItemVisible(
        { id: 'b', label: 'B', when: () => false, fn: () => {} },
        ctx,
      ),
    ).toBe(false);
  });

  it('when 抛错 → false + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      isExplorerContextMenuItemVisible(
        {
          id: 'boom',
          label: 'Boom',
          when: () => {
            throw new Error('boom');
          },
          fn: () => {},
        },
        ctx,
      ),
    ).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ────────────────────────────────────────────────────────────
// Plugin proxy
// ────────────────────────────────────────────────────────────

describe('Plugin.registerExplorerContextMenuItem 集成', () => {
  const manifest: PluginManifest = {
    id: 'test.cm',
    name: 'CM',
    version: '0.1.0',
  };

  it('注册 + _deactivate 自动移除', async () => {
    const app = createTestApp();
    class P extends Plugin {
      onload() {
        this.registerExplorerContextMenuItem({
          id: 'x',
          label: 'X',
          fn: () => {},
        });
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(app.explorerContextMenu.getAll()).toHaveLength(1);
    await p._deactivate();
    expect(app.explorerContextMenu.getAll()).toHaveLength(0);
  });
});
