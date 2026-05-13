// BDD: agent-terminal-mcp-dispatcher
// MCP 标准协议路由(initialize / tools/list / tools/call)。

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  dispatchRpc,
  type RpcRequest,
  type AnyMcpTool,
  type ServerInfo,
} from '../../../electron/main/services/mcp-host.service';

const SERVER_INFO: ServerInfo = {
  name: 'continuo-test',
  version: '0.1.0',
  protocolVersion: '2024-11-05',
};
const CTX = { ownerWindowId: 1 };

// ─── tool fixtures ─────────────────────────────────────────────

const echoTool: AnyMcpTool = {
  name: 'echo',
  description: 'Echo input.text back',
  jsonSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  inputSchema: z.object({ text: z.string() }).strict(),
  run: (input: unknown) => {
    const i = input as { text: string };
    return { echoed: i.text };
  },
};

const failTool: AnyMcpTool = {
  name: 'fail',
  description: 'Always throws CUSTOM_FAIL',
  jsonSchema: { type: 'object', additionalProperties: false },
  inputSchema: z.object({}).strict(),
  run: () => {
    throw Object.assign(new Error('boom from tool'), { code: 'CUSTOM_FAIL' });
  },
};

const noopTool: AnyMcpTool = {
  name: 'noop',
  description: 'Does nothing',
  jsonSchema: { type: 'object', additionalProperties: false },
  inputSchema: z.object({}).strict(),
  run: () => ({}),
};

const makeTools = (...t: AnyMcpTool[]) => {
  const m = new Map<string, AnyMcpTool>();
  for (const x of t) m.set(x.name, x);
  return m;
};

const req = (method: string, params: Record<string, unknown> = {}): RpcRequest => ({
  id: 'req-1',
  method,
  params,
});

// ────────────────────────────────────────────────────────────
// initialize
// ────────────────────────────────────────────────────────────

