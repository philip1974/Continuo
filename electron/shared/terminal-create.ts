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
import { makeEnvBoundedValidator } from './validate-env-bounded';

// 边界(E11):terminal.create 的 args/env/title 等此前无长度/数量上限。畸形 renderer/plugin payload
// 可传超大 args/env 或超长标题;main 会把它们合进 PTY spawn 环境 + session metadata 再广播给所有
// renderer → spawn 失败 / IPC 大对象传输卡顿 / Dock/UI 渲染异常。下列上限远超任何正常用法,只挡
// 滥用;超限 zod 校验失败 → 走 main 的 BAD_INPUT 拒绝路径。
// 导出供 MCP create_session 路径(走 raw ptyCreateHandler,绕过本 schema)复用同一上限(E32)。
export const PATH_MAX = 8192; // shell / cwd / workspaceRoot(路径,远超真实路径长度)
export const LABEL_MAX = 512; // name / title / agentLabel(显示串)
const ARG_MAX_LEN = 16384; // 单个 arg
const ARGS_MAX_COUNT = 1024; // arg 数量
const ENV_KEY_MAX = 1024;
const ENV_VAL_MAX = 32768;
const ENV_MAX_ENTRIES = 1024;

// 边界(E185/E186):env 有界早停校验抽到共享 validate-env-bounded(与 shell.ipc.ts 单一来源,防漂移)。
const validateEnvBounded = makeEnvBoundedValidator({
  keyMax: ENV_KEY_MAX,
  valMax: ENV_VAL_MAX,
  maxEntries: ENV_MAX_ENTRIES,
});

export const TerminalCreateInputSchema = z
  .object({
    shell: z.string().max(PATH_MAX).optional(),
    args: z.array(z.string().max(ARG_MAX_LEN)).max(ARGS_MAX_COUNT).optional(),
    cwd: z.string().min(1).max(PATH_MAX).optional(),
    // 边界(E185):env 用**有界早停**自定义校验,不用 `z.record(...).refine(Object.keys...)` ——
    // z.record 会先 O(N) 全量遍历校验所有条目、refine 又 Object.keys 再全量物化一次,条目上限在
    // 全量成本之后才生效,绕过「env≤1024 防放大」意图(畸形巨 env 在 schema 阶段就 O(N) 卡顿/分配)。
    // 改为:确认 plain object → for-in 早停计数到 ENV_MAX_ENTRIES+1 即拒,并同轮校验 key/value 类型与长度。
    env: z
      .custom<Record<string, string>>()
      .superRefine(validateEnvBounded)
      .optional(),
    // P1 metadata 真相源在 main:这些字段创建时入 sessions service。
    name: z.string().max(LABEL_MAX).optional(),
    title: z.string().max(LABEL_MAX).optional(),
    originHint: z.enum(ORIGIN_HINTS).optional(),
    agentLabel: z.string().max(LABEL_MAX).optional(),
    scoped: z.boolean().optional(),
    // topic-05: 透传到 sessionsService,让 renderer 端决定 attach 落点。
    attachTarget: AttachTargetSchema.optional(),
    /**
     * 创建时 renderer 当前 workspace.root,用于 sessions 跨 workspace 切换时的过滤。
     * 未传 = 全局会话(agent 多走这条),所有 workspace 都可见。
     */
    workspaceRoot: z.string().min(1).max(PATH_MAX).optional(),
  })
  .strict();

export type TerminalCreateInput = z.infer<typeof TerminalCreateInputSchema>;
