// 边界(E308,E305-E307 reorder 同族):PluginMcpRegistry validateToolSpec 字节下界 fail-fast 在
// assertJsonValue 之前(boundedValueDeepAdmissible 形态闸之后)。独立 spec:mock assert-json-value
// spy assertJsonValue 是否被调用(行为保持,neutralize 取「顺序」)。
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

const { assertJsonValueSpy } = vi.hoisted(() => ({ assertJsonValueSpy: vi.fn() }));
vi.mock('../../../electron/shared/assert-json-value', () => ({
  assertJsonValue: assertJsonValueSpy,
}));

import {
  PluginMcpRegistry,
  PLUGIN_MCP_ERROR_CODES,
  type PluginMcpUpstream,
} from '../../plugins/registries/PluginMcpRegistry';

const upstream: PluginMcpUpstream = {
  register: async () => {},
  unregister: async () => {},
};

describe('PluginMcpRegistry validateToolSpec 校验顺序 (E308)', () => {
  it('超 64KiB 但 shape 合法的 jsonSchema → reject,且字节 fail-fast 在 assertJsonValue 之前(不被调用)', async () => {
    const reg = new PluginMcpRegistry(upstream);
    const spec = {
      name: 't',
      description: '',
      jsonSchema: { big: 'x'.repeat(70 * 1024) }, // 过形态闸,字节 > 64KiB
      inputSchema: z.object({}).strict(),
      run: () => ({}),
    };
    await expect(reg.register(spec, 'p')).rejects.toMatchObject({
      code: PLUGIN_MCP_ERROR_CODES.INVALID_PARAMS,
    });
    // neutralize 敏感:旧序(assertJsonValue 在前)则 assertJsonValue 被调用。
    expect(assertJsonValueSpy).not.toHaveBeenCalled();
  });

  it('上限内 jsonSchema → 进入 assertJsonValue(被调用)', async () => {
    assertJsonValueSpy.mockClear();
    const reg = new PluginMcpRegistry(upstream);
    const spec = {
      name: 'u',
      description: '',
      jsonSchema: { type: 'object', additionalProperties: false },
      inputSchema: z.object({}).strict(),
      run: () => ({}),
    };
    await reg.register(spec, 'p');
    expect(assertJsonValueSpy).toHaveBeenCalled();
  });
});
