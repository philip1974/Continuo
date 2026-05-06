// BDD: explorer-context-menu / registry + filterVisible + Plugin proxy

import { describe, it, expect } from 'vitest';
import {
  ExplorerContextMenuRegistry,
  filterVisible,
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
});

// ────────────────────────────────────────────────────────────
// filterVisible
// ────────────────────────────────────────────────────────────

describe('filterVisible', () => {
  it('无 when → 始终可见', () => {
    const items: ExplorerContextMenuItemSpec[] = [
      { id: 'a', label: 'A', fn: () => {} },
    ];
    expect(filterVisible(items, ctx)).toEqual(items);
  });

  it('when 返 true → 可见;false → 隐藏', () => {
    const items: ExplorerContextMenuItemSpec[] = [
      { id: 'show', label: 'Show', when: () => true, fn: () => {} },
      { id: 'hide', label: 'Hide', when: () => false, fn: () => {} },
    ];
    expect(filterVisible(items, ctx).map((s) => s.id)).toEqual(['show']);
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
