// BDD: plugin-mcp-registry
// 测 renderer 侧 PluginMcpRegistry 的纯函数层(注入 fake upstream)。
//
// 此 spec 在实装前会 red(module 不存在)。实装目标:
//   src/plugins/registries/PluginMcpRegistry.ts 按下面 import 的形态 export。

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import {
  PluginMcpRegistry,
  PluginMcpError,
  PLUGIN_MCP_ERROR_CODES,
  type PluginMcpToolSpec,
  type PluginMcpUpstream,
  type PluginMcpUpstreamRegisterPayload,
} from '../../plugins/registries/PluginMcpRegistry';

// ─── fake upstream ─────────────────────────────────────────────

interface FakeUpstream extends PluginMcpUpstream {
  readonly registerCalls: PluginMcpUpstreamRegisterPayload[];
  readonly unregisterCalls: string[];
  failNextRegister?: (() => Error) | null;
}

function makeFakeUpstream(): FakeUpstream {
  const registerCalls: PluginMcpUpstreamRegisterPayload[] = [];
  const unregisterCalls: string[] = [];
  const fake: FakeUpstream = {
    registerCalls,
    unregisterCalls,
    failNextRegister: null,
    async register(p) {
      if (fake.failNextRegister) {
        const err = fake.failNextRegister();
        fake.failNextRegister = null;
        throw err;
      }
      registerCalls.push(p);
    },
    async unregister(name) {
      unregisterCalls.push(name);
    },
  };
  return fake;
}

// ─── tool spec fixture ────────────────────────────────────────

function makeSpec<I, O>(
  name: string,
  inputSchema: z.ZodType<I>,
  run: (i: I) => O | Promise<O>,
  description = `${name} description`,
): PluginMcpToolSpec<I, O> {
  return {
    name,
    description,
    jsonSchema: { type: 'object', additionalProperties: false },
    inputSchema,
    run,
  };
}

const echoSpec = makeSpec(
  'echo',
  z.object({ text: z.string() }).strict(),
  (i) => ({ echoed: i.text }),
);

// ────────────────────────────────────────────────────────────
// register — 成功路径
// ────────────────────────────────────────────────────────────

describe('register · 成功路径', () => {
  it('调 upstream.register 一次,payload 含 pluginId/name/description/jsonSchema', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(echoSpec, 'p.alpha');
    expect(upstream.registerCalls).toHaveLength(1);
    expect(upstream.registerCalls[0]).toEqual({
      pluginId: 'p.alpha',
      name: 'echo',
      description: 'echo description',
      jsonSchema: { type: 'object', additionalProperties: false },
    });
  });

  it('await register 返回 Disposable 含 dispose 函数', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const d = await reg.register(echoSpec, 'p');
    expect(typeof d.dispose).toBe('function');
  });

  it('多个不同 name 可并存,upstream.register 各调一次', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(makeSpec('a', z.object({}).strict(), () => ({})), 'p');
    await reg.register(makeSpec('b', z.object({}).strict(), () => ({})), 'p');
    await reg.register(makeSpec('c', z.object({}).strict(), () => ({})), 'p');
    expect(upstream.registerCalls.map((c) => c.name)).toEqual(['a', 'b', 'c']);
  });
});

// ────────────────────────────────────────────────────────────
// register — 同 renderer 重名
// ────────────────────────────────────────────────────────────

describe('register · 同 renderer 内重名', () => {
  it('第二次 register 同名 → reject TOOL_NAME_TAKEN', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(echoSpec, 'p');
    const err = await reg.register(echoSpec, 'p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    if (err instanceof PluginMcpError) {
      expect(err.code).toBe(PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN);
    }
  });

  it('重名时不调 upstream.register 第二次', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(echoSpec, 'p');
    await reg.register(echoSpec, 'p').catch(() => {});
    expect(upstream.registerCalls).toHaveLength(1);
  });

  it('dispose 第一次后再 register 同名 → 成功(name 已腾出)', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const d1 = await reg.register(echoSpec, 'p');
    d1.dispose();
    await expect(reg.register(echoSpec, 'p')).resolves.toBeDefined();
    expect(upstream.registerCalls).toHaveLength(2);
  });
});

// ────────────────────────────────────────────────────────────
// register — upstream 抛错
// ────────────────────────────────────────────────────────────

describe('register · upstream 抛错', () => {
  it('upstream.register reject → register reject 同错', async () => {
    const upstream = makeFakeUpstream();
    upstream.failNextRegister = () =>
      Object.assign(new Error('main 端拒绝'), {
        code: PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN,
      });
    const reg = new PluginMcpRegistry(upstream);
    const err = await reg.register(echoSpec, 'p').catch((e: unknown) => e);
    expect((err as Error).message).toBe('main 端拒绝');
  });

  it('upstream 抛错 → 本地表不登记,可重试', async () => {
    const upstream = makeFakeUpstream();
    upstream.failNextRegister = () => new Error('一次性失败');
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(echoSpec, 'p').catch(() => {});
    // 重试应成功
    await expect(reg.register(echoSpec, 'p')).resolves.toBeDefined();
  });
});

// ────────────────────────────────────────────────────────────
// Disposable.dispose
// ────────────────────────────────────────────────────────────

