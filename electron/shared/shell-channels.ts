// Shell IPC 通道(plugin app.shell.exec 用)。
// 一次性 spawn + buffered 输出,**非交互式**(交互式终端走 terminal-channels)。

export const SHELL_CHANNELS = {
  EXEC: 'shell:exec',
  /** 用系统默认 app 打开 URL(http/https/mailto/file 之一,白名单 scheme). */
  OPEN_EXTERNAL: 'shell:openExternal',
} as const;

export interface IpcShellOpenExternalInput {
  readonly url: string;
}

export interface IpcShellExecInput {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly input?: string;
  readonly maxOutputBytes?: number;
}

export interface IpcShellExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** 进程退出码;被信号杀时为 null. */
  readonly exitCode: number | null;
  /** 触发的信号名(如 'SIGTERM'),非信号杀时 null. */
  readonly signal: string | null;
  /** timeout 触发了 SIGTERM. */
  readonly timedOut: boolean;
  /** stdout 或 stderr 任一被截到 maxOutputBytes. */
  readonly truncated: boolean;
}
