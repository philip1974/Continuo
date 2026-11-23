// Agent Terminal MCP — 授权 IPC 通道(P2 反向 IPC,方案 A)。
// main 端 push 请求 → renderer 弹窗 → renderer 调 invoke 应答。
// requestId(uuid)关联,main 端 Map<id, resolver> 等待。

export const AGENT_AUTH_CHANNELS = {
  /** main → renderer push:agent 请求授权. */
  REQUEST: 'agent-auth:request',
  /** renderer → main send:本窗口已订阅 REQUEST(能显示授权弹窗了);reload 后新文档重新上报. */
  READY: 'agent-auth:ready',
  /** renderer → main invoke:用户决定. */
  RESPOND: 'agent-auth:respond',
  /** renderer → main invoke:撤销 session 授权 + 终止全部 agent terminal. */
  REVOKE: 'agent-auth:revoke',
  /** main → renderer push(广播所有窗口):撤销已生效,各窗口重置本地授权态 + 取消残留弹窗. */
  REVOKED: 'agent-auth:revoked',
  /**
   * main → renderer push(只发给目标窗口):该请求已在 main 侧结算(无应答超时 / 排队兜底 / 取消),
   * renderer 撤掉对应弹窗、不再 respond。renderer 不自行计时 —— 过期只此一个来源。
   */
  CANCELLED: 'agent-auth:cancelled',
} as const;

export interface AgentAuthRequestPayload {
  readonly requestId: string;
  readonly method: string;
  /**
   * 安全(F2):请求来自未绑定 Continuo 终端的外部客户端(stdio 未发 hello)。renderer 弹窗标注来源,且只读写
   * 独立的 external 授权状态,不复用 / 不写入窗口级「本次启动期间允许」。
   */
  readonly external?: boolean;
}

/**
 * 授权弹窗无应答超时:main 到点把请求结算为 denied,并经 CANCELLED 通知 renderer 关掉已失效的弹窗。2 分钟(此前 5 分钟):只发起不应答的弹窗每次占屏时长与发起方干等时长都随之缩短;
 * 超时后的冷却上限(PROMPT_DENY_COOLDOWN_MAX_MS,5 分钟)不变。
 */
export const AGENT_AUTH_PROMPT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * 无应答超时从请求**开始显示**起算(renderer 同一时刻只显示一个弹窗,排在后面的请求不提前耗掉自己的 2 分钟)。
 * 排队总时长兜底:排队这么久仍没轮到显示(前面的弹窗一直轮不完,如 renderer 无响应时已授权域的请求排成长队)→
 * main 按取消结算(不计拒绝、不进冷却)。正常情况下排队不超过前一个弹窗的显示时长(≤ 2 分钟),碰不到这个上限。
 */
export const AGENT_AUTH_QUEUE_MAX_MS = 10 * 60 * 1000;

export const AGENT_AUTH_REQUEST_ID_MAX = 256; // 与 AgentAuthRespondSchema requestId 上限一致(E146)
export const AGENT_AUTH_METHOD_MAX = 256;

/**
 * 插件注册的 MCP 工具授权 method 前缀(plugin 域)。main 侧 plugin-mcp-bridge 以 `plugin.<tool 名>` 请求授权,
 * renderer agent-auth store 据此归入独立的插件域(与 terminal / debug 域互不放行)。
 */
export const AGENT_AUTH_PLUGIN_METHOD_PREFIX = 'plugin.';

/** 授权域:method 以 `debug.` 开头 → debug;以 `plugin.` 开头 → 插件工具;其余(终端工具及未知 method)→ 终端。 */
export type AgentAuthDomain = 'terminal' | 'debug' | 'plugin';
export function agentAuthDomainOf(method: string): AgentAuthDomain {
  if (method.startsWith('debug.')) return 'debug';
  if (method.startsWith(AGENT_AUTH_PLUGIN_METHOD_PREFIX)) return 'plugin';
  return 'terminal';
}

/** agent-auth:request payload 的 runtime 形态 + 长度守卫(IPC ingress 纵深防御,E171)。 */
/** agent-auth:cancelled payload 守卫(IPC ingress 纵深防御)。 */
export function isAgentAuthCancelledPayload(v: unknown): v is { readonly requestId: string } {
  if (v === null || typeof v !== 'object') return false;
  const id = (v as Record<string, unknown>).requestId;
  return typeof id === 'string' && id.length > 0 && id.length <= AGENT_AUTH_REQUEST_ID_MAX;
}

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
  if (o.external !== undefined && typeof o.external !== 'boolean') return false;
  return true;
}

export const AGENT_AUTH_DECISIONS = ['once', 'session', 'denied'] as const;
export type AgentAuthDecision = (typeof AGENT_AUTH_DECISIONS)[number];
