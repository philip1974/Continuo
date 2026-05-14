// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  _resetLmApiForTest,
  captureLmApi,
} from '../../lib/co-api';
import { createIpcPluginMcpUpstream } from '../../plugins/plugin-mcp-upstream';

interface FakeApi {
  registerTool: ReturnType<typeof vi.fn>;
  unregisterTool: ReturnType<typeof vi.fn>;
}

function installApi(api: FakeApi): void {
  Object.defineProperty(window, 'api', {
    value: { pluginMcp: api },
    writable: true,
    configurable: true,
  });
  captureLmApi();
}

beforeEach(() => {
  _resetLmApiForTest();
  delete (window as { api?: unknown }).api;
  delete (window as { __lmApi?: unknown }).__lmApi;
});

afterEach(() => {
  _resetLmApiForTest();
  delete (window as { api?: unknown }).api;
  delete (window as { __lmApi?: unknown }).__lmApi;
  vi.restoreAllMocks();
});

const PAYLOAD = {
  pluginId: 'p1',
  name: 'tool.foo',
  description: 'desc',
  inputSchema: {},
};

describe('createIpcPluginMcpUpstream.register', () => {
  it('preload 缺 → 抛 PRELOAD_NOT_READY', async () => {
    const u = createIpcPluginMcpUpstream();
    try {
      await u.register(PAYLOAD as never);
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as Error).message).toMatch(/preload/i);
      expect((err as { code?: string }).code).toBe('PRELOAD_NOT_READY');
    }
  });

  it('ok=true → resolve,registerTool 收到 payload', async () => {
    const registerTool = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    installApi({ registerTool, unregisterTool: vi.fn() });

    const u = createIpcPluginMcpUpstream();
    await expect(u.register(PAYLOAD as never)).resolves.toBeUndefined();
    expect(registerTool).toHaveBeenCalledWith(PAYLOAD);
  });

  it('ok=false → 抛带 code 与 message', async () => {
    const registerTool = vi.fn().mockResolvedValue({
      ok: false,
      code: 'NAME_TAKEN',
      message: 'already',
    });
    installApi({ registerTool, unregisterTool: vi.fn() });

    const u = createIpcPluginMcpUpstream();
    try {
      await u.register(PAYLOAD as never);
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as Error).message).toBe('already');
      expect((err as { code?: string }).code).toBe('NAME_TAKEN');
    }
  });
});

describe('createIpcPluginMcpUpstream.unregister', () => {
  it('preload 缺 → 静默 resolve', async () => {
    const u = createIpcPluginMcpUpstream();
    await expect(u.unregister('tool.foo')).resolves.toBeUndefined();
  });

  it('ok=true → resolve', async () => {
    const unregisterTool = vi.fn().mockResolvedValue({ ok: true, data: undefined });
    installApi({ registerTool: vi.fn(), unregisterTool });

    const u = createIpcPluginMcpUpstream();
    await u.unregister('tool.foo');
    expect(unregisterTool).toHaveBeenCalledWith('tool.foo');
  });

  it('ok=false → console.warn,不抛', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    installApi({
      registerTool: vi.fn(),
      unregisterTool: vi.fn().mockResolvedValue({
        ok: false,
        code: 'NOT_FOUND',
        message: 'gone',
      }),
    });

    const u = createIpcPluginMcpUpstream();
    await expect(u.unregister('tool.foo')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unregister "tool.foo" failed'),
      'NOT_FOUND',
      'gone',
    );
  });
});
