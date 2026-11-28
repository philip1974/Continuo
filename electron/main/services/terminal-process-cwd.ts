// 终端 shell 进程的真实当前目录(VSCode TerminalProcess.getCwd,src/vs/platform/terminal/node/terminalProcess.ts):
// macOS 用 lsof 查进程的 cwd 文件描述符,Linux 读 /proc/<pid>/cwd,其它平台(Windows)取不到 → null(VSCode 回退初始目录)。
// 拆分终端在 shell 没有用 OSC 7 上报目录时(macOS 默认 zsh 不注入 OSC 7)据此继承 `cd` 之后的目录。
// 与 VSCode 的差异:用 execFile(不经 shell、参数不拼接)+ 超时;结果须是存在的目录,否则 null(调用方回退)。
// BDD: src/__tests__/terminal-split/

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';

/** lsof 超时:超时视为取不到(拆分不因此久等)。 */
export const LSOF_TIMEOUT_MS = 2_000;
/** macOS 自带 lsof 的位置(不依赖打包应用里可能很短的 PATH)。 */
const MAC_LSOF = '/usr/sbin/lsof';

export interface ProcessCwdDeps {
  readonly platform?: NodeJS.Platform;
  /** 运行 lsof,resolve stdout;失败 / 超时 reject。 */
  readonly runLsof?: (args: readonly string[]) => Promise<string>;
  readonly readlink?: (path: string) => Promise<string>;
  readonly isDirectory?: (path: string) => Promise<boolean>;
}

function defaultRunLsof(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      MAC_LSOF,
      [...args],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 64 * 1024, env: { ...process.env, LANG: 'en_US.UTF-8' } },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    );
  });
}

async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** `lsof -Fn` 输出里的 cwd 路径(`n` 开头的字段行);没有 → null。 */
export function parseLsofCwd(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('n') && line.length > 1) return line.slice(1);
  }
  return null;
}

/** 进程 pid 的当前目录;取不到 / 不是存在的绝对目录 → null。 */
export async function readProcessCwd(pid: number, deps: ProcessCwdDeps = {}): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const platform = deps.platform ?? process.platform;
  let cwd: string | null = null;
  try {
    if (platform === 'darwin') {
      const stdout = await (deps.runLsof ?? defaultRunLsof)(['-a', '-d', 'cwd', '-p', String(pid), '-Fn']);
      cwd = parseLsofCwd(stdout);
    } else if (platform === 'linux') {
      cwd = await (deps.readlink ?? fs.readlink)(`/proc/${pid}/cwd`);
    }
  } catch {
    return null;
  }
  if (cwd === null || !isAbsolute(cwd)) return null;
  return (await (deps.isDirectory ?? defaultIsDirectory)(cwd)) ? cwd : null;
}
