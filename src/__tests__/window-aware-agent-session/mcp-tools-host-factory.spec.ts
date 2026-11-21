import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTerminalMcpTools } from '../../../electron/main/services/mcp-terminal-host';
import { makeListSessionsTool } from '../../../electron/main/services/mcp-tools-terminal';
import type { McpCallCtx, AnyMcpTool } from '../../../electron/main/services/mcp-host.service';

type FakeSession = {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;
  readonly createdAt: number;
  readonly exitCode: number | null;
  readonly ownerWindowId: number;
};

function makeFakeStore() {
  const sessions = new Map<string, FakeSession>();
  return {
    sessions,
    get: (id: string) => sessions.get(id),
    getAll: (opts?: { ownerWindowId?: number }) =>
      Array.from(sessions.values()).filter(
        (s) => opts?.ownerWindowId === undefined || s.ownerWindowId === opts.ownerWindowId,
      ),
  };
}

function seedStore(store: ReturnType<typeof makeFakeStore>) {
  store.sessions.set('A-id', {
    id: 'A-id',
    title: 'A',
    cwd: '/a',
    originHint: 'user',
    createdAt: 1,
    exitCode: null,
    ownerWindowId: 10,
  });
  store.sessions.set('B-id', {
    id: 'B-id',
    title: 'B',
    cwd: '/b',
    originHint: 'user',
    createdAt: 2,
    exitCode: null,
    ownerWindowId: 20,
  });
}

function makeDeps(store: ReturnType<typeof makeFakeStore>) {
  return {
    sessionStore: store as never,
    service: {
      has: vi.fn(() => true),
      write: vi.fn(),
      interrupt: vi.fn(),
      kill: vi.fn(),
      forceKill: vi.fn(),
      readOutput: vi.fn(async () => ({ lines: ['ok'], nextSeq: 1, truncated: false })),
    } as never,
    getSessionOwner: (id: string) => store.sessions.get(id)?.ownerWindowId ?? null,
    // 安全 S3:capability 校验 dep。这些用例无 MCP 创建的会话 → null。
    getSessionController: () => null,
    ensureAuthorized: vi.fn(async () => 'once' as const),
    createSession: vi.fn(async () => ({ id: 'created' })),
  };
}

function findTool(tools: readonly AnyMcpTool[], name: string): AnyMcpTool {
  const tool = tools.find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

export function buildFactoryWithBrokenGetSessions(
  store: ReturnType<typeof makeFakeStore>,
): readonly AnyMcpTool[] {
  return [
    makeListSessionsTool({
      getSessions: () => store.getAll(),
    }) as AnyMcpTool,
  ];
}

describe('makeTerminalMcpTools ownership wiring', () => {
  // 安全 S2:list_sessions 经 makeTerminalMcpTools 后受 ensureAuthorized 门控
  // 包装,run 变 async(deps.ensureAuthorized mock 返回 'once' → 放行)。
  it('T1 - list_sessions ctx=10 returns only owner window sessions', async () => {
    const store = makeFakeStore();
    seedStore(store);
    const listTool = findTool(
      makeTerminalMcpTools(makeDeps(store)),
      'terminal.list_sessions',
    );

    const out = (await listTool.run({} as never, { ownerWindowId: 10 })) as {
      sessions: Array<{ session_id: string }>;
    };

    expect(out.sessions.map((s) => s.session_id)).toEqual(['A-id']);
  });

  it('T2 - list_sessions ctx=99 returns empty sessions', async () => {
    const store = makeFakeStore();
    seedStore(store);
    const listTool = findTool(
      makeTerminalMcpTools(makeDeps(store)),
      'terminal.list_sessions',
    );

    const out = (await listTool.run({} as never, { ownerWindowId: 99 })) as {
      sessions: Array<{ session_id: string }>;
    };

    expect(out.sessions).toEqual([]);
  });

  it('T3 - read_output with another window id throws TERMINAL_SESSION_NOT_FOUND', async () => {
    const store = makeFakeStore();
    seedStore(store);
    const readOutputTool = findTool(
      makeTerminalMcpTools(makeDeps(store)),
      'terminal.read_output',
    );

    await expect(
      readOutputTool.run(
        { session_id: 'B-id' } as never,
        { ownerWindowId: 10 } satisfies McpCallCtx,
      ),
    ).rejects.toMatchObject({ code: 'TERMINAL_SESSION_NOT_FOUND' });
  });

  it('T7 - mutation helper proves broken getSessions leaks cross-window sessions', () => {
    const store = makeFakeStore();
    seedStore(store);
    const listTool = findTool(
      buildFactoryWithBrokenGetSessions(store),
      'terminal.list_sessions',
    );

    const out = listTool.run({} as never, { ownerWindowId: 10 }) as {
      sessions: Array<{ session_id: string }>;
    };

    expect(out.sessions.map((s) => s.session_id)).toEqual(['A-id', 'B-id']);
  });

  it('T8 - electron main entrypoint is wired through makeTerminalMcpTools', () => {
    const indexPath = path.resolve(__dirname, '../../../electron/main/index.ts');
    const source = fs.readFileSync(indexPath, 'utf8');

    expect(source).toContain('makeTerminalMcpTools');
    expect(source).not.toContain('makeListSessionsTool({');
  });

  it('T9 - list_sessions description does not claim list returns TERMINAL_SESSION_NOT_FOUND', () => {
    const store = makeFakeStore();
    seedStore(store);
    const listTool = findTool(
      makeTerminalMcpTools(makeDeps(store)),
      'terminal.list_sessions',
    );

    expect(listTool.description).not.toMatch(
      /sessions from other windows return TERMINAL_SESSION_NOT_FOUND/,
    );
    expect(listTool.description).toContain('filtered out');
  });
});
