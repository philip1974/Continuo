// BDD: agent-terminal-mcp-list-sessions
// 测 MCP tool `terminal.list_sessions` 的契约 + handler 字段映射。
//
// 此 spec 在 Phase 1 实装前会 red(module 不存在)。实装目标:
//   electron/shared/mcp-terminal-schemas.ts
//   electron/main/services/mcp-tools-terminal.ts

import { describe, it, expect, vi } from 'vitest';
import {
  MCP_TOOL_LIST_SESSIONS,
  listSessionsInputSchema,
  listSessionsOutputSchema,
} from '../../../electron/shared/mcp-terminal-schemas';
import { makeListSessionsTool } from '../../../electron/main/services/mcp-tools-terminal';

// ────────────────────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────────────────────

describe('MCP_TOOL_LIST_SESSIONS', () => {
  it('字符串契约', () => {
    expect(MCP_TOOL_LIST_SESSIONS).toBe('terminal.list_sessions');
  });
});

// ────────────────────────────────────────────────────────────
// Input schema
// ────────────────────────────────────────────────────────────

describe('listSessionsInputSchema', () => {
  it('空对象 → ok', () => {
    expect(listSessionsInputSchema.safeParse({}).success).toBe(true);
  });

  it('多余字段 → fail(strict)', () => {
    expect(listSessionsInputSchema.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('非 object → fail', () => {
    expect(listSessionsInputSchema.safeParse(null).success).toBe(false);
    expect(listSessionsInputSchema.safeParse('hi').success).toBe(false);
    expect(listSessionsInputSchema.safeParse([]).success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// Output schema
// ────────────────────────────────────────────────────────────

describe('listSessionsOutputSchema', () => {
  it('全字段齐 → ok', () => {
    const r = listSessionsOutputSchema.safeParse({
      sessions: [
        {
          session_id: 'term-1',
          title: 'Terminal 1',
          cwd: '/work',
          origin: 'user',
          created_at: 1_700_000_000_000,
          exit_code: null,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('agent session 带 agent_label → ok', () => {
    const r = listSessionsOutputSchema.safeParse({
      sessions: [
        {
          session_id: 'term-2',
          title: 'Terminal 2',
          cwd: '/work',
          origin: 'agent',
          agent_label: 'codex',
          created_at: 1_700_000_000_000,
          exit_code: 0,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('空 sessions → ok', () => {
    expect(
      listSessionsOutputSchema.safeParse({ sessions: [] }).success,
    ).toBe(true);
  });

  it('exit_code 必须显式 null 或 number(undefined 不行)', () => {
    const bad = listSessionsOutputSchema.safeParse({
      sessions: [
        {
          session_id: 'x',
          title: 'x',
          cwd: '/',
          origin: 'user',
          created_at: 0,
          // exit_code 缺
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it('origin 仅 user / agent', () => {
    const bad = listSessionsOutputSchema.safeParse({
      sessions: [
        {
          session_id: 'x',
          title: 'x',
          cwd: '/',
          origin: 'system' as never,
          created_at: 0,
          exit_code: null,
        },
      ],
    });
    expect(bad.success).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────
// makeListSessionsTool — handler 字段映射
// ────────────────────────────────────────────────────────────

interface FakeSession {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;
  readonly createdAt: number;
  readonly exitCode: number | null;
}

const userSess: FakeSession = {
  id: 'term-1',
  title: 'Terminal 1',
  cwd: '/work',
  originHint: 'user',
  createdAt: 1_700_000_000_000,
  exitCode: null,
};

const agentSess: FakeSession = {
  id: 'term-2',
  title: 'Terminal 2',
  cwd: '/work',
  originHint: 'agent',
  agentLabel: 'codex',
  createdAt: 1_700_000_001_000,
  exitCode: null,
};

const exitedSess: FakeSession = {
  id: 'term-3',
  title: 'Terminal 3',
  cwd: '/tmp',
  originHint: 'user',
  createdAt: 1_700_000_002_000,
  exitCode: 0,
};

describe('makeListSessionsTool', () => {
  const ctx = { ownerWindowId: 1 };

  it('name 与契约常量一致', () => {
    const tool = makeListSessionsTool({ getSessions: () => [] });
    expect(tool.name).toBe(MCP_TOOL_LIST_SESSIONS);
  });

  it('空 sessions → { sessions: [] }', () => {
    const tool = makeListSessionsTool({ getSessions: () => [] });
    expect(tool.run({}, ctx)).toEqual({ sessions: [] });
  });

  it('空 sessions 复用稳定空数组,不预分配输出数组', () => {
    const tool = makeListSessionsTool({ getSessions: () => [] });
    const first = tool.run({}, ctx);
    const second = tool.run({}, ctx);
    const src = tool.run.toString();

    expect(first.sessions).toBe(second.sessions);
    expect(src.indexOf('rawSessions.length === 0')).toBeGreaterThanOrEqual(0);
    expect(src.indexOf('rawSessions.length === 0')).toBeLessThan(
      src.indexOf('new Array'),
    );
  });

  it('user session 字段映射(camelCase → snake_case)', () => {
    const tool = makeListSessionsTool({ getSessions: () => [userSess] });
    expect(tool.run({}, ctx)).toEqual({
      sessions: [
        {
          session_id: 'term-1',
          title: 'Terminal 1',
          cwd: '/work',
          origin: 'user',
          created_at: 1_700_000_000_000,
          exit_code: null,
        },
      ],
    });
  });

  it('agent session 带 agent_label', () => {
    const tool = makeListSessionsTool({ getSessions: () => [agentSess] });
    const out = tool.run({}, ctx) as { sessions: Array<Record<string, unknown>> };
    expect(out.sessions[0]).toMatchObject({
      session_id: 'term-2',
      origin: 'agent',
      agent_label: 'codex',
    });
  });

  it('user session 不带 agent_label(字段不出现,不是 undefined)', () => {
    const tool = makeListSessionsTool({ getSessions: () => [userSess] });
    const out = tool.run({}, ctx) as { sessions: Array<Record<string, unknown>> };
    expect('agent_label' in out.sessions[0]!).toBe(false);
  });

  it('exit_code 透传 number / null', () => {
    const tool = makeListSessionsTool({
      getSessions: () => [userSess, exitedSess],
    });
    const out = tool.run({}, ctx) as { sessions: Array<{ exit_code: number | null }> };
    expect(out.sessions[0]!.exit_code).toBeNull();
    expect(out.sessions[1]!.exit_code).toBe(0);
  });

  it('顺序保留', () => {
    const tool = makeListSessionsTool({
      getSessions: () => [agentSess, userSess, exitedSess],
    });
    const out = tool.run({}, ctx) as { sessions: Array<{ session_id: string }> };
    expect(out.sessions.map((s) => s.session_id)).toEqual([
      'term-2',
      'term-1',
      'term-3',
    ]);
  });

  it('每次 run 调 getSessions 一次(读取最新快照)', () => {
    const getSessions = vi.fn(() => [userSess]);
    const tool = makeListSessionsTool({ getSessions });
    tool.run({}, ctx);
    tool.run({}, ctx);
    expect(getSessions).toHaveBeenCalledTimes(2);
  });

  it('输出通过 listSessionsOutputSchema 校验', () => {
    const tool = makeListSessionsTool({
      getSessions: () => [userSess, agentSess, exitedSess],
    });
    const out = tool.run({}, ctx);
    expect(listSessionsOutputSchema.safeParse(out).success).toBe(true);
  });

  it('构建输出时不调用 sessions.map 生成中间数组', () => {
    const sessions = [userSess, agentSess, exitedSess];
    const mapSpy = vi.spyOn(sessions, 'map');
    const tool = makeListSessionsTool({
      getSessions: () => sessions,
    });

    try {
      const out = tool.run({}, ctx) as { sessions: Array<{ session_id: string }> };

      expect(mapSpy).not.toHaveBeenCalled();
      expect(tool.run.toString()).not.toContain('sessions.push(');
      expect(out.sessions.map((s) => s.session_id)).toEqual([
        'term-1',
        'term-2',
        'term-3',
      ]);
    } finally {
      mapSpy.mockRestore();
    }
  });
});
