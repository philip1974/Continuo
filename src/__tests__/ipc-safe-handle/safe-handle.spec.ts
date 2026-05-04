import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  defaultIsTrustedFrame,
  processIpcCall,
} from '../../../electron/main/safe-handle';

const trustAll = () => true;
const trustNone = () => false;
const fileFrame = { url: 'file:///app/index.html' };

describe('processIpcCall', () => {
  it('senderFrame 不可信 → IPC_DENIED', async () => {
    const r = await processIpcCall(z.unknown(), () => 'ok', undefined, null, trustNone);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('IPC_DENIED');
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('zod 校验失败 → IPC_BAD_INPUT,message 非空', async () => {
    const r = await processIpcCall(z.string(), (s) => s, 42, fileFrame, trustAll);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('IPC_BAD_INPUT');
      expect(r.message.length).toBeGreaterThan(0);
    }
  });

  it('handler 抛普通 Error → IPC_HANDLER_ERROR,透传 message', async () => {
    const r = await processIpcCall(
      z.unknown(),
      () => {
        throw new Error('boom');
      },
      1,
      fileFrame,
      trustAll,
    );
    expect(r).toEqual({
      ok: false,
      code: 'IPC_HANDLER_ERROR',
      message: 'boom',
    });
  });

  it('handler 抛带 code 的错 → 透传业务 code', async () => {
    const r = await processIpcCall(
      z.unknown(),
      () => {
        throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' });
      },
      1,
      fileFrame,
      trustAll,
    );
    expect(r).toEqual({
      ok: false,
      code: 'FS_NOT_FOUND',
      message: 'not found',
    });
  });

  it('handler 同步成功 → { ok:true, data }', async () => {
    const r = await processIpcCall(
      z.string(),
      (s) => s.toUpperCase(),
      'hello',
      fileFrame,
      trustAll,
    );
    expect(r).toEqual({ ok: true, data: 'HELLO' });
  });

  it('handler 异步成功 → { ok:true, data }', async () => {
    const r = await processIpcCall(
      z.number(),
      async (n) => {
        await new Promise((res) => setTimeout(res, 1));
        return n * 2;
      },
      21,
      fileFrame,
      trustAll,
    );
    expect(r).toEqual({ ok: true, data: 42 });
  });

  it('handler 返回 undefined → ok:true, data:undefined', async () => {
    const r = await processIpcCall(
      z.unknown(),
      () => undefined,
      'whatever',
      fileFrame,
      trustAll,
    );
    expect(r).toEqual({ ok: true, data: undefined });
  });
});

describe('defaultIsTrustedFrame', () => {
  // dev/prod 都按 process.env 切换,测试时手动管理
  const withEnv = <T,>(value: string | undefined, fn: () => T): T => {
    const orig = process.env['ELECTRON_RENDERER_URL'];
    if (value === undefined) delete process.env['ELECTRON_RENDERER_URL'];
    else process.env['ELECTRON_RENDERER_URL'] = value;
    try {
      return fn();
    } finally {
      if (orig === undefined) delete process.env['ELECTRON_RENDERER_URL'];
      else process.env['ELECTRON_RENDERER_URL'] = orig;
    }
  };

  it('null frame → false', () => {
    expect(defaultIsTrustedFrame(null)).toBe(false);
  });

  it('frame.url 为空字符串 → false', () => {
    expect(defaultIsTrustedFrame({ url: '' })).toBe(false);
  });

  it('file:// 协议 → true(prod renderer 加载方式)', () => {
    expect(defaultIsTrustedFrame({ url: 'file:///path/to/index.html' })).toBe(true);
  });

  it('dev 下,与 ELECTRON_RENDERER_URL 同 origin → true', () => {
    withEnv('http://localhost:5173/', () => {
      expect(
        defaultIsTrustedFrame({ url: 'http://localhost:5173/index.html' }),
      ).toBe(true);
    });
  });

  it('跨 origin → false', () => {
    withEnv('http://localhost:5173/', () => {
      expect(defaultIsTrustedFrame({ url: 'http://evil.com/' })).toBe(false);
    });
  });

  it('frame.url 不可解析 URL → false(防 URL ctor 抛)', () => {
    withEnv('http://localhost:5173/', () => {
      expect(defaultIsTrustedFrame({ url: 'not-a-url' })).toBe(false);
    });
  });

  it('dev URL 未设且非 file:// → false', () => {
    withEnv(undefined, () => {
      expect(defaultIsTrustedFrame({ url: 'http://localhost:5173/' })).toBe(
        false,
      );
    });
  });
});
