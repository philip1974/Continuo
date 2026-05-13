// BDD: plugin-mcp-e2e
// 整条链路集成:renderer registry ↔ in-memory IPC ↔ main bridge ↔ 真 createMcpHost(HTTP)。
// 此 spec 在实装前会 red(各 module 不存在)。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  PluginMcpRegistry,
  type PluginMcpUpstream,
  type PluginMcpToolSpec,
} from '../../plugins/registries/PluginMcpRegistry';
import {
  createPluginMcpBridge,
  createInvokeRemote,
  type PluginMcpBridge,
  type PluginMcpToolOwner,
  type InvokeRemoteCore,
} from '../../../electron/main/services/plugin-mcp-bridge.service';
import { PLUGIN_MCP_CHANNELS, PLUGIN_MCP_ERROR_CODES } from '../../../electron/shared/plugin-mcp-channels';
import { createMcpHost, type McpHost } from '../../../electron/main/services/mcp-host.service';

// ─── 内存 IPC 桥 ────────────────────────────────────────────
// renderer.upstream.register/unregister 同步调 main.bridge.handleRegister/handleUnregister。
// main.invokeRemote 通过 send 把 INVOKE 转给 fakeRenderer.onInvoke,后者调 registry.invokeLocal,
// 把 reply 通过 invokeRemote.handleReply 送回。

interface InMemoryHarness {
  bridge: PluginMcpBridge;
  invokeRemote: InvokeRemoteCore;
  registry: PluginMcpRegistry;
  host: McpHost;
  /** 默认 registry 注册到 wcId=11 这个虚拟 owner. */
  readonly fakeWcId: number;
  /** 默认 plugin id. */
  readonly pluginId: string;
}

async function setupHarness(opts: { invokeTimeoutMs?: number } = {}): Promise<InMemoryHarness> {
  const fakeWcId = 11;
  const pluginId = 'demo.echo';

  const host = await createMcpHost({});

  // 双向闭包:invokeRemote 的 send 派发到 fake renderer
  // fake renderer 处理 INVOKE → 调 registry.invokeLocal → 通过 invokeRemote.handleReply 回送。
  // forward decl(send closure ↔ registry/invokeRemote 互引用)→ prefer-const 误判,故 disable.
  // eslint-disable-next-line prefer-const
  let registry: PluginMcpRegistry;
  // eslint-disable-next-line prefer-const
  let invokeRemote: InvokeRemoteCore;

  const send = (
    owner: PluginMcpToolOwner,
    channel: string,
    payload: unknown,
  ): void => {
    if (channel !== PLUGIN_MCP_CHANNELS.INVOKE) return;
    const { requestId, name, input } = payload as {
      requestId: string;
      name: string;
      input: unknown;
    };
    void registry
      .invokeLocal(name, input)
      .then((result) => {
        invokeRemote.handleReply({ requestId, ok: true, result });
      })
      .catch((err: unknown) => {
        const e = err as { code?: string; message?: string };
        invokeRemote.handleReply({
          requestId,
          ok: false,
          code: e.code ?? 'UNKNOWN',
          message: e.message ?? 'unknown error',
        });
      });
  };

  invokeRemote = createInvokeRemote({
    send,
    timeoutMs: opts.invokeTimeoutMs ?? 30000,
  });

  const bridge = createPluginMcpBridge({
    host: {
      registerTool: (t) => host.registerTool(t),
      tools: host.tools,
      removeTool: (name) => host.removeTool(name),
    },
    invokeRemote,
  });

  const upstream: PluginMcpUpstream = {
    async register(p) {
      bridge.handleRegister(fakeWcId, p);
    },
    async unregister(name) {
      bridge.handleUnregister(fakeWcId, name);
    },
  };
  registry = new PluginMcpRegistry(upstream);

  return { bridge, invokeRemote, registry, host, fakeWcId, pluginId };
}

// ─── HTTP RPC helper ────────────────────────────────────────

