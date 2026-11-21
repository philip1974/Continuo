// @vitest-environment jsdom
// 撤销 mcp-tools 权限后已注册的工具(终审 P1):每次调用分发到 run 前重查权限(兜底),
// 收到授权变更时重查并注销该插件全部 MCP 工具(工具列表准确)。见同目录 README.md。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('@/lib/co-api', () => ({
  coApi: {
    pluginFsRaw: {
      _registerPlugin: async () => ({ token: 'tok', generation: 1 }),
      _unregisterPlugin: async () => undefined,
    },
  },
}));

import { Plugin } from '../../plugins/Plugin';
import { PluginManager, type ManagerHost } from '../../plugins/PluginManager';
import { InMemoryPermissionStore } from '../../plugins/permissions';
import {
  PluginMcpRegistry,
  type PluginMcpUpstream,
} from '../../plugins/registries/PluginMcpRegistry';
import { createTestCoApp } from '../../plugins/test-utils';

const ID = 'com.x.mcp';
const TOOL = 'x_echo';

const run = vi.fn((input: { v: string }) => ({ echoed: input.v }));

class McpPlugin extends Plugin {
  async onload() {
    await this.registerMcpTool({
      name: TOOL,
      description: 'echo',
      jsonSchema: { type: 'object' },
      inputSchema: z.object({ v: z.string() }),
      run,
    });
  }
}

function setup(PluginClass: typeof Plugin = McpPlugin): {
  mgr: PluginManager;
  registry: PluginMcpRegistry;
  store: InMemoryPermissionStore;
  upstream: { register: ReturnType<typeof vi.fn>; unregister: ReturnType<typeof vi.fn> };
} {
  const upstream = {
    register: vi.fn().mockResolvedValue(undefined),
    unregister: vi.fn().mockResolvedValue(undefined),
  };
  const registry = new PluginMcpRegistry(upstream as PluginMcpUpstream);
  const store = new InMemoryPermissionStore();
  const host: ManagerHost = {
    listPluginDirs: () => [
      {
        id: ID,
        manifestText: JSON.stringify({ id: ID, name: 'm', version: '0.1.0', permissions: ['mcp-tools'] }),
        moduleUrl: 'mod://m',
      },
    ],
    readEnabledIds: () => new Set([ID]),
    mutateEnabledId: () => {},
    importModule: async () => ({ default: PluginClass }),
    permissionStore: store,
    promptFn: async (_id, perms) => perms,
  };
  return { mgr: new PluginManager({ ...createTestCoApp('1.0.0'), mcp: registry }, host), registry, store, upstream };
}

beforeEach(() => {
  run.mockClear();
});

describe('撤销 mcp-tools 后已注册工具不可再调用', () => {
  it('授权有效时可调用', async () => {
    const { mgr, registry } = setup();
    await mgr.init();
    await expect(registry.invokeLocal(TOOL, { v: 'a' })).resolves.toEqual({ echoed: 'a' });
  });

  it('每次调用前重查:撤销后(尚未收到变更通知)调用被拒 PERMISSION_DENIED,run 不执行', async () => {
    const { mgr, registry, store } = setup();
    await mgr.init();
    await store.deny(ID, ['mcp-tools']);
    await expect(registry.invokeLocal(TOOL, { v: 'a' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('权限变更通知后重查:未授权 → 注销该插件全部工具(main stub 同步移除),之后调用 NO_SUCH_TOOL', async () => {
    const { mgr, registry, store, upstream } = setup();
    await mgr.init();
    await store.deny(ID, ['mcp-tools']);
    await mgr.handlePermissionsChanged(ID);
    expect(upstream.unregister).toHaveBeenCalledWith(TOOL);
    await expect(registry.invokeLocal(TOOL, { v: 'a' })).rejects.toMatchObject({
      code: 'NO_SUCH_TOOL',
    });
    // 之后插件正常停用:不重复注销
    await mgr.disable(ID);
    expect(upstream.unregister).toHaveBeenCalledTimes(1);
  });

  it('权限变更但 mcp-tools 仍授权 → 工具保留', async () => {
    const { mgr, registry, upstream } = setup();
    await mgr.init();
    await mgr.handlePermissionsChanged(ID);
    expect(upstream.unregister).not.toHaveBeenCalled();
    await expect(registry.invokeLocal(TOOL, { v: 'b' })).resolves.toEqual({ echoed: 'b' });
  });

  it('未激活 / 未知插件的变更通知 → 无操作,不抛', async () => {
    const { mgr } = setup();
    await expect(mgr.handlePermissionsChanged('com.unknown')).resolves.toBeUndefined();
  });
});

// 终审 P1:插件直接 app.mcp.register 且不保存 Disposable(不经 registerMcpTool 收集)→ 停用 / 热重载 / onload
// 抛错后工具与 main stub 残留,再次启用注册同名工具命中 TOOL_NAME_TAKEN、插件无法启用。revoke() 统一注销。
describe('吊销注销经 app.mcp.register 注册的全部工具', () => {
  class RawMcpPlugin extends Plugin {
    async onload() {
      // 故意不保存返回的 Disposable
      await this.app.mcp.register({
        name: TOOL,
        description: 'echo',
        jsonSchema: { type: 'object' },
        inputSchema: z.object({ v: z.string() }),
        run,
      });
    }
  }

  it('注册后不保存 disposable → 停用:工具注销(main stub 同步移除),调用 NO_SUCH_TOOL', async () => {
    const { mgr, registry, upstream } = setup(RawMcpPlugin);
    await mgr.init();
    await expect(registry.invokeLocal(TOOL, { v: 'a' })).resolves.toEqual({ echoed: 'a' });
    await mgr.disable(ID);
    expect(upstream.unregister).toHaveBeenCalledWith(TOOL);
    await expect(registry.invokeLocal(TOOL, { v: 'a' })).rejects.toMatchObject({
      code: 'NO_SUCH_TOOL',
    });
  });

  it('停用后再启用:同名工具注册成功,插件为 enabled', async () => {
    const { mgr, registry, upstream } = setup(RawMcpPlugin);
    await mgr.init();
    await mgr.disable(ID);
    await mgr.enable(ID);
    expect(mgr.listAll()[0]).toMatchObject({ status: 'enabled' });
    expect(upstream.register).toHaveBeenCalledTimes(2);
    await expect(registry.invokeLocal(TOOL, { v: 'b' })).resolves.toEqual({ echoed: 'b' });
  });

  it('onload 注册后抛错 → 激活失败时工具同样注销,修好后重试启用成功', async () => {
    let shouldThrow = true;
    class Flaky extends RawMcpPlugin {
      override async onload() {
        await super.onload();
        if (shouldThrow) throw new Error('boom');
      }
    }
    const { mgr, registry, upstream } = setup(Flaky);
    await mgr.init();
    expect(mgr.listAll()[0]).toMatchObject({ status: 'failed' });
    expect(upstream.unregister).toHaveBeenCalledWith(TOOL);
    shouldThrow = false;
    await mgr.enable(ID);
    expect(mgr.listAll()[0]).toMatchObject({ status: 'enabled' });
    await expect(registry.invokeLocal(TOOL, { v: 'c' })).resolves.toEqual({ echoed: 'c' });
  });

  it('热重载:旧实例的工具注销,新实例注册同名工具成功', async () => {
    const { mgr, registry } = setup(RawMcpPlugin);
    await mgr.init();
    await mgr.reload(ID);
    expect(mgr.listAll()[0]).toMatchObject({ status: 'enabled' });
    await expect(registry.invokeLocal(TOOL, { v: 'd' })).resolves.toEqual({ echoed: 'd' });
  });
});
