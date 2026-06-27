// race(R33):co:// 深链冷启动唤起的「先监听后异步加载」。main 在 did-finish-load 只推一次
// PROTOCOL_URL 无 replay;若 renderer 把 onProtocolUrl 订阅写在 import('./handler').then 里,
// 监听要等动态 import 微任务 resolve 才挂 → import 晚于 did-finish-load 时事件丢失。
// wireProtocolUrl 同步注册监听、handler 懒加载,关闭这一窗口。
import { describe, it, expect, vi } from 'vitest';
import { wireProtocolUrl } from '../../plugins/protocol/wire-protocol-url';

describe('race(R33) · wireProtocolUrl 先监听后懒加载', () => {
  it('onProtocolUrl 在 wireProtocolUrl 返回前(同步)即被调用 —— 监听早于任何 import 微任务', () => {
    let registered = false;
    const loadHandler = vi.fn(async () => ({ handleProtocolUrl: vi.fn() }));
    wireProtocolUrl({
      onProtocolUrl: () => {
        registered = true;
      },
      loadHandler,
      app: { commands: {} } as never,
    });
    // 关键回归点:同步注册。旧实现(订阅在 import().then 里)此处 registered 仍为 false。
    expect(registered).toBe(true);
    // handler 懒加载:无 url 到达前不拉 chunk。
    expect(loadHandler).not.toHaveBeenCalled();
  });

  it('url 到达 → lazy-load handler 并以 (url, app) 调 handleProtocolUrl', async () => {
    const handleProtocolUrl = vi.fn();
    const loadHandler = vi.fn(async () => ({ handleProtocolUrl }));
    const app = { commands: {} } as never;
    let fire: (url: string) => void = () => {};
    wireProtocolUrl({
      onProtocolUrl: (cb) => {
        fire = cb;
      },
      loadHandler,
      app,
    });

    fire('co://run/foo');
    await Promise.resolve(); // 等 loadHandler().then 微任务
    await Promise.resolve();

    expect(loadHandler).toHaveBeenCalledTimes(1);
    expect(handleProtocolUrl).toHaveBeenCalledWith('co://run/foo', app);
  });

  it('handler 加载/处理失败 → onError 可见,不抛(不拖垮 init)', async () => {
    const onError = vi.fn();
    const loadHandler = vi.fn(async () => {
      throw new Error('chunk load failed');
    });
    let fire: (url: string) => void = () => {};
    wireProtocolUrl({
      onProtocolUrl: (cb) => {
        fire = cb;
      },
      loadHandler,
      app: { commands: {} } as never,
      onError,
    });

    expect(() => fire('co://run/foo')).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
