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
import {
  MAX_BOUNDED_OBJECT_KEYS,
  MAX_BOUNDED_DEPTH,
  MAX_BOUNDED_ARRAY_LEN,
} from '../../../electron/shared/bounded-input';

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

  // 边界(E76,E73/E75 跨进程同族):外部 MCP client 传畸形 arguments(.strict() schema 大量未知
  // key → 单条超大 unrecognized_keys issue)时,INVALID_PARAMS 的 message 须经 capJoinedMessages
  // 限总长,防超长错误串经 reply/IPC/日志放大。
  it('E76 strict schema 大量未知 key → INVALID_PARAMS message 有上限 + 截断标记', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(
      makeSpec('strictTool', z.object({ a: z.string() }).strict(), () => ({})),
      'p',
    );
    // 边界(E259):key 数须 < MAX_BOUNDED_OBJECT_KEYS,否则被新增的递归 bounded 预检(下方 E259)
    // 提前拦下,走不到 capJoinedMessages 截断路径。500 个长 key 仍产生单条超大 unrecognized_keys message。
    const payload: Record<string, unknown> = { a: 'ok' };
    for (let i = 0; i < 500; i += 1) {
      payload[`unknownKey_${i}_${'x'.repeat(20)}`] = 1;
    }
    const err = await reg
      .invokeLocal('strictTool', payload)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    if (err instanceof PluginMcpError) {
      expect(err.code).toBe(PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS);
      expect(err.message.length).toBeLessThanOrEqual(2048 + 32);
      expect(err.message).toMatch(/truncated|more/);
    }
  });

  // 边界(E259,E255-E258 深化 / schema-阶段放大):main 侧 E255 只预检 arguments 顶层 key,plugin
  // 自定义 inputSchema 可为嵌套 .strict() → 嵌套对象海量 key / 超深 / 超长数组绕过顶层闸,在
  // safeParse 处递归枚举放大。invoke 在 safeParse 前递归 bounded 预检,超限 INVALID_PARAMS 不进 schema。
  describe('E259 嵌套递归 bounded 预检', () => {
    it('嵌套对象海量 key → INVALID_PARAMS(走预检,不进 plugin schema safeParse)', async () => {
      const upstream = makeFakeUpstream();
      const reg = new PluginMcpRegistry(upstream);
      const spec = makeSpec(
        'deep',
        z.object({ outer: z.object({ inner: z.string() }).strict() }).strict(),
        () => ({ ok: true }),
      );
      const spy = vi.spyOn(spec.inputSchema, 'safeParse');
      await reg.register(spec, 'p');

      // 顶层只 1 key(outer)能过 main E255 顶层闸;内层 object 海量 key 触发递归放大。
      const inner: Record<string, unknown> = { inner: 'x' };
      for (let i = 0; i <= MAX_BOUNDED_OBJECT_KEYS; i += 1) inner[`u${i}`] = 1;
      const err = await reg
        .invokeLocal('deep', { outer: inner })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(PluginMcpError);
      expect((err as PluginMcpError).code).toBe(
        PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
      );
      // neutralize 敏感:预检路径 message 含 'exceeds bounds';去预检会走 plugin schema(zod 文案)。
      expect((err as PluginMcpError).message).toMatch(/exceeds bounds/);
      expect(spy).not.toHaveBeenCalled(); // 超限不进 plugin schema
      spy.mockRestore();
    });

    it('嵌套深度超 MAX_BOUNDED_DEPTH → INVALID_PARAMS too-deep', async () => {
      const upstream = makeFakeUpstream();
      const reg = new PluginMcpRegistry(upstream);
      await reg.register(
        makeSpec('d', z.unknown(), () => ({})),
        'p',
      );
      // 构造超 MAX_BOUNDED_DEPTH 的嵌套
      let nested: Record<string, unknown> = {};
      const root = nested;
      for (let i = 0; i < MAX_BOUNDED_DEPTH + 5; i += 1) {
        const child: Record<string, unknown> = {};
        nested['a'] = child;
        nested = child;
      }
      const err = await reg.invokeLocal('d', root).catch((e: unknown) => e);
      expect((err as PluginMcpError).code).toBe(
        PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
      );
      expect((err as PluginMcpError).message).toMatch(/exceeds bounds.*too-deep/);
    });

    it('数组超 MAX_BOUNDED_ARRAY_LEN → INVALID_PARAMS array-too-long', async () => {
      const upstream = makeFakeUpstream();
      const reg = new PluginMcpRegistry(upstream);
      await reg.register(
        makeSpec('arr', z.unknown(), () => ({})),
        'p',
      );
      const big = new Array(MAX_BOUNDED_ARRAY_LEN + 1); // 稀疏,length 超上限即拒(不迭代)
      const err = await reg
        .invokeLocal('arr', { items: big })
        .catch((e: unknown) => e);
      expect((err as PluginMcpError).code).toBe(
        PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
      );
      expect((err as PluginMcpError).message).toMatch(
        /exceeds bounds.*array-too-long/,
      );
    });

    it('正常嵌套输入仍正常 run(回归,预检 fast-path 不破)', async () => {
      const upstream = makeFakeUpstream();
      const reg = new PluginMcpRegistry(upstream);
      await reg.register(
        makeSpec(
          'norm',
          z.object({ outer: z.object({ inner: z.string() }).strict() }).strict(),
          (i) => ({ got: i.outer.inner }),
        ),
        'p',
      );
      await expect(
        reg.invokeLocal('norm', { outer: { inner: 'hi' } }),
      ).resolves.toEqual({ got: 'hi' });
    });
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

// ────────────────────────────────────────────────────────────
// race(R74):reload(dispose→register 同名)必须先 unregister 落地再 register
// ────────────────────────────────────────────────────────────

describe('race(R74) · 同名 tool reload 串行 unregister→register', () => {
  it('dispose 后立即 register 同名:register 等在途 unregister 完成才发 upstream.register', async () => {
    const order: string[] = [];
    let resolveUnreg: () => void = () => {};
    const upstream: PluginMcpUpstream = {
      async register(p) {
        order.push(`register:${p.name}`);
      },
      unregister(name) {
        order.push(`unregister-start:${name}`);
        return new Promise<void>((res) => {
          resolveUnreg = () => {
            order.push(`unregister-done:${name}`);
            res();
          };
        });
      },
    };
    const reg = new PluginMcpRegistry(upstream);

    const d = await reg.register(echoSpec, 'p'); // register:echo
    d.dispose(); // 同步删本地表 + fire-and-forget unregister(in-flight,未 resolve)

    // reload:立即重新 register 同名。应 await 在途 unregister,不得抢先发 register。
    const reRegP = reg.register(echoSpec, 'p');
    // 让微任务跑几圈:若有 bug(不等),register:echo 会在此刻已被推入 order。
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['register:echo', 'unregister-start:echo']);

    // 放行 unregister → re-register 才发 upstream.register。
    resolveUnreg();
    await reRegP;
    expect(order).toEqual([
      'register:echo',
      'unregister-start:echo',
      'unregister-done:echo',
      'register:echo',
    ]);
  });
});

// ────────────────────────────────────────────────────────────
// race(R86):本地 entry 必须在 upstream.register(暴露给 main)之前就位
// ────────────────────────────────────────────────────────────

describe('race(R95) · 并发同名 register await 同一 unregister 后只一个成功', () => {
  it('dispose 后两个并发同名 register:一个成功且 invokeLocal 可用,另一个 TOOL_NAME_TAKEN', async () => {
    let resolveUnreg: () => void = () => {};
    const upstream: PluginMcpUpstream = {
      register: vi.fn(async () => undefined),
      unregister: vi.fn(
        () =>
          new Promise<void>((res) => {
            resolveUnreg = res;
          }),
      ),
    };
    const reg = new PluginMcpRegistry(upstream);
    const d = await reg.register(echoSpec, 'p');
    d.dispose(); // 触发 deferred unregister(in-flight)→ 建立 pendingUnregister

    // 两个并发同名 register:都过首次 has() 检查、都 await 同一个 pending unregister。
    const settleA = reg.register(echoSpec, 'p').then(
      () => 'ok' as const,
      (e: PluginMcpError) => e.code,
    );
    const settleB = reg.register(echoSpec, 'p').then(
      () => 'ok' as const,
      (e: PluginMcpError) => e.code,
    );

    resolveUnreg(); // 放行 unregister → 两者同时继续
    const [a, b] = await Promise.all([settleA, settleB]);

    // 恰好一个成功、一个 TOOL_NAME_TAKEN(不是两个都成功导致 set/delete 互踩)。
    const results = [a, b].sort();
    expect(results).toEqual([
      'ok',
      PLUGIN_MCP_ERROR_CODES.TOOL_NAME_TAKEN,
    ].sort());

    // 成功者的本地 entry 未被失败者的回滚删除 → invokeLocal 仍可用。
    await expect(reg.invokeLocal('echo', { text: 'hi' })).resolves.toEqual({
      echoed: 'hi',
    });
  });
});

describe('race(R86) · 注册先登记本地表再暴露给 main', () => {
  it('upstream.register 进行中(main 已暴露)时 invokeLocal 已可用,不返 NO_SUCH_TOOL', async () => {
    let duringRegister: unknown;
    const holder: { reg?: PluginMcpRegistry } = {};
    const upstream: PluginMcpUpstream = {
      async register() {
        // 模拟 main 完成 register 后外部 MCP client 立即 tools/call(与 register 同一时刻):
        // 此刻本地 entry 必须已就位,否则 invokeLocal 命中 NO_SUCH_TOOL = 刚注册首调失败。
        duringRegister = await holder.reg!.invokeLocal('echo', { text: 'hi' }).then(
          (r) => r,
          (e: unknown) => e,
        );
      },
      async unregister() {},
    };
    holder.reg = new PluginMcpRegistry(upstream);
    await holder.reg.register(echoSpec, 'p');
    expect(duringRegister).toEqual({ echoed: 'hi' });
  });

  it('upstream.register reject → 回滚本地 entry(失败不残留、可重试)', async () => {
    const upstream: PluginMcpUpstream = {
      register: vi
        .fn<PluginMcpUpstream['register']>()
        .mockRejectedValueOnce(new Error('main dup'))
        .mockResolvedValueOnce(undefined),
      unregister: vi.fn(async () => {}),
    };
    const reg = new PluginMcpRegistry(upstream);
    await expect(reg.register(echoSpec, 'p')).rejects.toThrow('main dup');
    // 回滚:本地无残留 → invokeLocal NO_SUCH_TOOL。
    const err = await reg.invokeLocal('echo', { text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    expect((err as PluginMcpError).code).toBe(PLUGIN_MCP_ERROR_CODES.NO_SUCH_TOOL);
    // 可重试:第二次成功。
    await reg.register(echoSpec, 'p');
    await expect(reg.invokeLocal('echo', { text: 'y' })).resolves.toEqual({
      echoed: 'y',
    });
  });
});

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

// ────────────────────────────────────────────────────────────
// 边界(E53,E17 renderer 侧对偶 / E43-E46 同族):register 发 IPC 前预检 name/description/
// jsonSchema/run/inputSchema,超限抛 INVALID_PARAMS、不发 IPC、不写本地 entry。
// ────────────────────────────────────────────────────────────

describe('register · E53 输入预检', () => {
  it('超长 name → INVALID_PARAMS,不发 IPC', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const spec = makeSpec('x'.repeat(257), z.object({}).strict(), () => ({}));
    const err = await reg.register(spec, 'p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    expect((err as PluginMcpError).code).toBe(
      PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
    );
    expect(upstream.registerCalls).toHaveLength(0);
  });

  it('超长 description → INVALID_PARAMS,不发 IPC', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const spec = makeSpec(
      'a',
      z.object({}).strict(),
      () => ({}),
      'd'.repeat(8193),
    );
    await expect(reg.register(spec, 'p')).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
    });
    expect(upstream.registerCalls).toHaveLength(0);
  });

  it('jsonSchema 序列化超 64KB → INVALID_PARAMS,不发 IPC', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const spec = makeSpec('a', z.object({}).strict(), () => ({}));
    (spec as { jsonSchema: Record<string, unknown> }).jsonSchema = {
      big: 'x'.repeat(70 * 1024),
    };
    await expect(reg.register(spec, 'p')).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
    });
    expect(upstream.registerCalls).toHaveLength(0);
  });

  // 边界(E283,E259 / 校验顺序 fail-fast):jsonSchema 校验先做廉价 bounded 预检(深度/数组/key 数)再
  // assertJsonValue + 字节上限。深嵌套 schema(depth>64)字节小、JSON-safe → 旧顺序(assertJsonValue depth
  // 256 + 字节上限)会放行;bounded 预检 depth 64 拒。neutralize 敏感:去预检则此 schema 通过注册。
  it('E283 深嵌套 jsonSchema(depth>64,字节小)→ INVALID_PARAMS(bounded 预检 fail-fast)', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const spec = makeSpec('deep', z.object({}).strict(), () => ({}));
    let nested: Record<string, unknown> = {};
    const root = nested;
    for (let i = 0; i < 70; i += 1) {
      const child: Record<string, unknown> = {};
      nested['a'] = child;
      nested = child;
    }
    (spec as { jsonSchema: Record<string, unknown> }).jsonSchema = root;
    await expect(reg.register(spec, 'p')).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
    });
    expect(upstream.registerCalls).toHaveLength(0);
  });

  // 边界(E130,E128 的 renderer 预检对偶):字节上限按真实 UTF-8 字节。CJK 23K 字≈69KB 字节但
  // length 23K ≤ 64KB,旧 .length 预检会误放行 → 仍 stringify + 发 IPC 到 main(违背防放大契约)。
  it('E130 jsonSchema 多字节真实字节超 64KB(length 未超)→ INVALID_PARAMS,不发 IPC', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const spec = makeSpec('a', z.object({}).strict(), () => ({}));
    (spec as { jsonSchema: Record<string, unknown> }).jsonSchema = {
      big: '中'.repeat(23 * 1024), // ~69KB 字节,length~23K
    };
    await expect(reg.register(spec, 'p')).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
    });
    expect(upstream.registerCalls).toHaveLength(0);
  });

  // 边界(E289,E286 同族 / 字节预算 fail-fast):boundedValueDeepAdmissible 限形态(数组≤65536/key≤1024/
  // 深度≤64)但不限聚合字节。「很多中等元素」jsonSchema(如 enum: 65536 个短串,~256KB)过形态闸 +
  // assertJsonValue,旧顺序在 64KiB 字节 cap 前先 JSON.stringify 物化巨串。jsonByteLowerBoundExceeds 在
  // stringify 前 fail-fast。neutralize 敏感:spy JSON.stringify —— 去预检则落到下游 stringify 才拒。
  it('E289 很多中等元素 jsonSchema(过形态闸但聚合超 64KB)→ INVALID_PARAMS,且 stringify 前 fail-fast', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const spec = makeSpec('big', z.object({}).strict(), () => ({}));
    (spec as { jsonSchema: Record<string, unknown> }).jsonSchema = {
      enum: Array.from({ length: 65536 }, () => 'xx'), // ~256KB > 64KiB,形态合法
    };
    const spy = vi.spyOn(JSON, 'stringify');
    const err = await reg.register(spec, 'p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    expect((err as PluginMcpError).code).toBe(
      PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
    );
    expect(upstream.registerCalls).toHaveLength(0);
    // 关键(neutralize 敏感):字节下界预检在 JSON.stringify 之前拒 → stringify 从未被调用。
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('jsonSchema 不可序列化(循环引用)→ INVALID_PARAMS,不发 IPC', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const spec = makeSpec('a', z.object({}).strict(), () => ({}));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    (spec as { jsonSchema: Record<string, unknown> }).jsonSchema = circular;
    await expect(reg.register(spec, 'p')).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
    });
    expect(upstream.registerCalls).toHaveLength(0);
  });

  it('run 非函数 / inputSchema 无 safeParse → INVALID_PARAMS', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const noRun = makeSpec('a', z.object({}).strict(), () => ({}));
    (noRun as { run: unknown }).run = 'nope';
    await expect(reg.register(noRun, 'p')).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
    });
    const badSchema = makeSpec('b', z.object({}).strict(), () => ({}));
    (badSchema as { inputSchema: unknown }).inputSchema = {};
    await expect(reg.register(badSchema, 'p')).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
    });
    expect(upstream.registerCalls).toHaveLength(0);
  });

  it('上限内正常 spec → 正常发 IPC', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(makeSpec('ok', z.object({}).strict(), () => ({})), 'p');
    expect(upstream.registerCalls).toHaveLength(1);
  });

  // 边界(E105,同 E103):jsonSchema 经 assertJsonValue 拒非 JSON 安全值。JSON.stringify 静默把
  // Infinity/NaN→null、丢 undefined → tools/list 输出与插件注册的 schema 不一致;register 入口拒。
  it('E105 jsonSchema 含 Infinity → register reject INVALID_PARAMS,不发 IPC', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const spec = {
      ...makeSpec('bad', z.object({}).strict(), () => ({})),
      jsonSchema: { type: 'object', x: Infinity },
    };
    const err = await reg.register(spec, 'p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    if (err instanceof PluginMcpError) {
      expect(err.code).toBe(PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS);
    }
    expect(upstream.registerCalls).toHaveLength(0);
  });

  it('E105 jsonSchema 含 undefined 属性 → register reject INVALID_PARAMS', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const spec = {
      ...makeSpec('bad2', z.object({}).strict(), () => ({})),
      jsonSchema: { type: 'object', y: undefined },
    };
    const err = await reg.register(spec, 'p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
  });

  it('E105 jsonSchema 是数组(非纯 object)→ register reject', async () => {
    const upstream = makeFakeUpstream();
    const reg = new PluginMcpRegistry(upstream);
    const spec = {
      ...makeSpec('bad3', z.object({}).strict(), () => ({})),
      jsonSchema: [1, 2, 3] as unknown as Record<string, unknown>,
    };
    const err = await reg.register(spec, 'p').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
  });
});

// (vi 暂未用,但保留 import 让后续 timer/spy 测试场景方便加)
void vi;
