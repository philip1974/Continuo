// shell:exec IPC 入参的 zod schema + 类型单一来源(同 terminal-create.ts 的做法)。
// main(shell.ipc)用 schema 做运行时校验;shell-channels 以 `import type` + z.infer 派生 IpcShellExecInput,
// preload / service 引用该类型 —— 类型导入被擦除,preload 产物不带 zod。此前 shared 手写 interface 与 main
// schema 各一份,只给其一加字段时 .strict() 会在运行时拒绝(BAD_INPUT),编译期发现不了。

import { z } from 'zod';
import { PLUGIN_ID_MAX_LEN } from './permission-record-limits';
// 边界(E12,E11 同族):shell.exec 的 cmd/args/cwd/env/input 此前无长度/数量上限。stdout/stderr
// 已 cap,但调用方仍可传超大 stdin / 超大 env / 巨量 args;main 先接收并持有这些大对象,再写入
// stdin / 传给 spawn → IPC/内存卡顿、spawn E2BIG/失败、插件调用长时间异常。E46:常量移到
// shared/shell-limits,renderer scoped-app(E46)+ plugin-shell-stream(E45)复用同值防漂移。
import {
  SHELL_PATH_MAX as PATH_MAX,
  SHELL_ARG_MAX_LEN as ARG_MAX_LEN,
  SHELL_ARGS_MAX_COUNT as ARGS_MAX_COUNT,
  SHELL_ENV_KEY_MAX as ENV_KEY_MAX,
  SHELL_ENV_VAL_MAX as ENV_VAL_MAX,
  SHELL_ENV_MAX_ENTRIES as ENV_MAX_ENTRIES,
  SHELL_STDIN_MAX as STDIN_MAX,
} from './shell-limits';
import { utf8BytesExceed } from './utf8-byte-length';
import { makeEnvBoundedValidator } from './validate-env-bounded';

export const ShellExecInputSchema = z
  .object({
    cmd: z.string().min(1).max(PATH_MAX),
    // readonly:与调用方(scoped-app 共享的冻结空数组)同形;spawn 只读不改。
    args: z.array(z.string().max(ARG_MAX_LEN)).max(ARGS_MAX_COUNT).readonly(),
    cwd: z.string().max(PATH_MAX).optional(),
    // 边界(E186,E185 兄弟入口):env 用共享有界早停校验(makeEnvBoundedValidator),不用
    // z.record(...).refine(Object.keys...) —— 后者条目上限在 zod 全量遍历 + Object.keys 全量物化之后才
    // 生效,巨 env 在 schema 阶段就 O(N) 卡顿/分配。与 terminal-create.ts(E185)单一来源,防漂移。
    env: z
      .custom<Record<string, string>>()
      .superRefine(
        makeEnvBoundedValidator({
          keyMax: ENV_KEY_MAX,
          valMax: ENV_VAL_MAX,
          maxEntries: ENV_MAX_ENTRIES,
        }),
      )
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
    // 边界(E129,E125 同族):stdin 按真实 UTF-8 字节(非 .max()=UTF-16 code unit),否则 CJK/emoji
    // stdin 真实字节可数倍超 SHELL_STDIN_MAX 仍写给 child stdin。
    input: z
      .string()
      .refine((s) => !utf8BytesExceed(s, STDIN_MAX), {
        message: `input 超过上限 ${STDIN_MAX} 字节`,
      })
      .optional(),
    maxOutputBytes: z.number().int().positive().optional(),
    // 终审 P1:发起插件 id(scoped app 填入),只用于本窗口内按插件终止进程,不作授权依据。
    pluginId: z.string().min(1).max(PLUGIN_ID_MAX_LEN).optional(),
  })
  .strict();
