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

  it('subscribe register/dispose 触发', () => {
    const r = new EditorActionRegistry();
    const listener = vi.fn();
    r.subscribe(listener);
    const d = r.register({ id: 'a', label: 'A', fn: () => {} });
    d.dispose();
    expect(listener).toHaveBeenCalledTimes(2);
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
