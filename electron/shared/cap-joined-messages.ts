// 边界(E73/E75/E76,E57/E62 错误串放大族):把外部可控数量/长度的片段 join 成单错误 message
// 经 IPC/JSON-RPC/日志/通知链路传播的入口,都须 cap 条数 + 总长度。此为跨进程单一来源(main 与
// renderer 共用,避免各侧私自裸 issues.map().join() 漂移):
//  - main: electron/main/lib/format-zod-error.ts 的 formatZodErrorCapped 薄封装(E73/E75)。
//  - renderer: src/plugins/registries/PluginMcpRegistry.ts plugin MCP 工具入参校验(E76)。
// 放 electron/shared 而非 main/lib,因为 renderer 不可 import main 代码。

const MAX_JOINED_ITEMS = 20; // 最多展示的条目数(诊断足够)
const MAX_JOINED_LENGTH = 2048; // 拼接后总长上限(单条也可能很大,二次兜底)

/**
 * 把字符串片段拼成有上限的单行 message(条数 + 总长双闸 + 截断标记)。
 * moreLabel 控制超量后缀文案(默认「more」,zod 用「more issues」)。
 */
export function capJoinedMessages(
  messages: readonly string[],
  moreLabel = 'more',
): string {
  const shown = messages.slice(0, MAX_JOINED_ITEMS);
  let msg = shown.join('; ');
  const extra = messages.length - shown.length;
  if (extra > 0) msg += `; …(+${extra} ${moreLabel})`;
  if (msg.length > MAX_JOINED_LENGTH) {
    msg = `${msg.slice(0, MAX_JOINED_LENGTH)}…(truncated)`;
  }
  return msg;
}

/**
 * 边界(E222):capJoinedMessages 的 mapper 变体 —— 只对**前 MAX_JOINED_ITEMS 个**元素调 mapper,不先
 * `items.map(mapper)` 把外部可控数量的源数组(如畸形 GraphQL json.errors,8MiB 内可塞大量短 errors)
 * 全量物化成 string 数组再 slice。items.length 是数组 O(1),extra 计数精确。语义与 capJoinedMessages 一致。
 */
export function capJoinedMessagesFrom<T>(
  items: readonly T[],
  mapper: (item: T) => string,
  moreLabel = 'more',
): string {
  const limit = Math.min(items.length, MAX_JOINED_ITEMS);
  const shown: string[] = [];
  for (let i = 0; i < limit; i++) shown.push(mapper(items[i]!));
  let msg = shown.join('; ');
  const extra = items.length - limit;
  if (extra > 0) msg += `; …(+${extra} ${moreLabel})`;
  if (msg.length > MAX_JOINED_LENGTH) {
    msg = `${msg.slice(0, MAX_JOINED_LENGTH)}…(truncated)`;
  }
  return msg;
}