describe('Disposable.dispose', () => {
  it('dispose 调 upstream.unregister(name) 一次', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const d = await reg.register(echoSpec, 'p');
    d.dispose();
    // 等微任务跑完(dispose 内部异步 unregister)
    await Promise.resolve();
    expect(upstream.unregisterCalls).toEqual(['echo']);
  });

  it('dispose 多次调用幂等(只 unregister 一次)', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const d = await reg.register(echoSpec, 'p');
    d.dispose();
    d.dispose();
    d.dispose();
    await Promise.resolve();
    expect(upstream.unregisterCalls).toEqual(['echo']);
  });

  it('dispose 一个 tool 不影响其他 tool', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const dA = await reg.register(makeSpec('a', z.object({}).strict(), () => 1), 'p');
    await reg.register(makeSpec('b', z.object({}).strict(), () => 2), 'p');
    dA.dispose();
    await Promise.resolve();
    expect(upstream.unregisterCalls).toEqual(['a']);
    // b 仍可 invoke
    await expect(reg.invokeLocal('b', {})).resolves.toBe(2);
  });
});

// ────────────────────────────────────────────────────────────
// invokeLocal — 派发
// ────────────────────────────────────────────────────────────

describe('invokeLocal · 派发本地 run', () => {
  it('校验通过 → 调 spec.run 并 resolve 其返回值', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(echoSpec, 'p');
    const r = await reg.invokeLocal('echo', { text: 'hi' });
    expect(r).toEqual({ echoed: 'hi' });
  });

  it('支持 async run', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(
      makeSpec('async', z.object({ x: z.number() }).strict(), async (i) => {
        await new Promise((r) => setTimeout(r, 5));
        return { y: i.x * 2 };
      }),
      'p',
    );
    await expect(reg.invokeLocal('async', { x: 21 })).resolves.toEqual({ y: 42 });
  });

  it('未注册的 name → reject NO_SUCH_TOOL', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const err = await reg.invokeLocal('ghost', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    if (err instanceof PluginMcpError) {
      expect(err.code).toBe(PLUGIN_MCP_ERROR_CODES.NO_SUCH_TOOL);
    }
  });

  it('input 不符 inputSchema → reject INVALID_PARAMS,message 含 zod issue', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(echoSpec, 'p');
    const err = await reg
      .invokeLocal('echo', { text: 123 }) // 应是 string
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    if (err instanceof PluginMcpError) {
      expect(err.code).toBe(PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS);
      expect(err.message.length).toBeGreaterThan(0);
    }
  });

  it('inputSchema strict 拒未知字段', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(echoSpec, 'p');
    const err = await reg
      .invokeLocal('echo', { text: 'ok', extra: 1 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    if (err instanceof PluginMcpError) {
      expect(err.code).toBe(PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS);
    }
  });

  it('spec.run 抛 Error → invokeLocal reject 透传 message', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(
      makeSpec('boom', z.object({}).strict(), () => {
        throw new Error('boom inside run');
      }),
      'p',
    );
    const err = await reg.invokeLocal('boom', {}).catch((e: unknown) => e);
    expect((err as Error).message).toBe('boom inside run');
  });

  it('spec.run 抛带 code 的错 → 保留 code', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(
      makeSpec('coded', z.object({}).strict(), () => {
        throw Object.assign(new Error('user msg'), { code: 'PLUGIN_BIZ_FAIL' });
      }),
      'p',
    );
    const err = await reg.invokeLocal('coded', {}).catch((e: unknown) => e);
    expect((err as { code?: string }).code).toBe('PLUGIN_BIZ_FAIL');
  });

  it('dispose 后再 invokeLocal → reject NO_SUCH_TOOL', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const d = await reg.register(echoSpec, 'p');
    d.dispose();
    const err = await reg.invokeLocal('echo', { text: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    if (err instanceof PluginMcpError) {
      expect(err.code).toBe(PLUGIN_MCP_ERROR_CODES.NO_SUCH_TOOL);
    }
  });
});

// ────────────────────────────────────────────────────────────
// PluginMcpError
// ────────────────────────────────────────────────────────────

describe('PluginMcpError', () => {
  it('code 字段暴露,继承 Error', () => {
    const err = new PluginMcpError('TOOL_NAME_TAKEN', 'name x taken');
    expect(err.code).toBe('TOOL_NAME_TAKEN');
    expect(err.message).toBe('name x taken');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('PluginMcpError');
  });
});

// ────────────────────────────────────────────────────────────
// 错误码常量
// ────────────────────────────────────────────────────────────

describe('PLUGIN_MCP_ERROR_CODES', () => {
  it('包含本主题用到的 4 个 code', () => {
    expect(PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN).toBe('TOOL_NAME_TAKEN');
    expect(PLUGIN_MCP_ERROR_CODES.NO_SUCH_TOOL).toBe('NO_SUCH_TOOL');
    expect(PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS).toBe('INVALID_PARAMS');
    expect(PLUGIN_MCP_ERROR_CODES.TOOL_DISPOSED).toBe('TOOL_DISPOSED');
  });
});

// (vi 暂未用,但保留 import 让后续 timer/spy 测试场景方便加)
void vi;
