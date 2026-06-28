import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  defaultIsTrustedFrame,
  processIpcCall,
  processIpcCallWithCtx,
  ipcInputBounded,
  ERR_CODE_MAX,
  ERR_MESSAGE_MAX,
  MAX_IPC_INPUT_KEYS,
  MAX_IPC_INPUT_KEY_LEN,
} from '../../../electron/main/safe-handle';
import { formatZodErrorCapped } from '../../../electron/main/lib/format-zod-error';
import { MAX_WINDOW_URL_LEN } from '../../../electron/shared/url-limits';

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

  // 边界(E73,E57/E62 错误串放大族):.strict() schema 遇大量未知 key 时 zod 生成一条列出全部
  // key 的 unrecognized_keys issue → 错误 message 无界放大经 IPC 返 renderer。formatZodErrorCapped
  // 按总长度上限截断(此为单条超大 message 路径,issue 数闸救不到,靠长度闸兜底)。
  it('E73 .strict() schema 大量未知 key → 错误 message 有长度上限 + 截断标记', async () => {
    // 边界(E256):key 数须 < MAX_IPC_INPUT_KEYS,否则被 ipcInputBounded 预检提前拦下(下方 E256 测试),
    // 走不到 formatZodErrorCapped 长度截断路径。500 个长 key 仍产生单条超大 unrecognized_keys message。
    const schema = z.object({ a: z.string() }).strict();
    const payload: Record<string, unknown> = { a: 'ok' };
    for (let i = 0; i < 500; i += 1) {
      payload[`unknownKey_${i}_${'x'.repeat(20)}`] = 1;
    }
    const r = await processIpcCall(schema, (v) => v, payload, fileFrame, trustAll);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('IPC_BAD_INPUT');
      expect(r.message.length).toBeLessThanOrEqual(2048 + 32); // 远小于未截断的数万字符
      expect(r.message).toMatch(/truncated|more issues/);
    }
  });
});

// 边界(E256,E255 同族 / generic IPC 入口):safeParse 前 bounded 预检(plain object key 数 / key 长度),
// 挡海量未知 key 在 Zod .strict() 枚举 + unrecognized_keys issue 构造阶段放大 main 线程 CPU/内存。
describe('ipcInputBounded(E256)', () => {
  it('非 plain object(string/number/array/null/undefined)→ 放行交给 schema', () => {
    expect(ipcInputBounded('s')).toEqual({ ok: true });
    expect(ipcInputBounded(42)).toEqual({ ok: true });
    expect(ipcInputBounded(null)).toEqual({ ok: true });
    expect(ipcInputBounded(undefined)).toEqual({ ok: true });
    expect(ipcInputBounded([1, 2, 3])).toEqual({ ok: true });
  });

  it('正常 object → ok', () => {
    expect(ipcInputBounded({ a: 1, b: 'x' })).toEqual({ ok: true });
  });

  it('恰好上限内的 key 数 → ok', () => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < MAX_IPC_INPUT_KEYS; i += 1) o[`k${i}`] = 1;
    expect(ipcInputBounded(o)).toEqual({ ok: true });
  });

  it('key 数超 MAX_IPC_INPUT_KEYS → 拒(too many keys)', () => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_IPC_INPUT_KEYS; i += 1) o[`k${i}`] = 1;
    const r = ipcInputBounded(o);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/too many keys/i);
  });

  it('单 key 长度超 MAX_IPC_INPUT_KEY_LEN → 拒(key too long)', () => {
    const r = ipcInputBounded({ ['x'.repeat(MAX_IPC_INPUT_KEY_LEN + 1)]: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/key too long/i);
  });

  it('恰好 MAX_IPC_INPUT_KEY_LEN 的 key → ok', () => {
    expect(
      ipcInputBounded({ ['x'.repeat(MAX_IPC_INPUT_KEY_LEN)]: 1 }),
    ).toEqual({ ok: true });
  });

  it('processIpcCall 海量未知 key payload → BAD_INPUT 且不进入 Zod(message 为预检文案)', async () => {
    const schema = z.object({ a: z.string() }).strict();
    const payload: Record<string, unknown> = { a: 'ok' };
    for (let i = 0; i <= MAX_IPC_INPUT_KEYS; i += 1) payload[`u${i}`] = 1;
    const r = await processIpcCall(schema, (v) => v, payload, fileFrame, trustAll);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('IPC_BAD_INPUT');
      expect(r.message).toMatch(/too many keys/i); // 预检文案,非 zod truncated 标记
      expect(r.message).not.toMatch(/more issues|truncated/);
    }
  });

  it('processIpcCallWithCtx 孪生入口同样预检(ctx-aware)', async () => {
    const schema = z.object({ a: z.string() }).strict();
    const payload: Record<string, unknown> = { a: 'ok' };
    for (let i = 0; i <= MAX_IPC_INPUT_KEYS; i += 1) payload[`u${i}`] = 1;
    const fakeEvent = { senderFrame: fileFrame } as never;
    const r = await processIpcCallWithCtx(
      schema,
      (v) => v,
      payload,
      fakeEvent,
      trustAll,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('IPC_BAD_INPUT');
      expect(r.message).toMatch(/too many keys/i);
    }
  });

  it('正常 payload 仍通过预检 + schema(回归)', async () => {
    const schema = z.object({ a: z.string() }).strict();
    const r = await processIpcCall(schema, (v) => v, { a: 'ok' }, fileFrame, trustAll);
    expect(r).toEqual({ ok: true, data: { a: 'ok' } });
  });
});

