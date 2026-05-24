// Agent Terminal MCP — 授权 IPC 通道(P2 反向 IPC,方案 A)。
// main 端 push 请求 → renderer 弹窗 → renderer 调 invoke 应答。
// requestId(uuid)关联,main 端 Map<id, resolver> 等待。

export const AGENT_AUTH_CHANNELS = {
  /** main → renderer push:agent 请求授权. */
  REQUEST: 'agent-auth:request',
  /** renderer → main invoke:用户决定. */
  RESPOND: 'agent-auth:respond',
  /** renderer → main invoke:撤销 session 授权 + 终止全部 agent terminal. */
  REVOKE: 'agent-auth:revoke',
} as const;

export type AgentAuthChannel =
  (typeof AGENT_AUTH_CHANNELS)[keyof typeof AGENT_AUTH_CHANNELS];

export interface AgentAuthRequestPayload {
  readonly requestId: string;
  readonly method: string;
  readonly agentLabel?: string;
}

export const AGENT_AUTH_DECISIONS = ['once', 'session', 'denied'] as const;
export type AgentAuthDecision = (typeof AGENT_AUTH_DECISIONS)[number];
