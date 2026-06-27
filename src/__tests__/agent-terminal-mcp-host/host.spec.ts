// BDD: agent-terminal-mcp-host
// 测 main process MCP host 的纯函数契约层。HTTP/SSE 真行为留 E2E。
//
// 此 spec 在 Phase 1 实装前会 red(module 不存在)。实装目标:
//   electron/main/services/mcp-host.service.ts 按下面 import 的形态 export。

import { describe, it, expect } from 'vitest';
import {
  generateToken,
  verifyBearer,
  parseRpcMessage,
  formatRpcResult,
  formatRpcError,
  isLocalhostBindAddr,
  isLoopbackHostHeader,
  sseAdmissionAllowed,
  checkToolArgsBounded,
  MAX_TOOL_ARG_KEYS,
  MAX_TOOL_ARG_KEY_LEN,
  formatToolCallError,
  parseHttpRequestTarget,
  MAX_REQUEST_TARGET_LEN,
  MCP_ERR_MESSAGE_MAX,
  MCP_ERR_CODE_MAX,
} from '../../../electron/main/services/mcp-host.service';

// ────────────────────────────────────────────────────────────
// generateToken
// ────────────────────────────────────────────────────────────

describe('generateToken', () => {
  it('返回 string,长度 ≥ 32', () => {
    const t = generateToken();
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThanOrEqual(32);
  });

  it('字符集 URL-safe(无 / + =)', () => {
    for (let i = 0; i < 8; i++) {
      const t = generateToken();
      expect(t).not.toMatch(/[/+=]/);
    }
  });

  it('多次调返回值两两不同(32 次抽样)', () => {
    const set = new Set<string>();
    for (let i = 0; i < 32; i++) set.add(generateToken());
    expect(set.size).toBe(32);
  });
});

// ────────────────────────────────────────────────────────────
// verifyBearer
// ────────────────────────────────────────────────────────────

