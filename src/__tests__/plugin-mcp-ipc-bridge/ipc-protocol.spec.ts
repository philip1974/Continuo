// BDD: plugin-mcp-ipc-bridge
// 测 renderer ↔ main IPC 协议形态:channel 常量 + 4 套 payload zod schema + error codes。
// 此 spec 在实装前会 red(module 不存在)。实装目标:
//   electron/shared/plugin-mcp-channels.ts 按下面 import 的形态 export。

import { describe, it, expect } from 'vitest';
import {
  PLUGIN_MCP_CHANNELS,
  PLUGIN_MCP_ERROR_CODES,
} from '../../../electron/shared/plugin-mcp-channels';
import {
  RegisterPayloadSchema,
  UnregisterPayloadSchema,
  InvokePayloadSchema,
  InvokeReplySchema,
} from '../../../electron/shared/plugin-mcp-schemas';

// ────────────────────────────────────────────────────────────
// Channel 名常量
// ────────────────────────────────────────────────────────────

describe('PLUGIN_MCP_CHANNELS', () => {
  it('4 个 channel 名字面字符串契约', () => {
    expect(PLUGIN_MCP_CHANNELS.REGISTER).toBe('plugin-mcp:register');
    expect(PLUGIN_MCP_CHANNELS.UNREGISTER).toBe('plugin-mcp:unregister');
    expect(PLUGIN_MCP_CHANNELS.INVOKE).toBe('plugin-mcp:invoke');
    expect(PLUGIN_MCP_CHANNELS.INVOKE_REPLY).toBe('plugin-mcp:invoke-reply');
  });
});

// ────────────────────────────────────────────────────────────
// RegisterPayloadSchema
// ────────────────────────────────────────────────────────────