let nextRpcId = 0;
async function rpc(
  host: McpHost,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }> {
  const id = `req-${++nextRpcId}`;
  const token = host.issueWindowToken(1);
  const res = await fetch(host.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
  return json;
}

// ─── tool fixtures ──────────────────────────────────────────

function helloSpec(): PluginMcpToolSpec {
  return {
    name: 'hello.world',
    description: 'Say hello',
    jsonSchema: {
      type: 'object',
      properties: { who: { type: 'string' } },
      required: ['who'],
      additionalProperties: false,
    },
    inputSchema: z.object({ who: z.string() }).strict(),
    run: (i) => ({ greet: `hello ${(i as { who: string }).who}` }),
  };
}

function boomSpec(code?: string): PluginMcpToolSpec {
  return {
    name: 'boom',
    description: 'Throws',
    jsonSchema: { type: 'object', additionalProperties: false },
    inputSchema: z.object({}).strict(),
    run: () => {
      const err = new Error('biz fail');
      if (code) Object.assign(err, { code });
      throw err;
    },
  };
}

function slowSpec(): PluginMcpToolSpec {
  return {
    name: 'slow',
    description: 'Never resolves',
    jsonSchema: { type: 'object', additionalProperties: false },
    inputSchema: z.object({}).strict(),
    run: () => new Promise(() => {/* never */}),
  };
}

// ─── lifecycle ──────────────────────────────────────────────

let h: InMemoryHarness;
afterEach(async () => {
  if (h?.host) await h.host.close();
});

// ────────────────────────────────────────────────────────────
// 场景 1:注册 → tools/list 见 → tools/call 通
// ────────────────────────────────────────────────────────────

describe('场景 1 · 注册后 MCP client 看得到', () => {
  beforeEach(async () => {
    h = await setupHarness();
  });

  it('注册后 tools/list 包含 hello.world 且字段一致', async () => {
    await h.registry.register(helloSpec(), h.pluginId);
    const r = await rpc(h.host, 'tools/list');
    const tools = (r.result as { tools: Array<{ name: string; description: string; inputSchema: unknown }> }).tools;
    const found = tools.find((t) => t.name === 'hello.world');
    expect(found).toBeDefined();
    expect(found!.description).toBe('Say hello');
    expect(found!.inputSchema).toEqual(helloSpec().jsonSchema);
  });

  it('tools/call hello.world 转发到 plugin run 并返回结果', async () => {
    await h.registry.register(helloSpec(), h.pluginId);
    const r = await rpc(h.host, 'tools/call', {
      name: 'hello.world',
      arguments: { who: 'mcp' },
    });
    const content = (r.result as { content: Array<{ type: string; text: string }> }).content;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
    expect(JSON.parse(content[0]!.text)).toEqual({ greet: 'hello mcp' });
  });
});

// ────────────────────────────────────────────────────────────
// 场景 2:Disposable.dispose 后看不到
// ────────────────────────────────────────────────────────────

describe('场景 2 · dispose 后 MCP client 看不到', () => {
  beforeEach(async () => {
    h = await setupHarness();
  });

  it('dispose 后 tools/list 不含此 tool', async () => {
    const d = await h.registry.register(helloSpec(), h.pluginId);
    d.dispose();
    // unregister 通过内存桥同步触发 bridge.handleUnregister
    await Promise.resolve();
    const r = await rpc(h.host, 'tools/list');
    const tools = (r.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.find((t) => t.name === 'hello.world')).toBeUndefined();
  });

  it('dispose 后 tools/call 返 method/tool not found', async () => {
    const d = await h.registry.register(helloSpec(), h.pluginId);
    d.dispose();
    await Promise.resolve();
    const r = await rpc(h.host, 'tools/call', {
      name: 'hello.world',
      arguments: { who: 'x' },
    });
    expect(r.error).toBeDefined();
    expect(r.error!.code).toBe(-32601);
    expect(r.error!.message).toMatch(/not found/i);
  });
});

// ────────────────────────────────────────────────────────────
// 场景 3:tool.run 抛错 → 错误透传
// ────────────────────────────────────────────────────────────

describe('场景 3 · run 抛错透传', () => {
  beforeEach(async () => {
    h = await setupHarness();
  });

  it('tool.run 抛普通 Error → JSON-RPC error.message = run 抛的 message', async () => {
    await h.registry.register(boomSpec(), h.pluginId);
    const r = await rpc(h.host, 'tools/call', { name: 'boom', arguments: {} });
    expect(r.error).toBeDefined();
    expect(r.error!.message).toBe('biz fail');
  });

  it('tool.run 抛带 code 的错 → JSON-RPC error.data.code 透传', async () => {
    await h.registry.register(boomSpec('PLUGIN_BIZ_FAIL'), h.pluginId);
    const r = await rpc(h.host, 'tools/call', { name: 'boom', arguments: {} });
    expect(r.error).toBeDefined();
    expect((r.error!.data as { code?: string }).code).toBe('PLUGIN_BIZ_FAIL');
  });
});

// ────────────────────────────────────────────────────────────
// 场景 4:多 tool + 单个 dispose
// ────────────────────────────────────────────────────────────

describe('场景 4 · 多 tool 单个 dispose', () => {
  beforeEach(async () => {
    h = await setupHarness();
  });

  it('注册 a/b/c → dispose b → tools/list 含 a/c 不含 b', async () => {
    await h.registry.register({ ...helloSpec(), name: 'a' }, h.pluginId);
    const dB = await h.registry.register({ ...helloSpec(), name: 'b' }, h.pluginId);
    await h.registry.register({ ...helloSpec(), name: 'c' }, h.pluginId);
    dB.dispose();
    await Promise.resolve();
    const r = await rpc(h.host, 'tools/list');
    const names = (r.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name).sort();
    expect(names).toContain('a');
    expect(names).toContain('c');
    expect(names).not.toContain('b');
  });

  it('disposed 的 tool tools/call → not found,其他仍可调', async () => {
    await h.registry.register({ ...helloSpec(), name: 'a' }, h.pluginId);
    const dB = await h.registry.register({ ...helloSpec(), name: 'b' }, h.pluginId);
    dB.dispose();
    await Promise.resolve();
    const ra = await rpc(h.host, 'tools/call', {
      name: 'a',
      arguments: { who: 'A' },
    });
    expect((ra.result as { content: Array<{ text: string }> }).content[0]!.text).toContain('hello A');
    const rb = await rpc(h.host, 'tools/call', {
      name: 'b',
      arguments: { who: 'B' },
    });
    expect(rb.error).toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────
// 场景 5:超时
// ────────────────────────────────────────────────────────────

describe('场景 5 · 超时', () => {
  beforeEach(async () => {
    h = await setupHarness({ invokeTimeoutMs: 100 });
  });

  it('slow tool 调用 100ms 后 reject INVOKE_TIMEOUT,JSON-RPC 响应错误透传', async () => {
    await h.registry.register(slowSpec(), h.pluginId);
    const r = await rpc(h.host, 'tools/call', { name: 'slow', arguments: {} });
    expect(r.error).toBeDefined();
    expect((r.error!.data as { code?: string }).code).toBe(
      PLUGIN_MCP_ERROR_CODES.INVOKE_TIMEOUT,
    );
  }, 5000);
});
