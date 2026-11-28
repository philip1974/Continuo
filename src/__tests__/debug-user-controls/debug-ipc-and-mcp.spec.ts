// renderer IPC(debug:control / debug:setUserBreakpoint / debug:evaluate)只作用于发送方窗口的会话;MCP debug.read_output
// 与其它 debug.* 同一授权 / 归属闸。见同目录 README。
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (input: unknown, win: { id: number }) => unknown;
const handlers = vi.hoisted(() => new Map<string, { schema: { safeParse(v: unknown): { success: boolean } }; handler: Handler }>());

vi.mock('../../../electron/main/safe-handle', () => ({
  safeHandleWithWindow: (channel: string, schema: never, handler: Handler) => {
    handlers.set(channel, { schema, handler });
  },
}));

import { registerDebugViewIpc } from '../../../electron/main/ipc/debug-view.ipc';
import * as debugSessions from '../../../electron/main/services/debug-sessions.service';
import { makeDebugMcpTools } from '../../../electron/main/services/mcp-debug-host';
import type { DebugToolService } from '../../../electron/main/services/mcp-tools-debug';
import { DEBUG_VIEW_CHANNELS } from '../../../electron/shared/debug-view-channels';
import { MCP_TOOL_DEBUG_READ_OUTPUT } from '../../../electron/shared/mcp-debug-schemas';

const WIN = { id: 5 };

function makeService() {
  return {
    continue: vi.fn(async () => ({ continued: true })),
    stepOver: vi.fn(async () => ({ continued: true })),
    stepIn: vi.fn(async () => ({ continued: true })),
    stepOut: vi.fn(async () => ({ continued: true })),
    pause: vi.fn(async () => ({ paused: true })),
    disconnect: vi.fn(async () => ({ disconnected: true })),
    setUserBreakpoint: vi.fn(async () => undefined),
    evaluate: vi.fn(async () => ({ result: '3', truncated: false })),
    viewSnapshot: vi.fn(() => []),
    userBreakpointSnapshot: vi.fn(() => [{ file: '/repo/a.js', line: 2 }]),
  };
}

/** 处理器可能同步抛出(safe-handle 统一收成 ok:false);这里统一成 Promise。 */
function ipc(channel: string) {
  const entry = handlers.get(channel)!;
  return { ...entry, handler: (input: unknown, win: { id: number }) => Promise.resolve().then(() => entry.handler(input, win)) };
}

beforeEach(() => {
  handlers.clear();
  debugSessions._reset();
  debugSessions.add({ id: 's1', ownerWindowId: WIN.id, controllerToken: 'agent' });
});

describe('debug:control · 用户接管(工具栏 / 按键)', () => {
  it.each([
    ['continue', 'continue'],
    ['stepOver', 'stepOver'],
    ['stepIn', 'stepIn'],
    ['stepOut', 'stepOut'],
    ['stop', 'disconnect'],
  ] as const)('%s → service.%s(本窗口的 agent 会话也可接管,不经 agent 授权)', async (action, method) => {
    const service = makeService();
    registerDebugViewIpc(service as never);
    await ipc(DEBUG_VIEW_CHANNELS.CONTROL).handler({ sessionId: 's1', action }, WIN);
    expect(service[method]).toHaveBeenCalledWith('s1', ...(method === 'disconnect' ? [] : [{}]));
  });

  it('pause → service.pause', async () => {
    const service = makeService();
    registerDebugViewIpc(service as never);
    await ipc(DEBUG_VIEW_CHANNELS.CONTROL).handler({ sessionId: 's1', action: 'pause' }, WIN);
    expect(service.pause).toHaveBeenCalledWith('s1');
  });

  it('别的窗口的会话 → DEBUG_SESSION_NOT_FOUND,不触达 service;未知动作被 schema 拒绝', async () => {
    const service = makeService();
    registerDebugViewIpc(service as never);
    const { handler, schema } = ipc(DEBUG_VIEW_CHANNELS.CONTROL);
    await expect(handler({ sessionId: 's1', action: 'continue' }, { id: 99 })).rejects.toMatchObject({
      code: 'DEBUG_SESSION_NOT_FOUND',
    });
    expect(service.continue).not.toHaveBeenCalled();
    expect(schema.safeParse({ sessionId: 's1', action: 'restart' }).success).toBe(false);
  });
});

