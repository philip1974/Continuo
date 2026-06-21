// 可维护性 M24:terminal CREATE IPC 入参的 zod schema + 类型单一来源。
//
// 此前 main(terminal.ipc.ts 的 createInputSchema)与 preload(TerminalCreateOptions
// 手写 interface,注释"与 main schema 对齐")各维护一份,已漂移(main 有 attachTarget,
// preload 没)。抽到本 shared 文件:main 复用 schema(运行时校验),preload 用
// z.infer 派生类型(静态),跨进程契约单一来源。
//
// 纯 zod(无 node 依赖),renderer/preload 可 import。

import { z } from 'zod';
import { ORIGIN_HINTS } from './origin-hint';
import { AttachTargetSchema } from './terminal-attach';

export const TerminalCreateInputSchema = z
  .object({
    shell: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), z.string()).optional(),
    // P1 metadata 真相源在 main:这些字段创建时入 sessions service。
    name: z.string().optional(),
    title: z.string().optional(),
    originHint: z.enum(ORIGIN_HINTS).optional(),
    agentLabel: z.string().optional(),
    scoped: z.boolean().optional(),
    // topic-05: 透传到 sessionsService,让 renderer 端决定 attach 落点。
    attachTarget: AttachTargetSchema.optional(),
    /**
     * 创建时 renderer 当前 workspace.root,用于 sessions 跨 workspace 切换时的过滤。
     * 未传 = 全局会话(agent 多走这条),所有 workspace 都可见。
     */
    workspaceRoot: z.string().min(1).optional(),
  })
  .strict();

export type TerminalCreateInput = z.infer<typeof TerminalCreateInputSchema>;
