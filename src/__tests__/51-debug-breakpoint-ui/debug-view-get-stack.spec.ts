// debug:getStack 一次返回「栈帧 + 首帧作用域」:面板不能切帧,首帧 id 是 main 自己刚取到的,
// 此前 renderer 拿到栈帧后还要把 frames[0].id 原样带回来再发一次 debug:getScopes。
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

const WIN = { id: 5 };
const frame = { id: 7, name: 'main', source_path: '/repo/a.ts', line: 14 };

function setup(service: { stackTrace: ReturnType<typeof vi.fn>; scopes: ReturnType<typeof vi.fn> }) {
  registerDebugViewIpc(service as never);
  return handlers.get(DEBUG_VIEW_CHANNELS.GET_STACK)!;
}

beforeEach(() => {
  handlers.clear();
  debugSessions._reset();
  debugSessions.add({ id: 's1', ownerWindowId: WIN.id, controllerToken: 'agent' });
  debugSessions.update('s1', { runtimeState: 'stopped', stopSeq: 1 });
});

describe('debug:getStack', () => {
  it('返回栈帧与首帧的作用域(用 main 刚取到的首帧 id)', async () => {
    const service = {
      stackTrace: vi.fn(async () => ({ frames: [frame, { ...frame, id: 8 }], total_frames: 2 })),
      scopes: vi.fn(async () => ({ scopes: [{ name: 'Local', variables_reference: 44, expensive: false }] })),
    };
    const result = await setup(service)({ sessionId: 's1' }, WIN);
    expect(service.scopes).toHaveBeenCalledWith('s1', { frameId: 7 });
    expect(result).toEqual({
      frames: [frame, { ...frame, id: 8 }],
      total_frames: 2,
      scopes: [{ name: 'Local', variables_reference: 44, expensive: false }],
    });
  });

  it('作用域取不到 → 栈帧照常返回,作用域为空', async () => {
    const service = {
      stackTrace: vi.fn(async () => ({ frames: [frame] })),
      scopes: vi.fn(async () => {
        throw new Error('frame invalidated');
      }),
    };
    await expect(setup(service)({ sessionId: 's1' }, WIN)).resolves.toEqual({ frames: [frame], scopes: [] });
  });

  it('没有栈帧 → 不取作用域', async () => {
    const service = { stackTrace: vi.fn(async () => ({ frames: [] })), scopes: vi.fn() };
    await expect(setup(service)({ sessionId: 's1' }, WIN)).resolves.toEqual({ frames: [], scopes: [] });
    expect(service.scopes).not.toHaveBeenCalled();
  });

  it('别的窗口的会话 → DEBUG_SESSION_NOT_FOUND,不触达 service', async () => {
    const service = { stackTrace: vi.fn(), scopes: vi.fn() };
    const handler = setup(service);
    await expect(handler({ sessionId: 's1' }, { id: 99 })).rejects.toMatchObject({
      code: 'DEBUG_SESSION_NOT_FOUND',
    });
    expect(service.stackTrace).not.toHaveBeenCalled();
  });
});
