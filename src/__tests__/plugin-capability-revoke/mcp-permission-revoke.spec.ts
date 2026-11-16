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

function setup(): {
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
    importModule: async () => ({ default: McpPlugin }),
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
