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

// 边界(E171,E168/E169/E170 同族 IPC ingress 纵深防御):agent-auth:request 驱动授权弹窗(安全敏感)。
// AgentAuthPrompt 此前直接解构 payload({requestId, method, agentLabel}),畸形 push(null/缺 requestId·
// method/超长 method·agentLabel)→ 解构 null 抛未处理 rejection、超长文本进弹窗状态并经 catalog 插值
// 放大、缺 requestId 致 respond(undefined) → main pending 等 5min 超时。注册入口 runtime 守卫。
export const AGENT_AUTH_REQUEST_ID_MAX = 256; // 与 AgentAuthRespondSchema requestId 上限一致(E146)
export const AGENT_AUTH_METHOD_MAX = 256;
export const AGENT_AUTH_LABEL_MAX = 512;

/** agent-auth:request payload 的 runtime 形态 + 长度守卫(IPC ingress 纵深防御,E171)。 */
export function isAgentAuthRequestPayload(
  v: unknown,
): v is AgentAuthRequestPayload {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if (
    typeof o.requestId !== 'string' ||
    o.requestId.length === 0 ||
    o.requestId.length > AGENT_AUTH_REQUEST_ID_MAX
  ) {
    return false;
  }
  if (
    typeof o.method !== 'string' ||
    o.method.length === 0 ||
    o.method.length > AGENT_AUTH_METHOD_MAX
  ) {
    return false;
  }
  if (
    o.agentLabel !== undefined &&
    (typeof o.agentLabel !== 'string' ||
      o.agentLabel.length > AGENT_AUTH_LABEL_MAX)
  ) {
    return false;
  }
  return true;
}

export const AGENT_AUTH_DECISIONS = ['once', 'session', 'denied'] as const;
export type AgentAuthDecision = (typeof AGENT_AUTH_DECISIONS)[number];