describe('dispatchRpc · initialize', () => {
  it('返回 protocolVersion / serverInfo / capabilities.tools', async () => {
    const r = await dispatchRpc(req('initialize'), makeTools(echoTool), SERVER_INFO, CTX);
    expect(r).toEqual({
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'continuo-test', version: '0.1.0' },
        capabilities: { tools: {} },
      },
    });
  });

  it('忽略 client 发来的 clientInfo / protocolVersion(简化:接受任意客户端)', async () => {
    const r = await dispatchRpc(
      req('initialize', {
        protocolVersion: '0.0.1',
        clientInfo: { name: 'random' },
      }),
      makeTools(),
      SERVER_INFO,
      CTX,
    );
    expect('result' in r).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────
// tools/list
// ────────────────────────────────────────────────────────────

describe('dispatchRpc · tools/list', () => {
  it('返回 tools 数组(name + description + inputSchema)', async () => {
    const r = await dispatchRpc(
      req('tools/list'),
      makeTools(echoTool, failTool),
      SERVER_INFO,
      CTX,
    );
    expect(r).toEqual({
      result: {
        tools: [
          {
            name: 'echo',
            description: 'Echo input.text back',
            inputSchema: echoTool.jsonSchema,
          },
          {
            name: 'fail',
            description: 'Always throws CUSTOM_FAIL',
            inputSchema: failTool.jsonSchema,
          },
        ],
      },
    });
  });

  it('空 tools → tools 数组空', async () => {
    const r = await dispatchRpc(req('tools/list'), makeTools(), SERVER_INFO, CTX);
    expect(r).toEqual({ result: { tools: [] } });
  });

  it('顺序按 Map 插入', async () => {
    const r = await dispatchRpc(
      req('tools/list'),
      makeTools(noopTool, echoTool, failTool),
      SERVER_INFO,
      CTX,
    );
    const names = ((r as { result: { tools: { name: string }[] } }).result.tools).map(
      (t) => t.name,
    );
    expect(names).toEqual(['noop', 'echo', 'fail']);
  });
});

// ────────────────────────────────────────────────────────────
// tools/call
// ────────────────────────────────────────────────────────────

describe('dispatchRpc · tools/call', () => {
  it('正常路径 → result wrapped as content[type=text]', async () => {
    const r = await dispatchRpc(
      req('tools/call', { name: 'echo', arguments: { text: 'hi' } }),
      makeTools(echoTool),
      SERVER_INFO,
      CTX,
    );
    expect(r).toEqual({
      result: {
        content: [
          { type: 'text', text: JSON.stringify({ echoed: 'hi' }) },
        ],
      },
    });
  });

  it('arguments 缺省 → 当 {}', async () => {
    const r = await dispatchRpc(
      req('tools/call', { name: 'noop' }),
      makeTools(noopTool),
      SERVER_INFO,
      CTX,
    );
    expect((r as { result: unknown }).result).toEqual({
      content: [{ type: 'text', text: '{}' }],
    });
  });

  it('params.name 非 string → INVALID_PARAMS', async () => {
    const r = await dispatchRpc(
      req('tools/call', { name: 123, arguments: {} }),
      makeTools(echoTool),
      SERVER_INFO,
      CTX,
    );
    expect(r).toMatchObject({ error: { code: -32602 } });
  });

  it('params.name 缺失 → INVALID_PARAMS', async () => {
    const r = await dispatchRpc(
      req('tools/call', { arguments: {} }),
      makeTools(echoTool),
      SERVER_INFO,
      CTX,
    );
    expect(r).toMatchObject({ error: { code: -32602 } });
  });

  it('未知 tool name → METHOD_NOT_FOUND', async () => {
    const r = await dispatchRpc(
      req('tools/call', { name: 'no.such.tool', arguments: {} }),
      makeTools(echoTool),
      SERVER_INFO,
      CTX,
    );
    expect(r).toMatchObject({
      error: {
        code: -32601,
        message: expect.stringMatching(/tool not found.*no\.such\.tool/),
      },
    });
  });

  it('arguments 不是 plain object(数组)→ INVALID_PARAMS', async () => {
    const r = await dispatchRpc(
      req('tools/call', { name: 'echo', arguments: [1, 2, 3] }),
      makeTools(echoTool),
      SERVER_INFO,
      CTX,
    );
    expect(r).toMatchObject({ error: { code: -32602 } });
  });

  it('inputSchema 校验失败 → INVALID_PARAMS,message 含 zod issues', async () => {
    const r = await dispatchRpc(
      req('tools/call', { name: 'echo', arguments: {} }),
      makeTools(echoTool),
      SERVER_INFO,
      CTX,
    );
    expect(r).toMatchObject({
      error: { code: -32602 },
    });
    // message 不严格断言文案,只要非空
    expect((r as { error: { message: string } }).error.message.length).toBeGreaterThan(0);
  });

  it('run 抛 → INTERNAL_ERROR + data.code 透传原 code', async () => {
    const r = await dispatchRpc(
      req('tools/call', { name: 'fail', arguments: {} }),
      makeTools(failTool),
      SERVER_INFO,
      CTX,
    );
    expect(r).toMatchObject({
      error: {
        code: -32603,
        message: 'boom from tool',
        data: { code: 'CUSTOM_FAIL' },
      },
    });
  });

  it('run 抛非 Error 对象 → INTERNAL_ERROR,message 兜底', async () => {
    const weirdTool: AnyMcpTool = {
      name: 'weird',
      description: 'throws non-Error',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: () => {
         
        throw 'string thrown';
      },
    };
    const r = await dispatchRpc(
      req('tools/call', { name: 'weird', arguments: {} }),
      makeTools(weirdTool),
      SERVER_INFO,
      CTX,
    );
    expect(r).toMatchObject({ error: { code: -32603 } });
  });

  it('async run 成功 → 同步路径不变', async () => {
    const asyncTool: AnyMcpTool = {
      name: 'async',
      description: 'async ok',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: async () => ({ async: true }),
    };
    const r = await dispatchRpc(
      req('tools/call', { name: 'async', arguments: {} }),
      makeTools(asyncTool),
      SERVER_INFO,
      CTX,
    );
    expect((r as { result: unknown }).result).toEqual({
      content: [{ type: 'text', text: '{"async":true}' }],
    });
  });
});

// ────────────────────────────────────────────────────────────
// 未知 method
// ────────────────────────────────────────────────────────────

describe('dispatchRpc · 未知 method', () => {
  it('"foo/bar" → METHOD_NOT_FOUND', async () => {
    const r = await dispatchRpc(req('foo/bar'), makeTools(echoTool), SERVER_INFO, CTX);
    expect(r).toMatchObject({
      error: { code: -32601, message: expect.stringMatching(/foo\/bar/) },
    });
  });

  it('"terminal.list_sessions"(旧形态)→ METHOD_NOT_FOUND', async () => {
    // 标准 MCP client 必须走 tools/call 包装,直接发 tool name 拒
    const r = await dispatchRpc(
      req('terminal.list_sessions'),
      makeTools(echoTool),
      SERVER_INFO,
      CTX,
    );
    expect(r).toMatchObject({ error: { code: -32601 } });
  });
});
