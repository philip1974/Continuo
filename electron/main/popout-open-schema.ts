// popout:open 入参 IPC schema(单列于此,不引 electron app —— 可被测试直接 import,
// 不像 ipc.ts 会在模块加载时触达 electron/main/index 的 app.isPackaged)。
import { z } from 'zod';

// 边界(E316,E146 AgentAuthRespondSchema requestId ≤256 同型对齐):panelId 加长度上限 + .strict()。
// popout:open 当前是 M5 占位(立即抛 POPOUT_NOT_IMPLEMENTED,panelId 未用),但 schema 此前用
// z.string().min(1)(无 max)+ .passthrough()(放行任意额外字段)。preload 仅传 { panelId },panelId
// 是内部 dock panel id(远短于 256),故加 .max(256) + .strict() 对真实输入行为保持;同时挡畸形/恶意
// renderer 传超长 panelId 或夹带额外字段经 IPC 解析放大 main 内存/CPU。超限 BAD_INPUT
//(safeHandle 的 formatZodErrorCapped E73 钳错误串,不回显原始长串)。M5 真实现时再扩展 bounds 等字段。
export const PopoutOpenInput = z
  .object({ panelId: z.string().min(1).max(256) })
  .strict();
