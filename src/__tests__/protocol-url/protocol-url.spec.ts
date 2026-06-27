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

  // 边界(E55):renderer 防御性长度 + params 数量上限(挡绕过 main cap 的入口)。
  it('E55 超长 URL(>8192)→ null(不解析)', () => {
    const huge = 'co://command/' + 'x'.repeat(8192);
    expect(parseProtocolUrl(huge)).toBeNull();
  });

  it('E55 海量 query params → 截断到 256', () => {
    const many = Array.from({ length: 400 }, (_, i) => `p${i}=${i}`).join('&');
    const r = parseProtocolUrl(`co://command/foo?${many}`);
    expect(r).not.toBeNull();
    expect(Object.keys(r!.params).length).toBe(256);
  });

  // 边界(E98):字段级长度上限(action/target ≤256、param key ≤128、value ≤1024),8KB 内的
  // 超长单字段不进返回对象。
  it('E98 超长 target(>256,URL 仍 <8KB)→ null', () => {
    const r = parseProtocolUrl(`co://command/${'t'.repeat(300)}`);
    expect(r).toBeNull();
  });

  it('E98 超长 action(>256)→ null', () => {
    const r = parseProtocolUrl(`co://${'a'.repeat(300)}/foo`);
    expect(r).toBeNull();
  });

  it('E98 超长 param value(>1024)→ 跳过该 param,合法 param 保留', () => {
    const r = parseProtocolUrl(
      `co://command/foo?big=${'v'.repeat(2000)}&ok=1`,
    );
    expect(r).not.toBeNull();
    expect(r!.params.big).toBeUndefined(); // 超长 value 跳过
    expect(r!.params.ok).toBe('1'); // 合法 param 保留
  });

  it('E98 超长 param key(>128)→ 跳过该 param', () => {
    const r = parseProtocolUrl(
      `co://command/foo?${'k'.repeat(200)}=1&ok=2`,
    );
    expect(r).not.toBeNull();
    expect(Object.keys(r!.params)).toEqual(['ok']); // 超长 key 跳过
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

  // 边界(E99,E98 兄弟分支):unsupported action 分支日志也截断 url(8KB 合法但不支持的 URL
  // 绕过 invalid 分支,在此不应完整输出)。
  it('E99 unsupported action 长 URL → warn 截断,不回显完整 url', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const app = createTestApp();
    // 合法 co://panel/...(action 'panel' 不支持)+ 长 param value(<8KB,过 URL 总长但参数被跳过)
    const longTail = 'x'.repeat(4000);
    await handleProtocolUrl(`co://panel/editor?d=${longTail}`, app);
    expect(warn).toHaveBeenCalled();
    const msg = String(warn.mock.calls[0]?.[0] ?? '');
    expect(msg).not.toContain(longTail); // 不回显完整超长 url
    expect(msg.length).toBeLessThan(400); // 日志被截断
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
