// 插件用 co.z(zod 3 API)写的 inputSchema,必须能直接交给 PluginMcpRegistry:类型上可赋值,运行时照常校验。
import { describe, expect, it } from 'vitest';
import { pluginZod as z } from '@/plugins/plugin-zod';
import {
  PluginMcpRegistry,
  PluginMcpError,
  PLUGIN_MCP_ERROR_CODES,
  type PluginMcpToolSpec,
  type PluginMcpUpstream,
} from '@/plugins/registries/PluginMcpRegistry';

const upstream: PluginMcpUpstream = {
  async register() {},
  async unregister() {},
};

const greet: PluginMcpToolSpec<{ who: string }, { msg: string }> = {
  name: 'greet',
  description: 'greet someone',
  jsonSchema: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
  inputSchema: z.object({ who: z.string() }),
  run: (i) => ({ msg: `hi ${i.who}` }),
};

describe('PluginMcpRegistry 接受 co.z(zod 3)schema', () => {
  it('合法输入 → run 收到解析后的值', async () => {
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(greet, 'p.greet');
    await expect(reg.invokeLocal('greet', { who: 'a' })).resolves.toEqual({ msg: 'hi a' });
  });

  it('非法输入 → INVALID_PARAMS', async () => {
    const reg = new PluginMcpRegistry(upstream);
    await reg.register(greet, 'p.greet');
    const err = await reg.invokeLocal('greet', { who: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PluginMcpError);
    expect((err as PluginMcpError).code).toBe(PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS);
  });
});
