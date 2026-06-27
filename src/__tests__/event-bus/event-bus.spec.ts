import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EventBus } from '../../plugins/EventBus';
import { Plugin } from '../../plugins/Plugin';
import { createTestApp } from '../../plugins/test-utils';
import type { PluginManifest } from '../../plugins/types';

describe('EventBus', () => {
  it('on + emit 触发 listener', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('foo.bar', fn);
    bus.emit('foo.bar', { x: 1 });
    expect(fn).toHaveBeenCalledWith({ x: 1 });
  });

  it('多个 listener 全部触发', () => {
    const bus = new EventBus();
    const f1 = vi.fn();
    const f2 = vi.fn();
    bus.on('e', f1);
    bus.on('e', f2);
    bus.emit('e', null);
    expect(f1).toHaveBeenCalled();
    expect(f2).toHaveBeenCalled();
  });

  it('emit 构造 listener 快照不调用 Array.from', () => {
    const bus = new EventBus();
    bus.on('e', vi.fn());
    bus.on('e', vi.fn());
    const arrayFromSpy = vi.spyOn(Array, 'from');

    try {
      bus.emit('e', null);
      expect(arrayFromSpy).not.toHaveBeenCalled();
    } finally {
      arrayFromSpy.mockRestore();
    }
  });

  it('emit listener 快照预分配数组,不通过 snapshot.push 扩容', () => {
    const src = readFileSync(
      path.join(process.cwd(), 'src/plugins/EventBus.ts'),
      'utf-8',
    );
    const emitBody = src.slice(
      src.indexOf('  emit(name: string, payload: unknown): void {'),
      src.indexOf('  clear(name?: string): void {'),
    );
    expect(emitBody).toMatch(/new Array<Listener>\(set\.size\)/);
    expect(emitBody).not.toMatch(/\.push\(/);
  });

  it('emit 使用快照:listener 中 dispose 后续 listener,本轮仍会调用', () => {
    const bus = new EventBus();
    const f2 = vi.fn();
    let d2: { dispose(): void } | null = null;
    bus.on('e', () => d2?.dispose());
    d2 = bus.on('e', f2);

    bus.emit('e', null);

    expect(f2).toHaveBeenCalledTimes(1);
  });

  it('on 返回 Disposable;dispose 移除监听', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    const d = bus.on('e', fn);
    d.dispose();
    bus.emit('e', null);
    expect(fn).not.toHaveBeenCalled();
  });

  it('off 显式移除 listener', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('e', fn);
    bus.off('e', fn);
    bus.emit('e', null);
    expect(fn).not.toHaveBeenCalled();
  });

  it('单 listener 抛错不影响其他', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = new EventBus();
    const ok = vi.fn();
    bus.on('e', () => {
      throw new Error('boom');
    });
    bus.on('e', ok);
    bus.emit('e', null);
    expect(ok).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('emit 不存在的事件 → 不抛', () => {
    const bus = new EventBus();
    expect(() => bus.emit('nope', null)).not.toThrow();
  });

  it('clear(name) 移除该事件全部 listener', () => {
    const bus = new EventBus();
    const fn = vi.fn();
    bus.on('e', fn);
    bus.clear('e');
    bus.emit('e', null);
    expect(fn).not.toHaveBeenCalled();
  });

  it('clear() 不带参 → 清全部', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('a', a);
    bus.on('b', b);
    bus.clear();
    bus.emit('a', null);
    bus.emit('b', null);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  // 边界(E56,插件 API 输入校验):on 校验 name(有限长度字符串)+ listener(函数)+ 数量上限。
  describe('E56 · on 输入校验', () => {
    it('超长/空/非字符串 name → 抛', () => {
      const bus = new EventBus();
      expect(() => bus.on('x'.repeat(257), () => {})).toThrow(
        /event name must be/i,
      );
      expect(() => bus.on('', () => {})).toThrow(/event name must be/i);
      expect(() => bus.on(123 as never, () => {})).toThrow(/event name must be/i);
    });

    it('非函数 listener → 抛', () => {
      const bus = new EventBus();
      expect(() => bus.on('e', 'nope' as never)).toThrow(
        /listener must be a function/i,
      );
    });

    it('单事件 listener 数超上限(1024)→ 抛', () => {
      const bus = new EventBus();
      for (let i = 0; i < 1024; i++) bus.on('e', () => {});
      expect(() => bus.on('e', () => {})).toThrow(/too many listeners/i);
    });

    it('事件名总数超上限(1024)→ 抛', () => {
      const bus = new EventBus();
      for (let i = 0; i < 1024; i++) bus.on(`e${i}`, () => {});
      expect(() => bus.on('overflow', () => {})).toThrow(
        /too many distinct event names/i,
      );
    });

    it('emit 非字符串 name → no-op(不抛)', () => {
      const bus = new EventBus();
      expect(() => bus.emit(123 as never, null)).not.toThrow();
    });
  });
});

describe('Plugin.registerEvent 集成', () => {
  const makeApp = () => createTestApp();

  const manifest: PluginManifest = {
    id: 'test.event',
    name: 'Event',
    version: '0.1.0',
  };

  it('registerEvent 订阅 + _deactivate 自动取消', async () => {
    const app = makeApp();
    const fn = vi.fn();
    class P extends Plugin {
      onload() {
        this.registerEvent({ name: 'tick', fn });
      }
    }
    const p = new P(app, manifest);
    await p._activate();
    app.events.emit('tick', 1);
    expect(fn).toHaveBeenCalledTimes(1);
    await p._deactivate();
    app.events.emit('tick', 2);
    expect(fn).toHaveBeenCalledTimes(1); // 没再涨
  });
});
