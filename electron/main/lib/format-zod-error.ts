// 边界(E73,E57/E62 错误串放大族):zod 校验失败时把 error.issues 全量 map+join 当错误 message
// 返回(IPC / JSON-RPC)。对 .strict() schema,畸形 payload 带大量未知 key → 错误串无界放大,经
// IPC/日志/通知链路造成额外内存与 UI 放大。统一经 capJoinedMessages(跨进程单一来源,见
// electron/shared/cap-joined-messages.ts,E76 起 renderer 侧也复用)cap:限 issue 条数 + 总长度。
// safeHandle / safeHandleWithCtx / mcp-host 工具入参校验三处共用 formatZodErrorCapped。
import type { z } from 'zod';
import {
  capJoinedMessages,
  capJoinedMessagesFrom,
} from '../../shared/cap-joined-messages';

export { capJoinedMessages, capJoinedMessagesFrom };

/** 把 ZodError 拼成有上限的单行 message(issue 数 + 总长双闸 + 截断标记)。 */
export function formatZodErrorCapped(error: z.ZodError): string {
  // 边界(E223,E222 兄弟):用 mapper 变体,只对前 N 个 issue 取 .message,不先 error.issues.map(...)
  // 全量物化。array schema(如 z.array(z.string()))校验大量无效元素时每元素产一 issue → issues 可
  // 海量;此前 .map 在 cap 前先分配完整 message 数组。
  return capJoinedMessagesFrom(error.issues, (i) => i.message, 'more issues');
}
