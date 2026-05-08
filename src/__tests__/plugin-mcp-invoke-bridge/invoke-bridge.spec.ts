import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const ORIGINAL = (globalThis as Record<string, unknown>).__lmApi;

describe('startPluginMcpInvokeBridge', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).__lmApi;
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).__lmApi = ORIGINAL;
  });

  it('无 __lmApi.pluginMcp → 返 noop unsub', () => {
    const reg = fakeRegistry(async () => null);
    const unsub = startPluginMcpInvokeBridge(reg);
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });

  it('正路径:成功 → replyInvoke ok:true + result', async () => {
    const api = makeApi();
    (globalThis as Record<string, unknown>).__lmApi = { pluginMcp: api };
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

  it('Error 含 code 字串 → 透传 code 与 message', async () => {
    const api = makeApi();
    (globalThis as Record<string, unknown>).__lmApi = { pluginMcp: api };
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

  it('错误对象无 code/message → fallback UNKNOWN / unknown error', async () => {
    const api = makeApi();
    (globalThis as Record<string, unknown>).__lmApi = { pluginMcp: api };
    const reg = fakeRegistry(async () => {
      // 抛非标准对象
      // eslint-disable-next-line no-throw-literal
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
    (globalThis as Record<string, unknown>).__lmApi = { pluginMcp: api };
    const reg = fakeRegistry(async () => null);

    const unsub = startPluginMcpInvokeBridge(reg);
    expect(api.unsubscribed).toBe(false);
    unsub();
    expect(api.unsubscribed).toBe(true);
  });
});
