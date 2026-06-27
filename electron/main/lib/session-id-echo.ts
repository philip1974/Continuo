// 边界(E148/E151):外部 @continuo-terminal/protocol 的 session_id zod schema 只 .min(1) 无上限
// (跨仓,不在本仓改),畸形 MCP client 可传接近请求体上限(≤1MB)的超长 session_id。它在所有
// not-found / unknown-runner 路径被原样拼进错误消息 → 放大 JSON-RPC 错误响应 + 日志/内存。
// 回显前统一截断到 SESSION_ID_ECHO_MAX(单一来源,收口所有 MCP 工具的 not-found 错误消息)。
// 超长 id 仍会 not-found(不匹配任何 session),只是错误不再回显超长原串。

export const SESSION_ID_ECHO_MAX = 256;

/** 截断 session_id 供错误消息/日志回显:超 SESSION_ID_ECHO_MAX 加省略号,否则原样。 */
export function truncateSessionIdForEcho(id: string): string {
  return id.length > SESSION_ID_ECHO_MAX
    ? `${id.slice(0, SESSION_ID_ECHO_MAX)}…`
    : id;
}
