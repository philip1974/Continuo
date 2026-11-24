# MCP session_id schema 单一来源

terminal / hook-bridge / debug 三族 MCP 工具的 `session_id` 入参共用 `electron/shared/session-id-schema.ts` 的
`sessionIdSchema`(`z.string().min(1).max(SESSION_ID_MAX)`),不再各写一份。

## 行为契约

- 运行时:空串与超过 `SESSION_ID_MAX` 的 session_id 在各工具 inputSchema 层被拒,合法 id 放行。
- 对外(tools/list 的 JSON schema):terminal / hook-bridge 的 JSON schema 仍手写(有刻意不对外宣告的字段,不整体派生),
  但 `session_id` 的 `type` / `minLength` / `maxLength` 必须与 `sessionIdSchema` 派生出的 JSON schema 逐字段一致,且列入 `required`。
- debug 工具的对外 JSON schema 整体由 zod 派生,见 `50-agent-debug-engine-mvp`。

## 规范文件

- `session-id-schema.spec.ts`
