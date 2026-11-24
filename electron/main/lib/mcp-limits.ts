/**
 * 单条 MCP JSON-RPC 消息的字节上限:HTTP 传输的请求体(mcp-host)与 stdio 传输的单行(mcp-stdio-server)共用,
 * 同一 tools/call 不应一个传输能过、另一个被拒。1MB 对正常调用充裕,同时挡 body / 残行 bomb。
 */
export const MCP_MAX_MESSAGE_BYTES = 1_000_000;
