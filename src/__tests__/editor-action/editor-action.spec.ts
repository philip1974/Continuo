import { describe, it, expect, vi } from 'vitest';
import {
  EditorActionRegistry,
  filterVisible,
  type EditorActionContext,
  type EditorActionSpec,
} from '../../plugins/registries/EditorActionRegistry';
import { Plugin } from '../../plugins/Plugin';
import { createTestApp } from '../../plugins/test-utils';
import type { PluginManifest } from '../../plugins/types';

const ctx: EditorActionContext = {
  filePath: '/foo.md',
  dirty: false,
  mode: 'edit',
};

describe('EditorActionRegistry', () => {
  it('register / dispose / getAll 升序', () => {
    const r = new EditorActionRegistry();
    r.register({ id: 'b', label: 'B', fn: () => {}, priority: 20 });
    r.register({ id: 'a', label: 'A', fn: () => {}, priority: 10 });
    expect(r.getAll().map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('重复 getAll 复用排序结果,register/dispose 后失效重建', () => {
    const r = new EditorActionRegistry();
    const d = r.register({ id: 'b', label: 'B', fn: () => {}, priority: 20 });
    r.register({ id: 'a', label: 'A', fn: () => {}, priority: 10 });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll().map((x) => x.id)).toEqual(['a', 'b']);
      expect(sortSpy).toHaveBeenCalledTimes(1);
      expect(r.getAll().map((x) => x.id)).toEqual(['a', 'b']);
      expect(sortSpy).toHaveBeenCalledTimes(1);

      r.register({ id: 'c', label: 'C', fn: () => {}, priority: 5 });
      expect(r.getAll().map((x) => x.id)).toEqual(['c', 'a', 'b']);
      expect(sortSpy).toHaveBeenCalledTimes(2);

      d.dispose();
      expect(r.getAll().map((x) => x.id)).toEqual(['c', 'a']);
      expect(sortSpy).toHaveBeenCalledTimes(3);
      expect(EditorActionRegistry.prototype.getAll.toString()).not.toContain(
        'items.push(',
      );
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('单项快照不调用 sort', () => {
    const r = new EditorActionRegistry();
    r.register({ id: 'a', label: 'A', fn: () => {} });
    const sortSpy = vi.spyOn(Array.prototype, 'sort');

    try {
      expect(r.getAll().map((x) => x.id)).toEqual(['a']);
      expect(sortSpy).not.toHaveBeenCalled();
    } finally {
      sortSpy.mockRestore();
    }
  });

  it('重复 id → 后注册赢 + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = new EditorActionRegistry();
    r.register({ id: 'dup', label: 'A', fn: () => {} });
    r.register({ id: 'dup', label: 'B', fn: () => {} });
    expect(r.getAll()).toHaveLength(1);
    expect(r.getAll()[0]!.label).toBe('B');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // race(R53,R51/R52 同族):EditorHeader 按钮 onClick 捕获 spec,插件 unregister 后旧 handler
  // 仍可触发 → click 时按 id 从 live registry 重查执行。get(id) 提供 live 查找,dispose 后 undefined。
  describe('get(id) live 查找(R53)', () => {
    it('register → get(id) 返回 spec;dispose 后返 undefined', () => {
      const r = new EditorActionRegistry();
      const d = r.register({ id: 'a', label: 'A', fn: () => {} });
      expect(r.get('a')?.id).toBe('a');
      d.dispose();
      expect(r.get('a')).toBeUndefined();
    });

    it('get 返回当前 live spec(重复 id 后注册赢)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const r = new EditorActionRegistry();
      r.register({ id: 'x', label: 'old', fn: () => {} });
      r.register({ id: 'x', label: 'new', fn: () => {} });
      expect(r.get('x')?.label).toBe('new');
      warn.mockRestore();
    });

    it('已 dispose 的 action 经 get→filterVisible 复检后不执行(stale-skip 语义)', () => {
      const r = new EditorActionRegistry();
      const fn = vi.fn();
      const d = r.register({ id: 'a', label: 'A', fn });
      d.dispose();
      // 模拟点击时的重查 + 复检:get 返 undefined → 不执行 stale fn。
      const live = r.get('a');
      if (live && filterVisible([live], ctx).length > 0) live.fn();
      expect(fn).not.toHaveBeenCalled();
    });
  });

  it('subscribe register/dispose 触发', () => {
    const r = new EditorActionRegistry();
    const listener = vi.fn();
    r.subscribe(listener);
    const d = r.register({ id: 'a', label: 'A', fn: () => {} });
    d.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // 边界(E51,E35-E50 兄弟 registry):register 校验 id/label 长度 + priority finite + when/fn 为函数。
  // 畸形 action 进 editor header 排序/渲染,超长 label 污染按钮,非函数 when/fn 渲染过滤/点击时抛。
  describe('E51 · 贡献项边界校验', () => {
    it('合法 spec → ok', () => {
      const r = new EditorActionRegistry();
      expect(() => r.register({ id: 'a', label: 'A', fn: () => {} })).not.toThrow();
    });

    it('超长 id/label → 抛,不入 registry', () => {
      const r = new EditorActionRegistry();
      expect(() =>
        r.register({ id: 'x'.repeat(257), label: 'L', fn: () => {} }),
      ).toThrow(/id exceeds max length/i);
      expect(() =>
        r.register({ id: 'a', label: 'L'.repeat(513), fn: () => {} }),
      ).toThrow(/label exceeds max length/i);
      expect(r.getAll()).toEqual([]);
    });

    it('空 id/label → 抛', () => {
      const r = new EditorActionRegistry();
      expect(() => r.register({ id: '', label: 'L', fn: () => {} })).toThrow(
        /id must be a non-empty/i,
      );
      expect(() => r.register({ id: 'a', label: '', fn: () => {} })).toThrow(
        /label must be a non-empty/i,
      );
    });

    it('非有限 priority / when 非函数 / fn 非函数 → 抛', () => {
      const r = new EditorActionRegistry();
      expect(() =>
        r.register({ id: 'a', label: 'L', fn: () => {}, priority: Infinity }),
      ).toThrow(/priority must be finite/i);
      expect(() =>
        r.register({ id: 'b', label: 'L', fn: () => {}, when: 'x' as never }),
      ).toThrow(/when must be a function/i);
      expect(() =>
        r.register({ id: 'c', label: 'L', fn: 'x' as never }),
      ).toThrow(/fn must be a function/i);
    });
  });
});

describe('filterVisible', () => {
  const make = (id: string, when?: EditorActionSpec['when']): EditorActionSpec => ({
    id,
    label: id,
    fn: () => {},
    when,
  });

  it('无 when → 永远显', () => {
    const r = filterVisible([make('a'), make('b')], ctx);
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('when 返 false → 隐藏', () => {
    const r = filterVisible(
      [make('a', () => true), make('b', () => false), make('c')],
      ctx,
    );
    expect(r.map((x) => x.id)).toEqual(['a', 'c']);
    expect(filterVisible.toString()).not.toContain('out.push(');
  });

  it('when 抛错 → 视为 false + warn', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = filterVisible(
      [
        make('a'),
        make('b', () => {
          throw new Error('boom');
        }),
      ],
      ctx,
    );
    expect(r.map((x) => x.id)).toEqual(['a']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('when 收到当前 ctx', () => {
    let received: EditorActionContext | null = null;
    const a = make('a', (c) => {
      received = c;
      return true;
    });
    filterVisible([a], ctx);
    expect(received).toEqual(ctx);
  });
});

describe('Plugin.registerEditorAction 集成', () => {
  const manifest: PluginManifest = {
    id: 'test.ea',
    name: 'EA',
    version: '0.1.0',
  };

  it('注册 + _deactivate 自动移除', async () => {
    const app = createTestApp();
    class P extends Plugin {
      onload() {
        this.registerEditorAction({
          id: 'mine',
          label: 'Mine',
          fn: () => {},
        });
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    expect(app.editorActions.getAll()).toHaveLength(1);
    await p._deactivate();
    expect(app.editorActions.getAll()).toHaveLength(0);
  });
});
