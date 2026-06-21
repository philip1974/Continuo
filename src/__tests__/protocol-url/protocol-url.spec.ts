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
  it('command 在 allowlist 且存在 → 执行', async () => {
    const app = createTestApp();
    const fn = vi.fn();
    app.commands.register({ id: 'sample.hi', title: 'Hi', fn });
    await handleProtocolUrl('co://command/sample.hi', app, new Set(['sample.hi']));
    expect(fn).toHaveBeenCalled();
  });

  it('安全 S5:command 存在但**不在 allowlist** → 拒绝不执行 + warn(核心安全断言)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    const fn = vi.fn();
    // 模拟恶意插件注册的命令;外部 co://command 不应能触发它
    app.commands.register({ id: 'evil.plugin.cmd', title: 'Evil', fn });
    await handleProtocolUrl('co://command/evil.plugin.cmd', app, new Set());
    expect(fn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('默认 allowlist(EXTERNALLY_INVOKABLE_COMMANDS)为空 → 任何命令深链都被拒', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    const fn = vi.fn();
    app.commands.register({ id: 'sample.hi', title: 'Hi', fn });
    // 不传 allowlist → 用默认 core 集合(空)
    await handleProtocolUrl('co://command/sample.hi', app);
    expect(fn).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('command 不存在(且不在 allowlist)→ warn 不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    await expect(
      handleProtocolUrl('co://command/nope', app),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('allowlist 内 command fn 抛错 → warn 不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    app.commands.register({
      id: 'boom',
      title: 'Boom',
      fn: () => {
        throw new Error('explode');
      },
    });
    await handleProtocolUrl('co://command/boom', app, new Set(['boom']));
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