describe('verifyBearer', () => {
  const TOKEN = 'a'.repeat(32);

  it('Bearer <token> 完全匹配 → true', () => {
    expect(verifyBearer(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('scheme 大小写不敏感', () => {
    expect(verifyBearer(`bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(verifyBearer(`BEARER ${TOKEN}`, TOKEN)).toBe(true);
    expect(verifyBearer(`BeArEr ${TOKEN}`, TOKEN)).toBe(true);
  });

  it('header 缺失 → false', () => {
    expect(verifyBearer(undefined, TOKEN)).toBe(false);
  });

  it('非 Bearer scheme → false', () => {
    expect(verifyBearer(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(verifyBearer(`${TOKEN}`, TOKEN)).toBe(false); // 裸 token 也拒
  });

  it('没空格分隔 → false', () => {
    expect(verifyBearer(`Bearer${TOKEN}`, TOKEN)).toBe(false);
  });

  it('token 不匹配 → false', () => {
    expect(verifyBearer(`Bearer ${TOKEN}`, 'b'.repeat(32))).toBe(false);
  });

  it('expected 为空 / 假值 → 一律 false(防未初始化绕过)', () => {
    expect(verifyBearer(`Bearer ${TOKEN}`, '')).toBe(false);
    expect(verifyBearer(`Bearer `, '')).toBe(false);
    // @ts-expect-error 故意传非 string 验证守门
    expect(verifyBearer(`Bearer ${TOKEN}`, undefined)).toBe(false);
  });

  it('长度不同的 token 不会因 timingSafeEqual 抛错(内部需先比长度)', () => {
    expect(() => verifyBearer(`Bearer xxx`, TOKEN)).not.toThrow();
    expect(verifyBearer(`Bearer xxx`, TOKEN)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 边界(E232):SSE 接入准入(全局 + per-token 数量上限)
// ────────────────────────────────────────────────────────────

describe('sseAdmissionAllowed(E232)', () => {
  it('全局与 per-token 均未达上限 → 准入', () => {
    expect(sseAdmissionAllowed(0, 0)).toBe(true);
    expect(sseAdmissionAllowed(10, 5)).toBe(true);
  });

  it('全局达上限(64)→ 拒(即便该 token 连接很少)', () => {
    expect(sseAdmissionAllowed(64, 0)).toBe(false);
    expect(sseAdmissionAllowed(100, 1)).toBe(false);
  });

  it('per-token 达上限(16)→ 拒(即便全局还有空间)', () => {
    expect(sseAdmissionAllowed(20, 16)).toBe(false);
    expect(sseAdmissionAllowed(0, 16)).toBe(false);
  });

  it('上限边界:差一即准入,到达即拒(全局 63→ok/64→拒;token 15→ok/16→拒)', () => {
    expect(sseAdmissionAllowed(63, 15)).toBe(true);
    expect(sseAdmissionAllowed(64, 15)).toBe(false);
    expect(sseAdmissionAllowed(63, 16)).toBe(false);
  });
});

// 边界(E255):tools/call arguments bounded 预检(key 数 / 单 key 长度)。safeParse 前挡 1MB body
// 海量未知短 key 在 Zod .strict() 枚举 + unrecognized_keys issue 构造阶段放大 CPU/内存。
describe('checkToolArgsBounded(E255)', () => {
  it('正常对象 → ok', () => {
    expect(checkToolArgsBounded({})).toEqual({ ok: true });
    expect(checkToolArgsBounded({ a: 1, b: 'x', c: true })).toEqual({ ok: true });
  });

  it('恰好上限内的 key 数 → ok', () => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < MAX_TOOL_ARG_KEYS; i++) o[`k${i}`] = 1;
    expect(checkToolArgsBounded(o)).toEqual({ ok: true });
  });

  it('key 数超 MAX_TOOL_ARG_KEYS → 拒(too many argument keys)', () => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i <= MAX_TOOL_ARG_KEYS; i++) o[`k${i}`] = 1;
    const r = checkToolArgsBounded(o);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/too many argument keys/i);
  });

  it('单 key 长度超 MAX_TOOL_ARG_KEY_LEN → 拒(argument key too long)', () => {
    const longKey = 'x'.repeat(MAX_TOOL_ARG_KEY_LEN + 1);
    const r = checkToolArgsBounded({ [longKey]: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/argument key too long/i);
  });

  it('恰好 MAX_TOOL_ARG_KEY_LEN 的 key → ok', () => {
    expect(
      checkToolArgsBounded({ ['x'.repeat(MAX_TOOL_ARG_KEY_LEN)]: 1 }),
    ).toEqual({ ok: true });
  });
});

// 边界(E266,E73/E157 错误串放大族):tools/call catch 把 tool.run 抛出的 err.message/code 塞进 JSON-RPC
// error 回外部 MCP client,须在 host 边界截断,防畸形/恶意 tool 抛超长串经 JSON-RPC 放大。
describe('formatToolCallError(E266)', () => {
  it('普通 Error → code -32603 + message 透传(短串不变)', () => {
    const r = formatToolCallError(new Error('boom'));
    expect(r.code).toBe(-32603);
    expect(r.message).toBe('boom');
    expect(r.data).toBeUndefined();
  });

  it('带 code 字串 → data.code 透传(短串不变)', () => {
    const r = formatToolCallError(
      Object.assign(new Error('nope'), { code: 'TOOL_FAIL' }),
    );
    expect(r.data).toEqual({ code: 'TOOL_FAIL' });
  });

  it('超长 message → 截断到 MCP_ERR_MESSAGE_MAX(附剩余长度,不含完整原串)', () => {
    const huge = 'm'.repeat(MCP_ERR_MESSAGE_MAX + 5000);
    const r = formatToolCallError(new Error(huge));
    expect(r.message.length).toBeLessThan(MCP_ERR_MESSAGE_MAX + 50);
    expect(r.message.startsWith('m'.repeat(MCP_ERR_MESSAGE_MAX))).toBe(true);
    expect(r.message).toContain('…');
    expect(r.message).not.toContain('m'.repeat(MCP_ERR_MESSAGE_MAX + 1));
  });

  it('超长 code → data.code 截断到 MCP_ERR_CODE_MAX', () => {
    const r = formatToolCallError(
      Object.assign(new Error('x'), { code: 'C'.repeat(MCP_ERR_CODE_MAX + 500) }),
    );
    expect(r.data!.code.length).toBeLessThan(MCP_ERR_CODE_MAX + 50);
    expect(r.data!.code).toContain('…');
  });

  it('非 string message → fallback internal error', () => {
    expect(formatToolCallError({}).message).toBe('internal error');
    expect(formatToolCallError(null).message).toBe('internal error');
  });
});

// ────────────────────────────────────────────────────────────
// parseRpcMessage
// ────────────────────────────────────────────────────────────

describe('parseHttpRequestTarget(E295)', () => {
  it('普通 path 无 query → 原样返回,tooLong=false', () => {
    expect(parseHttpRequestTarget('/mcp')).toEqual({ tooLong: false, path: '/mcp' });
  });
  it('带 query → 去掉 ?后半,只留 path', () => {
    expect(parseHttpRequestTarget('/mcp?a=1&b=2')).toEqual({
      tooLong: false,
      path: '/mcp',
    });
  });
  it('undefined req.url → 默认 "/"', () => {
    expect(parseHttpRequestTarget(undefined)).toEqual({ tooLong: false, path: '/' });
  });
  it('多个 ? → 只在第一个 ? 截断(indexOf,不 split 物化所有分段)', () => {
    expect(parseHttpRequestTarget('/mcp?x=?y=?z').path).toBe('/mcp');
  });
  it('E295 超 MAX_REQUEST_TARGET_LEN → tooLong=true(调用方回 414)', () => {
    const huge = '/mcp?' + 'a'.repeat(MAX_REQUEST_TARGET_LEN);
    expect(parseHttpRequestTarget(huge).tooLong).toBe(true);
  });
  it('E295 恰好 MAX_REQUEST_TARGET_LEN → tooLong=false(边界包含)', () => {
    const exact = '/' + 'a'.repeat(MAX_REQUEST_TARGET_LEN - 1);
    expect(exact.length).toBe(MAX_REQUEST_TARGET_LEN);
    expect(parseHttpRequestTarget(exact).tooLong).toBe(false);
  });
});

describe('parseRpcMessage', () => {
  it('合法请求(string id)→ 结构化', () => {
    const r = parseRpcMessage({
      jsonrpc: '2.0',
      id: 'req-1',
      method: 'terminal.list_sessions',
      params: { limit: 10 },
    });
    expect(r).toEqual({
      id: 'req-1',
      method: 'terminal.list_sessions',
      params: { limit: 10 },
    });
  });

  it('合法请求(number id)', () => {
    const r = parseRpcMessage({
      jsonrpc: '2.0',
      id: 42,
      method: 'x',
    });
    expect(r).toEqual({ id: 42, method: 'x', params: {} });
  });

  it('params 缺省 → 默认 {}', () => {
    const r = parseRpcMessage({ jsonrpc: '2.0', id: 1, method: 'x' });
    expect(r?.params).toEqual({});
  });

  it.each<[string, unknown]>([
    ['null', null],
    ['undefined', undefined],
    ['string', 'hello'],
    ['number', 1],
    ['array', [1, 2, 3]],
    ['jsonrpc 1.0', { jsonrpc: '1.0', id: 1, method: 'x' }],
    ['jsonrpc 缺失', { id: 1, method: 'x' }],
    ['method 空字符串', { jsonrpc: '2.0', id: 1, method: '' }],
    ['method 非 string', { jsonrpc: '2.0', id: 1, method: 123 }],
    ['method 缺失', { jsonrpc: '2.0', id: 1 }],
    ['id 缺失', { jsonrpc: '2.0', method: 'x' }],
    ['id null(本 host 拒)', { jsonrpc: '2.0', id: null, method: 'x' }],
    ['id boolean', { jsonrpc: '2.0', id: true, method: 'x' }],
    ['params 数组(本 host 拒)', { jsonrpc: '2.0', id: 1, method: 'x', params: [1] }],
    ['params 字符串', { jsonrpc: '2.0', id: 1, method: 'x', params: 'hi' }],
    ['params null', { jsonrpc: '2.0', id: 1, method: 'x', params: null }],
  ])('非法 — %s → null', (_, raw) => {
    expect(parseRpcMessage(raw)).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────
// formatRpcResult / formatRpcError
// ────────────────────────────────────────────────────────────

describe('formatRpcResult', () => {
  it('包 jsonrpc 2.0 + id + result', () => {
    const s = formatRpcResult('req-1', { ok: true });
    expect(JSON.parse(s)).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { ok: true },
    });
  });

  it('id 是 number 时透传', () => {
    const s = formatRpcResult(42, null);
    expect(JSON.parse(s)).toEqual({ jsonrpc: '2.0', id: 42, result: null });
  });

  it('返回单行(无 \\n)', () => {
    const s = formatRpcResult(1, { a: 1, b: { c: 2 } });
    expect(s).not.toContain('\n');
  });
});

describe('formatRpcError', () => {
  it('包 jsonrpc 2.0 + id + error', () => {
    const s = formatRpcError('req-1', -32601, 'method not found');
    expect(JSON.parse(s)).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      error: { code: -32601, message: 'method not found' },
    });
  });

  it('data 给值时出现', () => {
    const s = formatRpcError(1, -32602, 'invalid params', { field: 'cwd' });
    expect(JSON.parse(s).error).toEqual({
      code: -32602,
      message: 'invalid params',
      data: { field: 'cwd' },
    });
  });

  it('data 缺省时不出现在 error 对象里(无 data: undefined 字面)', () => {
    const s = formatRpcError(1, -32700, 'parse error');
    const obj = JSON.parse(s);
    expect('data' in obj.error).toBe(false);
  });

  it('parse error / unauthorized 错误码常数符合契约', () => {
    expect(JSON.parse(formatRpcError(null, -32700, 'parse')).error.code).toBe(-32700);
    expect(JSON.parse(formatRpcError(null, -32601, 'nf')).error.code).toBe(-32601);
    expect(JSON.parse(formatRpcError(null, -32602, 'ip')).error.code).toBe(-32602);
    expect(JSON.parse(formatRpcError(null, -32001, 'auth')).error.code).toBe(-32001);
  });
});

// ────────────────────────────────────────────────────────────
// isLocalhostBindAddr
// ────────────────────────────────────────────────────────────

describe('isLocalhostBindAddr', () => {
  it.each(['127.0.0.1', '::1', 'localhost'])('白名单 — %s → true', (addr) => {
    expect(isLocalhostBindAddr(addr)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '::',
    '192.168.1.1',
    '10.0.0.1',
    '8.8.8.8',
    'LOCALHOST', // 大小写敏感(简化判断)
    '127.0.0.2',
    '',
  ])('非白名单 — %s → false', (addr) => {
    expect(isLocalhostBindAddr(addr)).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// isLoopbackHostHeader (DNS rebinding 防护 — 审计 V6)
// ────────────────────────────────────────────────────────────

describe('isLoopbackHostHeader', () => {
  it.each(['127.0.0.1:8080', 'localhost:8080', '[::1]:8080', 'LOCALHOST:8080'])(
    '回环 Host + 正确端口 → true (%s)',
    (h) => {
      expect(isLoopbackHostHeader(h, 8080)).toBe(true);
    },
  );

  it.each([
    'evil.com:8080', // DNS rebinding:攻击者域名
    '127.0.0.1:9999', // 端口不符
    '192.168.1.5:8080',
    '127.0.0.1', // 缺端口
    undefined,
    '',
  ])('非回环 / 端口不符 / 缺失 → false (%s)', (h) => {
    expect(isLoopbackHostHeader(h as string | undefined, 8080)).toBe(false);
  });

  it('port<=0 一律 false', () => {
    expect(isLoopbackHostHeader('127.0.0.1:0', 0)).toBe(false);
  });
});
