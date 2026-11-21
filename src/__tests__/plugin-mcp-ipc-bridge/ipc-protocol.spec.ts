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

  // 边界(E283,E259 / 校验顺序 fail-fast):jsonSchema 校验先廉价 bounded 预检(深度/数组/key)再
  // assertJsonValue + 字节上限。深嵌套(depth>64)字节小、JSON-safe → 旧顺序放行;bounded 预检拒。
  it('E283 深嵌套 jsonSchema(depth>64,字节小)→ fail(bounded 预检 fail-fast)', () => {
    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let i = 0; i < 70; i += 1) {
      const child: Record<string, unknown> = {};
      nested['a'] = child;
      nested = child;
    }
    expect(
      RegisterPayloadSchema.safeParse({
        pluginId: 'p',
        name: 'x',
        description: '',
        jsonSchema: root,
      }).success,
    ).toBe(false);
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
    // 边界(E188,E185-E187 同族):jsonSchema 改 z.custom+superRefine(去 z.record 前置全量遍历),
    // plain-object 守卫拒 null/数组/原语,assertJsonValue(E183/E184)递归限幅。
    ['E188 jsonSchema null', { pluginId: 'p', name: 'x', description: '', jsonSchema: null }],
    ['E188 jsonSchema 数字', { pluginId: 'p', name: 'x', description: '', jsonSchema: 42 }],
    [
      'E188 jsonSchema 含 sparse 数组(assertJsonValue 拒空洞)',
      {
        pluginId: 'p',
        name: 'x',
        description: '',
        jsonSchema: {
          a: ((): number[] => {
            const x = [1, 2, 3];
            delete x[1]; // 制造空洞,不用 sparse 字面量(no-sparse-arrays)
            return x;
          })(),
        },
      },
    ],
    // 边界(E105,同 E103):jsonSchema 含非 JSON 安全值 → assertJsonValue 拒(JSON.stringify 会
    // 静默把 Infinity→null、丢 undefined,使 tools/list 输出与注册 schema 不一致)。
    [
      'E105 jsonSchema 含 Infinity',
      { pluginId: 'p', name: 'x', description: '', jsonSchema: { x: Infinity } },
    ],
    [
      'E105 jsonSchema 含 undefined 属性',
      { pluginId: 'p', name: 'x', description: '', jsonSchema: { y: undefined } },
    ],
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

  // 边界(E17,E16 同族):register payload 无长度/大小上限 → 恶意插件注册超大 tool schema,
  // 每次 tools/list 序列化广播给 HTTP/stdio 客户端膨胀。加 cap,超限拒绝注册。
  describe('E17 长度/大小上限', () => {
    const ok = {
      pluginId: 'p',
      name: 'x',
      description: '',
      jsonSchema: {},
    };
    it('pluginId 超 256 → fail', () => {
      expect(
        RegisterPayloadSchema.safeParse({ ...ok, pluginId: 'x'.repeat(257) })
          .success,
      ).toBe(false);
    });
    it('name 超 256 → fail', () => {
      expect(
        RegisterPayloadSchema.safeParse({ ...ok, name: 'x'.repeat(257) })
          .success,
      ).toBe(false);
    });
    it('description 超 8192 → fail', () => {
      expect(
        RegisterPayloadSchema.safeParse({ ...ok, description: 'x'.repeat(8193) })
          .success,
      ).toBe(false);
    });
    it('jsonSchema 序列化超 64KB → fail', () => {
      const huge = { type: 'object', big: 'x'.repeat(64 * 1024) };
      expect(
        RegisterPayloadSchema.safeParse({ ...ok, jsonSchema: huge }).success,
      ).toBe(false);
    });
    it('正常大小 jsonSchema → ok', () => {
      const normal = {
        type: 'object',
        properties: { text: { type: 'string', description: 'the input' } },
        required: ['text'],
      };
      expect(
        RegisterPayloadSchema.safeParse({ ...ok, jsonSchema: normal }).success,
      ).toBe(true);
    });

    // 边界(E128,E125 同族):字节上限按真实 UTF-8 字节(非 .length=UTF-16 code unit)。
    // CJK 3 bytes/字:~22k 字 = 66KB 字节但 length 22k ≤ 64KB,旧 .length 判断会误放行。
    it('E128 jsonSchema 多字节真实字节超 64KB(length 未超)→ fail', () => {
      const big = { type: 'object', big: '中'.repeat(23 * 1024) }; // ~69KB 字节,length~23k
      expect(
        RegisterPayloadSchema.safeParse({ ...ok, jsonSchema: big }).success,
      ).toBe(false);
    });
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

  // 边界(E19,E17 同族):result/code/message 无上限 → 恶意插件单次回传超大对象,mcp-host
  // JSON.stringify(result) 输出给客户端膨胀。加序列化字节上限 + 字段长度上限。
  it('E19 result 序列化超 10MB → fail', () => {
    const huge = { data: 'x'.repeat(10 * 1024 * 1024) };
    expect(
      InvokeReplySchema.safeParse({ requestId: 'r', ok: true, result: huge })
        .success,
    ).toBe(false);
  });

  // 边界(E128,E125 同族):result 字节上限按真实 UTF-8 字节。CJK 3 bytes/字:~3.5M 字 > 10MB 字节
  // 但 length 3.5M ≤ 10MB,旧 JSON.stringify(...).length 判断会误放行。
  it('E128 result 多字节真实字节超 10MB(length 未超)→ fail', () => {
    const big = { data: '中'.repeat(3_500_000) }; // ~10.5MB 字节,length~3.5M
    expect(
      InvokeReplySchema.safeParse({ requestId: 'r', ok: true, result: big })
        .success,
    ).toBe(false);
  });

  it('E19 result 不可序列化(循环引用)→ fail', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(
      InvokeReplySchema.safeParse({ requestId: 'r', ok: true, result: circular })
        .success,
    ).toBe(false);
  });

  it('E19 正常大小 result → ok', () => {
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: true,
        result: { lines: ['a', 'b', 'c'] },
      }).success,
    ).toBe(true);
  });

  // 边界(E117,E105/E103 同族):result 只 JSON.stringify 判大小会让非 JSON 安全值通过,但转
  // MCP client 时被静默改写(Infinity/NaN→null、丢 undefined 字段)→ 插件「成功」客户端损坏。
  // 复用 assertJsonValue 拒非 JSON 安全值(与 RegisterPayloadSchema.jsonSchema 同款)。
  it('E117 result 含非有限数(Infinity/NaN)→ fail(防静默改写)', () => {
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: true,
        result: { x: Infinity },
      }).success,
    ).toBe(false);
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: true,
        result: { x: NaN },
      }).success,
    ).toBe(false);
  });

  it('E117 result 嵌套 undefined 字段 → fail(JSON.stringify 会静默丢字段)', () => {
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: true,
        result: { keep: 1, drop: undefined },
      }).success,
    ).toBe(false);
  });

  it('E117 top-level undefined(空结果)仍放行', () => {
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: true,
        result: undefined,
      }).success,
    ).toBe(true);
  });

  it('E19 ok=false code/message 超长 → fail', () => {
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: false,
        code: 'x'.repeat(257),
        message: 'm',
      }).success,
    ).toBe(false);
    expect(
      InvokeReplySchema.safeParse({
        requestId: 'r',
        ok: false,
        code: 'X',
        message: 'x'.repeat(8193),
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
