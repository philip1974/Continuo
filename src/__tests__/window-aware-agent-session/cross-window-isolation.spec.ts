import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTerminalMcpTools } from '../../../electron/main/services/mcp-terminal-host';
import type { McpCallCtx } from '../../../electron/main/services/mcp-host.service';

type FakeSession = {
  readonly id: string;
  readonly ownerWindowId: number;
  readonly cwd: string;
  readonly title: string;
  readonly originHint: 'user' | 'agent';
  readonly createdAt: number;
  readonly exitCode: number | null;
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

function makeTools(store: ReturnType<typeof makeFakeStore>) {
  return makeTerminalMcpTools({
    sessionStore: store as never,
    service: {
      has: vi.fn(() => true),
      write: vi.fn(),
      interrupt: vi.fn(),
      kill: vi.fn(),
      forceKill: vi.fn(),
      readOutput: vi.fn(async () => ({ lines: [], nextSeq: 0, truncated: false })),
    } as never,
    getSessionOwner: (id: string) => store.sessions.get(id)?.ownerWindowId ?? null,
    // 安全 S3:capability dep。本用例只测 list(无 capability)→ null。
    getSessionController: () => null,
    ensureAuthorized: vi.fn(async () => 'once' as const),
    createSession: vi.fn(async () => ({ id: 'never' })),
  });
}

describe('window-aware cross-window terminal isolation (high-level AC)', () => {
  let store: ReturnType<typeof makeFakeStore>;

  beforeEach(() => {
    store = makeFakeStore();
    store.sessions.set('A-id', {
      id: 'A-id',
      ownerWindowId: 10,
      cwd: '/a',
      title: 'TA',
      originHint: 'user',
      createdAt: 1,
      exitCode: null,
    });
    store.sessions.set('B-id', {
      id: 'B-id',
      ownerWindowId: 20,
      cwd: '/b',
      title: 'TB',
      originHint: 'user',
      createdAt: 2,
      exitCode: null,
    });
  });

  it('AC1 - list_sessions returns only caller window sessions', async () => {
    const tools = makeTools(store);
    const listTool = tools.find((t) => t.name === 'terminal.list_sessions');
    expect(listTool).toBeDefined();

    const ctx: McpCallCtx = { ownerWindowId: 10 };
    // 安全 S2:list 经 makeTerminalMcpTools 受授权门控包装,run 为 async。
    const out = (await listTool!.run({} as never, ctx)) as {
      sessions: Array<{ session_id: string }>;
    };

    expect(out.sessions.map((s) => s.session_id)).toEqual(['A-id']);
  });
});
