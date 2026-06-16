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
// parseRpcMessage
// ────────────────────────────────────────────────────────────

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