describe('RegisterPayloadSchema', () => {
  it('合法 payload → ok', () => {
    const r = RegisterPayloadSchema.safeParse({
      pluginId: 'demo.echo',
      name: 'echo',
      description: '回显输入',
      jsonSchema: { type: 'object', properties: { text: { type: 'string' } } },
    });
    expect(r.success).toBe(true);
  });

  it('description 空字符串 → ok', () => {
    expect(
      RegisterPayloadSchema.safeParse({
        pluginId: 'p',
        name: 'x',
        description: '',
        jsonSchema: {},
      }).success,
    ).toBe(true);
  });

  it.each<[string, unknown]>([
    ['缺 pluginId', { name: 'x', description: '', jsonSchema: {} }],
    ['缺 name', { pluginId: 'p', description: '', jsonSchema: {} }],
    ['缺 description', { pluginId: 'p', name: 'x', jsonSchema: {} }],
    ['缺 jsonSchema', { pluginId: 'p', name: 'x', description: '' }],
    ['pluginId 空串', { pluginId: '', name: 'x', description: '', jsonSchema: {} }],
    ['name 空串', { pluginId: 'p', name: '', description: '', jsonSchema: {} }],
    ['name 非 string', { pluginId: 'p', name: 1, description: '', jsonSchema: {} }],
    ['jsonSchema 是数组', { pluginId: 'p', name: 'x', description: '', jsonSchema: [] }],
    ['jsonSchema 是 string', { pluginId: 'p', name: 'x', description: '', jsonSchema: 'x' }],
    [
      '多余字段',
      {
        pluginId: 'p',
        name: 'x',
        description: '',
        jsonSchema: {},
        extra: 1,
      },
    ],
  ])('非法 — %s → fail', (_, raw) => {
    expect(RegisterPayloadSchema.safeParse(raw).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// UnregisterPayloadSchema
// ────────────────────────────────────────────────────────────

describe('UnregisterPayloadSchema', () => {
  it('{ name: "x" } → ok', () => {
    expect(UnregisterPayloadSchema.safeParse({ name: 'x' }).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['空对象', {}],
    ['name 空串', { name: '' }],
    ['name 非 string', { name: 123 }],
    ['多余字段', { name: 'x', extra: 1 }],
  ])('非法 — %s → fail', (_, raw) => {
    expect(UnregisterPayloadSchema.safeParse(raw).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// InvokePayloadSchema(main → renderer)
// ────────────────────────────────────────────────────────────

describe('InvokePayloadSchema', () => {
  it('合法 payload(input 是 object)→ ok', () => {
    expect(
      InvokePayloadSchema.safeParse({
        requestId: 'req-1',
        name: 'echo',
        input: { text: 'hi' },
      }).success,
    ).toBe(true);
  });

  it.each<[string, unknown]>([
    ['input null', { requestId: 'r', name: 'x', input: null }],
    ['input string', { requestId: 'r', name: 'x', input: 'hi' }],
    ['input number', { requestId: 'r', name: 'x', input: 42 }],
    ['input boolean', { requestId: 'r', name: 'x', input: true }],
    ['input array', { requestId: 'r', name: 'x', input: [1, 2] }],
  ])('input 任意类型 — %s → ok', (_, raw) => {
    expect(InvokePayloadSchema.safeParse(raw).success).toBe(true);
  });

  it.each<[string, unknown]>([
    ['缺 requestId', { name: 'x', input: {} }],
    ['缺 name', { requestId: 'r', input: {} }],
    ['缺 input', { requestId: 'r', name: 'x' }],
    ['requestId 空串', { requestId: '', name: 'x', input: {} }],
    ['name 空串', { requestId: 'r', name: '', input: {} }],
    ['多余字段', { requestId: 'r', name: 'x', input: {}, extra: 1 }],
  ])('非法 — %s → fail', (_, raw) => {
    expect(InvokePayloadSchema.safeParse(raw).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// InvokeReplySchema(renderer → main)
// ────────────────────────────────────────────────────────────

describe('InvokeReplySchema · ok=true', () => {
  it('{ ok:true, result:object } → ok', () => {
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: true,
        result: { echoed: 'hi' },
      }).success,
    ).toBe(true);
  });

  it('result 可任意类型(null / primitive / array)', () => {
    for (const result of [null, 'str', 42, true, [1, 2]]) {
      expect(
        InvokeReplySchema.safeParse({ requestId: 'r', ok: true, result })
          .success,
      ).toBe(true);
    }
  });

  it('ok=true 同时含 code 字段 → fail(strict)', () => {
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: true,
        result: 1,
        code: 'X',
      }).success,
    ).toBe(false);
  });
});

describe('InvokeReplySchema · ok=false', () => {
  it('合法 error reply → ok', () => {
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: false,
        code: 'NO_SUCH_TOOL',
        message: 'tool x not found',
      }).success,
    ).toBe(true);
  });

  it('ok=false message 空字符串 → ok(允许空消息)', () => {
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: false,
        code: 'X',
        message: '',
      }).success,
    ).toBe(true);
  });

  it.each<[string, unknown]>([
    ['ok=false 缺 code', { requestId: 'r', ok: false, message: 'x' }],
    ['ok=false 缺 message', { requestId: 'r', ok: false, code: 'X' }],
    ['ok=false code 空串', { requestId: 'r', ok: false, code: '', message: 'x' }],
    [
      'ok=false 同时含 result',
      { requestId: 'r', ok: false, code: 'X', message: 'x', result: 1 },
    ],
  ])('非法 — %s → fail', (_, raw) => {
    expect(InvokeReplySchema.safeParse(raw).success).toBe(false);
  });
});

describe('InvokeReplySchema · 共通', () => {
  it.each<[string, unknown]>([
    ['空对象', {}],
    ['ok 缺', { requestId: 'r', result: 1 }],
    ['ok 是 string', { requestId: 'r', ok: 'true', result: 1 }],
    ['requestId 缺', { ok: true, result: 1 }],
    ['requestId 空串', { requestId: '', ok: true, result: 1 }],
  ])('非法 — %s → fail', (_, raw) => {
    expect(InvokeReplySchema.safeParse(raw).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// 错误码常量
// ────────────────────────────────────────────────────────────

describe('PLUGIN_MCP_ERROR_CODES', () => {
  it('包含 8 个 code 字面字符串契约', () => {
    expect(PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN).toBe('TOOL_NAME_TAKEN');
    expect(PLUGIN_MCP_ERROR_CODES.NO_SUCH_TOOL).toBe('NO_SUCH_TOOL');
    expect(PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS).toBe('INVALID_PARAMS');
    expect(PLUGIN_MCP_ERROR_CODES.TOOL_DISPOSED).toBe('TOOL_DISPOSED');
    expect(PLUGIN_MCP_ERROR_CODES.INVOKE_TIMEOUT).toBe('INVOKE_TIMEOUT');
    expect(PLUGIN_MCP_ERROR_CODES.PLUGIN_GONE).toBe('PLUGIN_GONE');
    expect(PLUGIN_MCP_ERROR_CODES.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
    expect(PLUGIN_MCP_ERROR_CODES.INVALID_REPLY).toBe('INVALID_REPLY');
  });

  it('每个 code 值与其 key 同名(便于序列化反射)', () => {
    for (const [k, v] of Object.entries(PLUGIN_MCP_ERROR_CODES)) {
      expect(v).toBe(k);
    }
  });
});
