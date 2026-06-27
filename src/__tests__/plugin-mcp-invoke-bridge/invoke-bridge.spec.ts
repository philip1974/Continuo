// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { startPluginMcpInvokeBridge } from '../../plugins/plugin-mcp-invoke-bridge';
import type {
  InvokePayload,
  InvokeReply,
} from '../../../electron/shared/plugin-mcp-channels';

interface TestApi {
  onInvoke(cb: (payload: InvokePayload) => void): () => void;
  replyInvoke(reply: InvokeReply): void;
  emit(payload: InvokePayload): void;
  replies: InvokeReply[];
  unsubscribed: boolean;
}

function makeApi(): TestApi {
  let cb: ((p: InvokePayload) => void) | null = null;
  const replies: InvokeReply[] = [];
  let unsubscribed = false;
  return {
    onInvoke: (fn) => {
      cb = fn;
      return () => {
        unsubscribed = true;
        cb = null;
      };
    },
    replyInvoke: (r) => {
      replies.push(r);
    },
    emit: (p) => cb?.(p),
    replies,
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

function fakeRegistry(impl: (name: string, input: unknown) => Promise<unknown>) {
  return {
    invokeLocal: vi.fn(impl),
  } as unknown as Parameters<typeof startPluginMcpInvokeBridge>[0];
}

describe('startPluginMcpInvokeBridge', () => {
  beforeEach(() => {
    _resetLmApiForTest();
    delete (window as { api?: unknown }).api;
    delete (window as { __lmApi?: unknown }).__lmApi;
  });

  afterEach(() => {
    _resetLmApiForTest();
    delete (window as { api?: unknown }).api;
    delete (window as { __lmApi?: unknown }).__lmApi;
  });

  it('无 __lmApi.pluginMcp → 返 noop unsub', () => {
    const reg = fakeRegistry(async () => null);
    const unsub = startPluginMcpInvokeBridge(reg);
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('正路径:成功 → replyInvoke ok:true + result', async () => {
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const reg = fakeRegistry(async (name, input) => ({ name, input }));

    startPluginMcpInvokeBridge(reg);
    api.emit({ requestId: 'r1', name: 'tool.foo', input: { x: 1 } });
    await new Promise((r) => setTimeout(r, 0));

    expect(api.replies).toEqual([
      {
        requestId: 'r1',
        ok: true,
        result: { name: 'tool.foo', input: { x: 1 } },
      },
    ]);
  });

  // 边界(E262,E19 同族 / 校验太晚):plugin run() 结果直接 replyInvoke 会先经 preload→main IPC 再在
  // main 校验 10MB/JSON-safe = 上限在 IPC 之后。bridge 发 IPC 前用 isInvokeResultAdmissible 预检,超限/
  // 非 JSON-safe → 不发原 result,改回 ok:false RESULT_TOO_LARGE(对应 pending invoke 立即收口)。
  it('E262 result 超 10MB → 不发原 result,改回 ok:false RESULT_TOO_LARGE', async () => {
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const huge = 'x'.repeat(10 * 1024 * 1024 + 16); // >10MB 序列化
    const reg = fakeRegistry(async () => ({ blob: huge }));

    startPluginMcpInvokeBridge(reg);
    api.emit({ requestId: 'rBig', name: 't', input: null });
    await new Promise((r) => setTimeout(r, 0));

    expect(api.replies).toEqual([
      {
        requestId: 'rBig',
        ok: false,
        code: 'RESULT_TOO_LARGE',
        message: 'plugin tool result is not JSON-safe or exceeds size limit',
      },
    ]);
    // 关键:未发送 ok:true 的原 result(超大 payload 未跨 IPC)
    expect(api.replies.some((r) => 'ok' in r && r.ok === true)).toBe(false);
  });

  it('E262 result 非 JSON-safe(含 Infinity)→ ok:false RESULT_TOO_LARGE,不发原 result', async () => {
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const reg = fakeRegistry(async () => ({ n: Infinity })); // JSON.stringify 静默改 null

    startPluginMcpInvokeBridge(reg);
    api.emit({ requestId: 'rNan', name: 't', input: null });
    await new Promise((r) => setTimeout(r, 0));

    expect(api.replies).toEqual([
      {
        requestId: 'rNan',
        ok: false,
        code: 'RESULT_TOO_LARGE',
        message: 'plugin tool result is not JSON-safe or exceeds size limit',
      },
    ]);
  });

  it('E262 正常小 result 仍 ok:true(回归,预检 fast-path 不破)', async () => {
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const reg = fakeRegistry(async () => ({ ok: 'small' }));

    startPluginMcpInvokeBridge(reg);
    api.emit({ requestId: 'rOk', name: 't', input: null });
    await new Promise((r) => setTimeout(r, 0));

    expect(api.replies).toEqual([
      { requestId: 'rOk', ok: true, result: { ok: 'small' } },
    ]);
  });

  it('Error 含 code 字串 → 透传 code 与 message', async () => {
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const reg = fakeRegistry(async () => {
      throw Object.assign(new Error('schema mismatch'), { code: 'BAD_INPUT' });
    });

    startPluginMcpInvokeBridge(reg);
    api.emit({ requestId: 'r2', name: 't', input: null });
    await new Promise((r) => setTimeout(r, 0));

    expect(api.replies).toEqual([
      {
        requestId: 'r2',
        ok: false,
        code: 'BAD_INPUT',
        message: 'schema mismatch',
      },
    ]);
  });

  // 边界(E263,E262 兄弟 / 校验太晚):catch 分支此前把 err.code/err.message 原样 replyInvoke,
  // code≤256/message≤8192 校验在 main 侧 IPC 之后 → 超长错误串先跨 IPC 放大。发 IPC 前裁剪到 schema 同源上限。
  it('E263 catch 分支超长 err.message/code → 发 IPC 前裁剪(≤ schema 上限)', async () => {
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const longMsg = 'm'.repeat(8192 + 5000);
    const longCode = 'C'.repeat(256 + 500);
    const reg = fakeRegistry(async () => {
      throw Object.assign(new Error(longMsg), { code: longCode });
    });

    startPluginMcpInvokeBridge(reg);
    api.emit({ requestId: 'rLong', name: 't', input: null });
    await new Promise((r) => setTimeout(r, 0));

    expect(api.replies).toHaveLength(1);
    const reply = api.replies[0] as {
      requestId: string;
      ok: false;
      code: string;
      message: string;
    };
    expect(reply.requestId).toBe('rLong');
    expect(reply.ok).toBe(false);
    expect(reply.code.length).toBe(256); // CODE_MAX
    expect(reply.message.length).toBe(8192); // MESSAGE_MAX
    expect(reply.code).toBe('C'.repeat(256));
    expect(reply.message).toBe('m'.repeat(8192));
  });

  it('错误对象无 code/message → fallback UNKNOWN / unknown error', async () => {
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const reg = fakeRegistry(async () => {
      // 抛非标准对象
       
      throw {};
    });

    startPluginMcpInvokeBridge(reg);
    api.emit({ requestId: 'r3', name: 't', input: null });
    await new Promise((r) => setTimeout(r, 0));

    expect(api.replies).toEqual([
      {
        requestId: 'r3',
        ok: false,
        code: 'UNKNOWN',
        message: 'unknown error',
      },
    ]);
  });

  it('返回的 unsub 调用 → 解订阅', () => {
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const reg = fakeRegistry(async () => null);

    const unsub = startPluginMcpInvokeBridge(reg);
    expect(api.unsubscribed).toBe(false);
    unsub();
    expect(api.unsubscribed).toBe(true);
  });

  // race(R98):unsub 后,已进入的 invokeLocal 迟到 resolve/reject 不得再 replyInvoke(否则过期结果
  // 回写 main,污染已取消的 pending / 新生命周期)。active 守卫:unsub 置 false,回写前复查。
  it('R98 unsub 后在途 invokeLocal 的迟到结果不 replyInvoke', async () => {
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    let resolveInvoke: (v: unknown) => void = () => {};
    const reg = fakeRegistry(
      () =>
        new Promise((r) => {
          resolveInvoke = r;
        }),
    );

    const unsub = startPluginMcpInvokeBridge(reg);
    api.emit({ requestId: 'r1', name: 't', input: null }); // invokeLocal 在途
    unsub(); // bridge 卸载(active=false)
    resolveInvoke({ ok: 1 }); // 迟到结果
    await new Promise((r) => setTimeout(r, 0));

    expect(api.replies).toEqual([]); // 迟到结果不回写 main
  });

  // 边界(E172,E168/E169/E170/E171 同族 IPC ingress 纵深防御):main→renderer INVOKE payload runtime
  // 校验(InvokePayloadSchema)。非法但含可用 requestId → 回 INVALID_PARAMS(main pending 收口);无
  // 合法 requestId → drop + warn。两路都不调 invokeLocal。
  it('E172 非法 payload 含可用 requestId(缺 name/缺 input)→ 回 INVALID_PARAMS,不调 invokeLocal', async () => {
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const reg = fakeRegistry(async () => ({}));

    startPluginMcpInvokeBridge(reg);
    // 缺 name
    (api.emit as (p: unknown) => void)({ requestId: 'rq', input: null });
    // 缺 input(InvokePayloadSchema refine 要求 input key 存在)
    (api.emit as (p: unknown) => void)({ requestId: 'rq2', name: 't' });
    await new Promise((r) => setTimeout(r, 0));

    expect(reg.invokeLocal).not.toHaveBeenCalled();
    expect(api.replies).toEqual([
      { requestId: 'rq', ok: false, code: 'INVALID_PARAMS', message: 'invalid invoke payload' },
      { requestId: 'rq2', ok: false, code: 'INVALID_PARAMS', message: 'invalid invoke payload' },
    ]);
  });

  it('E172 无合法 requestId(null / 缺 requestId / 超长 requestId)→ drop + warn,不回写不调用', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = makeApi();
    Object.defineProperty(window, 'api', {
      value: { pluginMcp: api },
      writable: true,
      configurable: true,
    });
    captureLmApi();
    const reg = fakeRegistry(async () => ({}));

    startPluginMcpInvokeBridge(reg);
    const emit = api.emit as (p: unknown) => void;
    expect(() => {
      emit(null);
      emit('a string');
      emit({ name: 't', input: null }); // 缺 requestId
      emit({ requestId: '', name: 't', input: null }); // 空 requestId
      emit({ requestId: 'x'.repeat(257), name: 't', input: null }); // 超长 requestId
    }).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));

    expect(reg.invokeLocal).not.toHaveBeenCalled();
    expect(api.replies).toEqual([]); // 无法关联 → 不回写
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
