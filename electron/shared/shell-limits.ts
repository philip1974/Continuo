// shell.exec / execStream 的命令/参数/env/stdin 大小上限,main + renderer 单一来源(E12/E45/E46)。
//
// 纯常量(无 node/electron 依赖),renderer 与 main 都可 import:
//  - main:shell.ipc.ts ExecInput schema(E12)、plugin-shell-stream.service START(E45)。
//  - renderer:scoped-app.ts makeShell().exec/execStream 在 spread/发 IPC 前预检(E46),挡畸形插件传
//    巨量 args iterable / 超长 stdin·env 时 renderer 先 [...args] 展开 + structured-clone 的前置放大。

export const SHELL_PATH_MAX = 8192; // cmd / cwd
export const SHELL_ARG_MAX_LEN = 16384; // 单个 arg
export const SHELL_ARGS_MAX_COUNT = 1024; // arg 数量
export const SHELL_ENV_KEY_MAX = 1024;
export const SHELL_ENV_VAL_MAX = 32768;
export const SHELL_ENV_MAX_ENTRIES = 1024;
export const SHELL_STDIN_MAX = 1_000_000; // stdin ≤ 1MB(与 HTTP MAX_BODY_BYTES 同量级)

/** 每个 arg 都是 string 且不超过 SHELL_ARG_MAX_LEN(调用方须先确认 args 是数组)。 */
export function areValidShellArgs(args: readonly unknown[]): boolean {
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length > SHELL_ARG_MAX_LEN) {
      return false;
    }
  }
  return true;
}

/**
 * cmd / args / cwd 形态校验的 main + renderer 单一来源(重构:renderer scoped-app 发 IPC 前预检与 main
 * plugin-shell-stream START 入口此前逐字复制同三段检查与文案)。合法 → null;否则返回原因文案。
 * 先确认 args 是数组再遍历 —— 非数组 iterable 的展开可能无限/超大。
 */
export function shellCommandShapeError(
  cmd: unknown,
  args: unknown,
  cwd: unknown,
): string | null {
  if (typeof cmd !== 'string' || cmd.length === 0 || cmd.length > SHELL_PATH_MAX) {
    return `invalid cmd (empty or > ${SHELL_PATH_MAX})`;
  }
  if (!Array.isArray(args) || args.length > SHELL_ARGS_MAX_COUNT) {
    return `invalid args (not array or count > ${SHELL_ARGS_MAX_COUNT})`;
  }
  if (!areValidShellArgs(args)) {
    return `invalid arg entry (non-string or > ${SHELL_ARG_MAX_LEN})`;
  }
  if (cwd !== undefined && (typeof cwd !== 'string' || cwd.length > SHELL_PATH_MAX)) {
    return `invalid cwd (> ${SHELL_PATH_MAX})`;
  }
  return null;
}
