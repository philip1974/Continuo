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
