// Shell IPC 注册(plugin app.shell.exec 后端 + LM UI 跳转外链)。

import { z } from 'zod';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import { SHELL_CHANNELS } from '../../shared/shell-channels';
import { execShell, openExternalUrl } from '../services/shell.service';
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
} from '../../shared/shell-limits';
import { utf8BytesExceed } from '../../shared/utf8-byte-length';
import { makeEnvBoundedValidator } from '../../shared/validate-env-bounded';
import { MAX_EXTERNAL_URL_LEN } from '../../shared/url-limits';

export const ExecInput = z
  .object({
    cmd: z.string().min(1).max(PATH_MAX),
    args: z.array(z.string().max(ARG_MAX_LEN)).max(ARGS_MAX_COUNT),
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
  })
  .strict();

const OpenExternalInput = z
  .object({
    // 边界(E190 收口):外链长度上限用共享 MAX_EXTERNAL_URL_LEN(与 windowOpenHandler / Markdown 外链同源)。
    url: z.string().min(1).max(MAX_EXTERNAL_URL_LEN),
  })
  .strict();

export function registerShellIpc(): void {
  safeHandle(SHELL_CHANNELS.EXEC, ExecInput, execShell, defaultIsTrustedFrame);
  safeHandle(
    SHELL_CHANNELS.OPEN_EXTERNAL,
    OpenExternalInput,
    openExternalUrl,
    defaultIsTrustedFrame,
  );
}
