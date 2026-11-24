import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  defaultIsTrustedFrame,
  setTrustedDevOrigin,
  processIpcCall,
  processIpcCallWithCtx,
  ipcInputBounded,
  ERR_CODE_MAX,
  ERR_MESSAGE_MAX,
} from '../../../electron/main/safe-handle';
import {
  MAX_BOUNDED_OBJECT_KEYS as MAX_IPC_INPUT_KEYS,
  MAX_BOUNDED_OBJECT_KEY_LEN as MAX_IPC_INPUT_KEY_LEN,
} from '../../../electron/shared/bounded-input';
import { formatZodErrorCapped } from '../../../electron/main/lib/format-zod-error';

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
  afterEach(() => {
    setTrustedDevOrigin(null);
    vi.unstubAllEnvs();
  });

  it('null frame → false', () => {
    expect(defaultIsTrustedFrame(null)).toBe(false);
  });

  it('frame.url 为空字符串 → false', () => {
    expect(defaultIsTrustedFrame({ url: '' })).toBe(false);
  });

  it('file:// 协议 → true(prod renderer 加载方式)', () => {
    expect(defaultIsTrustedFrame({ url: 'file:///path/to/index.html' })).toBe(true);
  });

  it('dev 下,与 index.ts 注入的 dev origin 同 origin → true', () => {
    setTrustedDevOrigin('http://localhost:5173');
    expect(defaultIsTrustedFrame({ url: 'http://localhost:5173/index.html' })).toBe(true);
  });

  // 纵深对齐:dev origin 只由 index.ts 按 isDev(!app.isPackaged)注入;打包版注入 null,
  // 即使进程环境里带着 ELECTRON_RENDERER_URL,该 origin 的 frame 也不受信。
  it('未注入 dev origin(打包版)→ 即使设了 ELECTRON_RENDERER_URL,同源 frame 也不受信', () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173/');
    expect(defaultIsTrustedFrame({ url: 'http://localhost:5173/index.html' })).toBe(false);
    setTrustedDevOrigin('http://localhost:5173');
    setTrustedDevOrigin(null);
    expect(defaultIsTrustedFrame({ url: 'http://localhost:5173/index.html' })).toBe(false);
  });

  it('跨 origin → false', () => {
    setTrustedDevOrigin('http://localhost:5173');
    expect(defaultIsTrustedFrame({ url: 'http://evil.com/' })).toBe(false);
    expect(defaultIsTrustedFrame({ url: 'http://localhost:5174/' })).toBe(false);
  });

  it('frame.url 不可解析 URL → false(防 URL ctor 抛)', () => {
    setTrustedDevOrigin('http://localhost:5173');
    expect(defaultIsTrustedFrame({ url: 'not-a-url' })).toBe(false);
  });

  // 不透明 origin 序列化为字符串 "null"(file: / data: / about:blank 都是)。误配成这种 dev URL 时
  // 不能让所有不透明 origin 的 frame 互相「同源」。
  it('注入的值不是规范 origin("null" / 空串 / 带路径 / 不可解析)→ 视为未注入', () => {
    for (const bad of ['null', '', 'http://localhost:5173/index.html', 'not-a-url']) {
      setTrustedDevOrigin(bad);
      expect(defaultIsTrustedFrame({ url: 'data:text/html,x' })).toBe(false);
      expect(defaultIsTrustedFrame({ url: 'about:blank' })).toBe(false);
      expect(defaultIsTrustedFrame({ url: 'http://localhost:5173/index.html' })).toBe(false);
    }
  });

  it('接线:safe-handle 不自行读 env;index.ts 以 isDev 为闸注入 dev origin', () => {
    const read = (f: string) => readFileSync(join(process.cwd(), 'electron', 'main', f), 'utf8');
    expect(read('safe-handle.ts')).not.toContain('process.env');
    const index = read('index.ts').replace(/\s+/g, ' ');
    // 注入值来自 devRendererUrl()(与主窗加载方式 / isOwnRendererUrl 共用),后者以 isDev 为闸。
    expect(index).toMatch(/setTrustedDevOrigin\(\s?devRendererUrl\(\)\?\.origin \?\? null,?\s?\);/);
    expect(index).toContain(
      "function devRendererUrl(): URL | null { return isDev ? parseDevRendererUrl(process.env['ELECTRON_RENDERER_URL']) : null; }",
    );
  });
});
