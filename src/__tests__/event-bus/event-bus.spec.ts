import { describe, it, expect, vi } from 'vitest';
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