// 边界(E73):formatZodErrorCapped 直接单测 —— 多条独立 issue 时按条数上限(20)截断 + 追加
// 「+N more issues」(此为「issue 数很多」路径,与上面「单条 message 很大」路径互补)。
describe('formatZodErrorCapped', () => {
  it('issue 数超 20 → 截断到 20 条 + 「+N more issues」标记', () => {
    // 50 个必填字段全缺 → 50 条独立 issue
    const shape: Record<string, z.ZodTypeAny> = {};
    for (let i = 0; i < 50; i += 1) shape[`f${i}`] = z.string();
    const schema = z.object(shape);
    const parsed = schema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = formatZodErrorCapped(parsed.error);
      expect(msg).toContain('more issues');
      expect(msg).toMatch(/\+30 more issues/); // 50 - 20 = 30
    }
  });

  it('少量 issue → 正常拼接,无截断标记', () => {
    const parsed = z.object({ a: z.string() }).safeParse({ a: 1 });
    if (!parsed.success) {
      const msg = formatZodErrorCapped(parsed.error);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toContain('more issues');
      expect(msg).not.toContain('truncated');
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

  // 边界(E157,E73 同族):handler 抛错的 message/code 经 IPC 回 renderer 前须限幅(BAD_INPUT 已
  // 限幅,handler error 此前原样回传 → 超长 stderr/路径 structured-clone 放大内存/UI)。
  it('E157 handler 抛超长 message → message 截断到 ERR_MESSAGE_MAX(附剩余长度)', async () => {
    const huge = 'x'.repeat(ERR_MESSAGE_MAX + 50_000);
    const r = await processIpcCall(
      z.unknown(),
      () => {
        throw new Error(huge);
      },
      1,
      fileFrame,
      trustAll,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message.length).toBeLessThan(ERR_MESSAGE_MAX + 50);
    expect(r.message.startsWith('x'.repeat(ERR_MESSAGE_MAX))).toBe(true);
    expect(r.message).toContain('…');
    expect(r.message).not.toContain('x'.repeat(ERR_MESSAGE_MAX + 1));
  });

  it('E157 handler 抛超长 code → code 截断到 ERR_CODE_MAX', async () => {
    const r = await processIpcCall(
      z.unknown(),
      () => {
        throw Object.assign(new Error('m'), { code: 'C'.repeat(ERR_CODE_MAX + 500) });
      },
      1,
      fileFrame,
      trustAll,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code.length).toBeLessThan(ERR_CODE_MAX + 50);
    expect(r.code).toContain('…');
  });

  it('E157 正常短 message/code 原样保留(回归)', async () => {
    const r = await processIpcCall(
      z.unknown(),
      () => {
        throw Object.assign(new Error('not found'), { code: 'FS_NOT_FOUND' });
      },
      1,
      fileFrame,
      trustAll,
    );
    expect(r).toEqual({ ok: false, code: 'FS_NOT_FOUND', message: 'not found' });
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

  it('dev 下重复校验同一 expected origin 时缓存 ELECTRON_RENDERER_URL 解析结果', () => {
    const expected = 'http://127.0.0.1:46173/';
    const RealURL = globalThis.URL;
    let expectedConstructs = 0;
    globalThis.URL = function URLSpy(raw: string | URL, base?: string | URL) {
      if (raw === expected) expectedConstructs += 1;
      return new RealURL(raw, base);
    } as unknown as typeof URL;

    try {
      withEnv(expected, () => {
        expect(
          defaultIsTrustedFrame({ url: 'http://127.0.0.1:46173/index.html' }),
        ).toBe(true);
        expect(
          defaultIsTrustedFrame({ url: 'http://127.0.0.1:46173/other.html' }),
        ).toBe(true);
      });
      expect(expectedConstructs).toBe(1);
    } finally {
      globalThis.URL = RealURL;
    }
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

  // 边界(E303,E196/E302 同族):expected(ELECTRON_RENDERER_URL)超 MAX_WINDOW_URL_LEN → fail-closed,
  // 不反复 new URL 解析超长 env(对齐 frame.url 闸)。neutralize 敏感:去 expected 限长则其 origin 仍匹配 → true。
  it('E303 expected(ELECTRON_RENDERER_URL)超 MAX_WINDOW_URL_LEN → false', () => {
    const hugeExpected = 'http://localhost:5173/' + 'a'.repeat(MAX_WINDOW_URL_LEN);
    withEnv(hugeExpected, () => {
      expect(
        defaultIsTrustedFrame({ url: 'http://localhost:5173/index.html' }),
      ).toBe(false);
    });
  });
});
