# cap-joined-messages(错误串放大族)

`electron/shared/cap-joined-messages.ts` 的行为契约。把外部可控数量/长度的片段拼成有上限的单行
错误 message(条数 + 总长双闸 + 截断标记),供 zod 错误(formatZodErrorCapped)/ plugin MCP 入参校验 /
GraphQL errors 等错误串经 IPC/日志/通知链路传播的入口复用(E73/E75/E76)。

- `capJoinedMessages(messages)`:对已物化的 string[] 限条数(20)+ 总长(2048)。
- `capJoinedMessagesFrom(items, mapper)`(E222):mapper 变体 —— 只对**前 20 个**元素调 mapper,不先
  `items.map(mapper)` 把外部可控数量的源数组全量物化成 string 数组再 cap(畸形 GraphQL json.errors
  8MiB 内可塞大量短 errors)。items.length O(1) 算 extra,语义与 capJoinedMessages 一致。
