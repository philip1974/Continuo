// Agent Terminal MCP — tool 实装(Phase 1 仅 list_sessions)。
// 工厂注入 deps 便于单测,真路由分发器在后续 phase 接。
//
// BDD: src/__tests__/agent-terminal-mcp-list-sessions/

import {
  MCP_TOOL_LIST_SESSIONS,
  listSessionsInputSchema,
  type ListSessionsInput,
  type ListSessionsOutput,
  type ListSessionItem,
} from '../../shared/mcp-terminal-schemas';
import type { McpToolDef } from './mcp-host.service';

// ── 输入侧的 store 形态(handler 期望的字段) ────────────────────

/**
 * Phase 1 的 store session 形态。`terminal.store.ts` 后续扩展时按此对齐。
 * 本接口在 schemas / store / handler 三处复用,handler 只读不改。
 */
export interface TerminalSessionLike {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;
  readonly createdAt: number;
  readonly exitCode: number | null;
}

export interface ListSessionsToolDeps {
  readonly getSessions: () => readonly TerminalSessionLike[];
}

/**
 * tool 形态;与 mcp-host 注册接口同构。本地 alias 是为了让 P1 单测的
 * `tool.name` / `tool.run` 不直接依赖 mcp-host 的 generic 默认值。
 */
export type McpTool<I, O> = McpToolDef<I, O>;

// ── 字段映射:camelCase store → snake_case 对外 ────────────────

function toItem(s: TerminalSessionLike): ListSessionItem {
  // 用条件赋值代替 `agent_label: s.agentLabel`,确保 user session 输出不含
  // `agent_label` 键(spec 要求字段不出现,而非 undefined)。
  const item: ListSessionItem = {
    session_id: s.id,
    title: s.title,
    cwd: s.cwd,
    origin: s.originHint,
    created_at: s.createdAt,
    exit_code: s.exitCode,
  };
  if (s.agentLabel !== undefined) {
    (item as { agent_label?: string }).agent_label = s.agentLabel;
  }
  return item;
}

// ── 工厂 ───────────────────────────────────────────────────────

export function makeListSessionsTool(
  deps: ListSessionsToolDeps,
): McpTool<ListSessionsInput, ListSessionsOutput> {
  return {
    name: MCP_TOOL_LIST_SESSIONS,
    inputSchema: listSessionsInputSchema,
    run: () => ({
      sessions: deps.getSessions().map(toItem),
    }),
  };
}
