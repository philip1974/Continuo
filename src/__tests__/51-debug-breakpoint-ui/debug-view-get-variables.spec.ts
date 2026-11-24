// debug:getVariables 分页:面板可带 start 取后续页(同 MCP debug.variables 的 start / next_start),
// 其余入参(count / 深度 / 字节)仍走 debug.service 默认值;main 返回的 truncated / next_start 原样透传。
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (input: unknown, win: { id: number }) => unknown;
const handlers = vi.hoisted(() => new Map<string, Handler>());

vi.mock('../../../electron/main/safe-handle', () => ({
  safeHandleWithWindow: (channel: string, _schema: unknown, handler: Handler) => {
    handlers.set(channel, handler);
  },
}));

import { registerDebugViewIpc } from '../../../electron/main/ipc/debug-view.ipc';
import * as debugSessions from '../../../electron/main/services/debug-sessions.service';
import { DEBUG_VIEW_CHANNELS } from '../../../electron/shared/debug-view-channels';
import { debugGetVariablesInputSchema } from '../../../electron/shared/debug-view-schema';

const WIN = { id: 5 };

beforeEach(() => {
  handlers.clear();
  debugSessions._reset();
  debugSessions.add({ id: 's1', ownerWindowId: WIN.id, controllerToken: 'agent' });
  debugSessions.update('s1', { runtimeState: 'stopped', stopSeq: 1 });
});

describe('debug:getVariables 分页', () => {
  it('schema 收可选 start(非负整数),仍拒未知字段', () => {
    expect(debugGetVariablesInputSchema.safeParse({ sessionId: 's1', variablesReference: 44 }).success).toBe(true);
    expect(debugGetVariablesInputSchema.safeParse({ sessionId: 's1', variablesReference: 44, start: 100 }).success).toBe(true);
    expect(debugGetVariablesInputSchema.safeParse({ sessionId: 's1', variablesReference: 44, start: -1 }).success).toBe(false);
    expect(debugGetVariablesInputSchema.safeParse({ sessionId: 's1', variablesReference: 44, start: 1.5 }).success).toBe(false);
    expect(debugGetVariablesInputSchema.safeParse({ sessionId: 's1', variablesReference: 44, count: 500 }).success).toBe(false);
  });

  it('带 start → 透传给 service,返回 truncated / next_start', async () => {
    const page = { variables: [{ name: 'x', value: '1' }], truncated: true, next_start: 200 };
    const service = { variables: vi.fn(async () => page) };
    registerDebugViewIpc(service as never);
    const handler = handlers.get(DEBUG_VIEW_CHANNELS.GET_VARIABLES)!;
    await expect(handler({ sessionId: 's1', variablesReference: 44, start: 100 }, WIN)).resolves.toEqual(page);
    expect(service.variables).toHaveBeenCalledWith('s1', { variablesReference: 44, start: 100 });
  });

  it('不带 start → 不传 start(service 从 0 起)', async () => {
    const service = { variables: vi.fn(async () => ({ variables: [], truncated: false })) };
    registerDebugViewIpc(service as never);
    await handlers.get(DEBUG_VIEW_CHANNELS.GET_VARIABLES)!({ sessionId: 's1', variablesReference: 44 }, WIN);
    expect(service.variables).toHaveBeenCalledWith('s1', { variablesReference: 44 });
  });
});
