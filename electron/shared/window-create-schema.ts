// window:create IPC 入参的 zod schema + 类型单一来源(同 terminal-create.ts 的做法):main 用 schema 校验,
// window-channels 以 `import type` + z.infer 派生 IpcWindowCreateInput(类型导入被擦除,preload 不带 zod)。

import { z } from 'zod';
import { FS_PATH_MAX } from './fs-limits';

// 边界(E34,E11/E33 同族):workspace root 路径长度上限(CreateInput.workspace 与 notify-root 的 root 共用)。root 经 notify-root
// 写入 windowId→root map 长期驻留主进程,并作为 MCP/terminal create 未传 cwd 时 agent session 的回退
// 工作目录;畸形超长 absolute 串会带进后续 resolve/stat 路径 + 错误消息 → 内存 + 同步 fs 检查开销。
// 与 renderer workspace root(PATH_STR_MAX)/ terminal workspaceRoot(PATH_MAX)同一路径上限:此前单独取 2048,
// renderer 合法的 2049–8192 字符根目录 notify-root 被拒,MCP 终端 cwd 回退随之失效(只留一条 console.warn)。
export const ROOT_MAX = FS_PATH_MAX;

export const WindowCreateInputSchema = z
  .object({
    workspace: z.string().min(1).max(ROOT_MAX).optional(),
  })
  .strict();