describe('debug:setUserBreakpoint / debug:evaluate / subscribe', () => {
  it('gutter 切换 → 以发送方窗口记用户断点;行号须为正整数', async () => {
    const service = makeService();
    registerDebugViewIpc(service as never);
    const { handler, schema } = ipc(DEBUG_VIEW_CHANNELS.SET_USER_BREAKPOINT);
    await handler({ file: '/repo/a.js', line: 3, enabled: true }, WIN);
    expect(service.setUserBreakpoint).toHaveBeenCalledWith(5, { file: '/repo/a.js', line: 3, enabled: true });
    expect(schema.safeParse({ file: '/repo/a.js', line: 0, enabled: true }).success).toBe(false);
  });

  it('控制台求值 → evaluate(context=repl,带首帧 id);别的窗口的会话被拒', async () => {
    const service = makeService();
    registerDebugViewIpc(service as never);
    const { handler } = ipc(DEBUG_VIEW_CHANNELS.EVALUATE);
    await handler({ sessionId: 's1', expression: '1+2', frameId: 7 }, WIN);
    expect(service.evaluate).toHaveBeenCalledWith('s1', { expression: '1+2', context: 'repl', frameId: 7 });
    await expect(handler({ sessionId: 's1', expression: '1+2' }, { id: 99 })).rejects.toMatchObject({
      code: 'DEBUG_SESSION_NOT_FOUND',
    });
  });

  it('subscribe 快照带本窗口的用户断点', async () => {
    const service = makeService();
    registerDebugViewIpc(service as never);
    await expect(ipc(DEBUG_VIEW_CHANNELS.SUBSCRIBE).handler({}, WIN)).resolves.toEqual({
      sessions: [],
      userBreakpoints: [{ file: '/repo/a.js', line: 2 }],
    });
    expect(service.userBreakpointSnapshot).toHaveBeenCalledWith(5);
  });
});

describe('MCP debug.read_output', () => {
  function tools() {
    const readOutput = vi.fn(() => ({ entries: [], next_seq: 0, truncated: false, has_more: false }));
    const all = makeDebugMcpTools({
      service: { readOutput } as unknown as DebugToolService,
      getSessionOwner: (id: string) => (id === 's1' ? WIN.id : null),
      getSessionController: (id: string) => (id === 's1' ? 'agent-me' : null),
      ensureAuthorized: vi.fn(async () => 'session' as const),
    } as never);
    return { tool: all.find((t) => t.name === MCP_TOOL_DEBUG_READ_OUTPUT)!, readOutput };
  }

  it('注册为 debug.read_output;since_seq / max_bytes 缺省 0 / 64 KiB,max_bytes 上限 1 MiB', async () => {
    const { tool, readOutput } = tools();
    expect(tool.jsonSchema).toMatchObject({
      properties: { since_seq: { default: 0 }, max_bytes: { default: 65536, maximum: 1048576 } },
      required: ['session_id'],
      additionalProperties: false,
    });
    const input = tool.inputSchema.parse({ session_id: 's1' });
    await tool.run(input, { ownerWindowId: WIN.id, callerSubject: 'agent-me' });
    expect(readOutput).toHaveBeenCalledWith('s1', { sinceSeq: 0, maxBytes: 65536 });
    expect(tool.description).toMatch(/untrusted/);
  });

  it('只能读本调用方创建的会话(别的调用方 / 别的窗口被拒)', async () => {
    const { tool, readOutput } = tools();
    const input = tool.inputSchema.parse({ session_id: 's1' });
    await expect(tool.run(input, { ownerWindowId: WIN.id, callerSubject: 'agent-other' })).rejects.toThrow();
    await expect(tool.run(input, { ownerWindowId: 99, callerSubject: 'agent-me' })).rejects.toThrow();
    expect(readOutput).not.toHaveBeenCalled();
  });
});
