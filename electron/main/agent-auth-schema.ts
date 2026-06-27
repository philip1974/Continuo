// Agent Terminal MCP 授权应答 IPC schema(单列于此,不引 electron app —— 可被测试直接 import,
// 不像 ipc.ts 会在模块加载时触达 electron/main/index 的 app.isPackaged)。
import { z } from 'zod';
import { AGENT_AUTH_DECISIONS } from '../shared/agent-auth-channels';

// 边界(E146,plugin-fs scope-decision requestId ≤256 同型对齐):requestId 加长度上限,防畸形/恶意
// renderer 用超长 requestId 反复触发 IPC 解析 + pending.get 放大 main 内存/CPU。超限 BAD_INPUT
//(safeHandle 的 formatZodErrorCapped E73 钳错误串,不回显原始长串)。
export const AgentAuthRespondSchema = z
  .object({
    requestId: z.string().min(1).max(256),
    decision: z.enum(AGENT_AUTH_DECISIONS),
  })
  .strict();
