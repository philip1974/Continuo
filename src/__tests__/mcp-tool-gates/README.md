# mcp-tool-gates(重构:MCP 工具授权 / capability 门控单一来源)

## 行为契约

terminal 域(`mcp-terminal-host`)与 debug 域(`mcp-debug-host`)的 MCP 工具都要过两层门控:
S2 窗口级授权、S3 per-session capability。此前两个 host 各持一份实现,安全判定逐字相同,只有
文案 / 授权 method / 跨窗策略不同。收口到 `electron/main/services/mcp-tool-gates.ts`,安全判定只此一处。

### 规则

1. `gateWithAuth`:调用前 `ensureAuthorized(ctx.ownerWindowId, methodFor(tool))`;`denied` → 抛
   `AGENT_NOT_AUTHORIZED`(消息由域给定)且**不执行**内部工具;`once` / `session` → 放行。
2. `gateWithCapability`:`session_id` 属于本窗口时,仅当 `controller != null && subject != null &&
   controller === subject` 放行,否则抛 `AGENT_NOT_AUTHORIZED`。
3. 未知 `session_id`(owner=null)或输入无 `session_id` → 放行给内部工具(由其报 not found)。
4. 跨窗 `session_id`:给了 `crossWindowError`(debug 域)→ 抛该错误、不泄漏归属;未给(terminal 域)→
   放行给内部工具(其按 owner 抛 `TERMINAL_SESSION_NOT_FOUND`)。
5. 接线守卫:两个 host 都从 `mcp-tool-gates` 导入门控,不再本地定义。
