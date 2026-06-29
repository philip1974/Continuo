import { describe, expect, it, vi } from 'vitest';

import { makeDebugMcpTools } from '../../../electron/main/services/mcp-debug-host';
import {
  MCP_TOOL_DEBUG_EVALUATE,
  MCP_TOOL_DEBUG_LAUNCH,
  MCP_TOOL_DEBUG_SET_BREAKPOINT,
  MCP_TOOL_DEBUG_STACK,
  MCP_TOOL_DEBUG_WAIT_FOR_STOP,
} from '../../../electron/shared/mcp-debug-schemas';
import type {
  AnyMcpTool,
  McpCallCtx,
} from '../../../electron/main/services/mcp-host.service';

const WIN = 50;
const ME = 'debug-controller-me';
const OTHER = 'debug-controller-other';

type DebugSess = { owner: number; controller: string };

function findTool(tools: readonly AnyMcpTool[], name: string): AnyMcpTool {
  const tool = tools.find((entry) => entry.name === name);
  expect(tool, `tool ${name} should exist`).toBeDefined();
  return tool!;
}

function build(
  sessions: Record<string, DebugSess>,
  decision: 'once' | 'session' | 'denied' = 'session',
) {
  const service = {
    launchSession: vi.fn(async () => ({
      session_id: 'debug-created',
      state: 'running' as const,
    })),
    setBreakpoints: vi.fn(async () => ({ verified: true })),
    waitForStop: vi.fn(async () => ({
      session_id: 'debug-owned',
      stop_seq: 1,
      reason: 'breakpoint',
    })),
    continue: vi.fn(async () => ({ continued: true })),
    stepOver: vi.fn(async () => ({ continued: true })),
    stepIn: vi.fn(async () => ({ continued: true })),
    stepOut: vi.fn(async () => ({ continued: true })),
    stackTrace: vi.fn(async () => ({ frames: [] })),
    scopes: vi.fn(async () => ({ scopes: [] })),
    variables: vi.fn(async () => ({ variables: [], truncated: false })),
    evaluate: vi.fn(async () => ({ result: '42', truncated: false })),
    disconnect: vi.fn(async () => ({ disconnected: true })),
    listSessions: vi.fn(() => [
      {
        session_id: 'debug-owned',
        state: 'running',
        owner_window_id: WIN,
      },
      {
        session_id: 'debug-other-window',
        state: 'running',
        owner_window_id: 99,
      },
    ]),
  };
  const ensureAuthorized = vi.fn(async () => decision);
  const tools = makeDebugMcpTools({
    service,
    getSessionOwner: (id) => sessions[id]?.owner ?? null,
    getSessionController: (id) => sessions[id]?.controller ?? null,
    ensureAuthorized,
  });
  return { tools, service, ensureAuthorized };
}

describe('50 · agent debug MCP host', () => {
  const ctx: McpCallCtx = { ownerWindowId: WIN, callerSubject: ME };

  it('debug.launch 走 debug.launch 授权并把 callerSubject stamp 成 controllerToken', async () => {
    const { tools, service, ensureAuthorized } = build({});

    await findTool(tools, MCP_TOOL_DEBUG_LAUNCH).run(
      { program: '/repo/app.js', stop_on_entry: false } as never,
      ctx,
    );

    expect(ensureAuthorized).toHaveBeenCalledWith(WIN, 'debug.launch');
    expect(service.launchSession).toHaveBeenCalledWith(
      { program: '/repo/app.js', stopOnEntry: false },
      { ownerWindowId: WIN, controllerToken: ME },
    );
  });

  it('非 launch debug 工具走 debug.* 授权标签', async () => {
    const { tools, ensureAuthorized } = build({
      'debug-owned': { owner: WIN, controller: ME },
    });

    await findTool(tools, MCP_TOOL_DEBUG_STACK).run(
      { session_id: 'debug-owned', thread_id: 1 } as never,
      ctx,
    );

    expect(ensureAuthorized).toHaveBeenCalledWith(WIN, 'debug.*');
  });

  it('授权被拒时不触达 DebugService', async () => {
    const { tools, service } = build(
      { 'debug-owned': { owner: WIN, controller: ME } },
      'denied',
    );

    await expect(
      findTool(tools, MCP_TOOL_DEBUG_SET_BREAKPOINT).run(
        { session_id: 'debug-owned', file: '/repo/app.ts', line: 10 } as never,
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    expect(service.setBreakpoints).not.toHaveBeenCalled();
  });

  it('同窗口但 controllerToken 不同的 session_id 工具被 capability 拒绝', async () => {
    const { tools, service } = build({
      'debug-peer': { owner: WIN, controller: OTHER },
    });

    await expect(
      findTool(tools, MCP_TOOL_DEBUG_EVALUATE).run(
        { session_id: 'debug-peer', expression: 'x' } as never,
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_AUTHORIZED' });
    expect(service.evaluate).not.toHaveBeenCalled();
  });

  it('跨窗口 session_id 不触达 DebugService,并隐藏 capability 细节', async () => {
    const { tools, service } = build({
      'debug-other-window': { owner: 99, controller: OTHER },
    });

    await expect(
      findTool(tools, MCP_TOOL_DEBUG_EVALUATE).run(
        { session_id: 'debug-other-window', expression: 'x' } as never,
        ctx,
      ),
    ).rejects.toThrow('debug session not found');
    expect(service.evaluate).not.toHaveBeenCalled();
  });

  it('同一 caller 创建的 session_id 工具放行到底层 DebugService', async () => {
    const { tools, service } = build({
      'debug-owned': { owner: WIN, controller: ME },
    });

    await findTool(tools, MCP_TOOL_DEBUG_EVALUATE).run(
      { session_id: 'debug-owned', expression: 'x' } as never,
      ctx,
    );

    expect(service.evaluate).toHaveBeenCalledWith(
      'debug-owned',
      expect.objectContaining({ expression: 'x' }),
    );
  });

  it('DebugService plain errors 被归一化为 debug 错误码和短消息', async () => {
    const { tools, service } = build({
      'debug-owned': { owner: WIN, controller: ME },
    });
    service.waitForStop.mockRejectedValueOnce(
      new Error('debug wait_for_stop timed out after 120000ms'),
    );
    service.stackTrace.mockRejectedValueOnce(
      new Error(`debug session not found: ${'x'.repeat(1000)}`),
    );
    service.launchSession.mockRejectedValueOnce(
      new Error(`adapter failed at /${'very-long/'.repeat(200)}dap.js`),
    );

    await expect(
      findTool(tools, MCP_TOOL_DEBUG_WAIT_FOR_STOP).run(
        { session_id: 'debug-owned' } as never,
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'DEBUG_WAIT_TIMEOUT',
      message: 'debug wait_for_stop timed out',
    });
    await expect(
      findTool(tools, MCP_TOOL_DEBUG_STACK).run(
        { session_id: 'debug-owned', thread_id: 1 } as never,
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'DEBUG_SESSION_NOT_FOUND',
      message: 'debug session not found',
    });
    await expect(
      findTool(tools, MCP_TOOL_DEBUG_LAUNCH).run(
        { program: '/repo/app.js', stop_on_entry: false } as never,
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'DEBUG_ADAPTER_LAUNCH_FAILED',
      message: 'debug adapter launch failed',
    });
  });
});
