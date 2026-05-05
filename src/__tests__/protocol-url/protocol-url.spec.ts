import { describe, it, expect, vi } from 'vitest';
import {
  handleProtocolUrl,
  parseProtocolUrl,
} from '../../plugins/protocol/handler';
import { createTestApp } from '../../plugins/test-utils';

describe('parseProtocolUrl', () => {
  it('co://command/<id> 基本解析', () => {
    const r = parseProtocolUrl('co://command/sample.hello');
    expect(r).toEqual({
      action: 'command',
      target: 'sample.hello',
      params: {},
    });
  });

  it('带 query → params', () => {
    const r = parseProtocolUrl('co://command/foo?a=1&b=hi');
    expect(r?.params).toEqual({ a: '1', b: 'hi' });
  });

  it('non-lm 协议 → null', () => {
    expect(parseProtocolUrl('https://x.com')).toBeNull();
    expect(parseProtocolUrl('file:///a')).toBeNull();
  });

  it('URL 解析失败 → null', () => {
    expect(parseProtocolUrl('not a url')).toBeNull();
  });

  it('缺 host(action)→ null', () => {
    expect(parseProtocolUrl('co:///foo')).toBeNull();
  });

  it('缺 pathname(target)→ null', () => {
    expect(parseProtocolUrl('co://command')).toBeNull();
    expect(parseProtocolUrl('co://command/')).toBeNull();
  });

  it("action 'panel' 也能解析(handler 决定支持)", () => {
    const r = parseProtocolUrl('co://panel/editor?file=foo.md');
    expect(r?.action).toBe('panel');
    expect(r?.target).toBe('editor');
  });
});

describe('handleProtocolUrl', () => {
  it('command 存在 → 执行', async () => {
    const app = createTestApp();
    const fn = vi.fn();
    app.commands.register({ id: 'sample.hi', title: 'Hi', fn });
    await handleProtocolUrl('co://command/sample.hi', app);
    expect(fn).toHaveBeenCalled();
  });

  it('command 不存在 → warn 不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    await expect(
      handleProtocolUrl('co://command/nope', app),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('command fn 抛错 → warn 不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    app.commands.register({
      id: 'boom',
      title: 'Boom',
      fn: () => {
        throw new Error('explode');
      },
    });
    await handleProtocolUrl('co://command/boom', app);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('不支持的 action → warn 不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    await handleProtocolUrl('co://panel/editor', app);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('非法 URL → warn 不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    await handleProtocolUrl('not a url', app);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
