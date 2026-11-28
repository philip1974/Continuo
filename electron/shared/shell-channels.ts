// Shell IPC 通道(plugin app.shell.exec 用)。
// 一次性 spawn + buffered 输出,**非交互式**(交互式终端走 terminal-channels)。

import type { z } from 'zod';
import type { ShellExecInputSchema } from './shell-exec-schema';

export const SHELL_CHANNELS = {
  EXEC: 'shell:exec',
  /** 用系统默认 app 打开 URL(http/https/mailto/file 之一,白名单 scheme). */
  OPEN_EXTERNAL: 'shell:openExternal',
  /**
   * 终止发送方窗口内某插件启动的全部 shell 进程(exec + 流式)。插件停用 / 卸载时由 PluginManager 调用
   * (终审 P1:此前进程只按 webContents 归属,插件停用后长任务继续跑到超时)。
   */
  KILL_PLUGIN_PROCESSES: 'shell:kill-plugin-processes',
  /** 外链受信域名(用户添加的部分;默认项见 shared/trusted-domains):读 → `{ user, defaults }`。 */
  TRUSTED_DOMAINS_GET: 'shell:trusted-domains:get',
  /** 整体替换用户受信域名(设置页编辑),返回规整后的列表。 */
  TRUSTED_DOMAINS_SET: 'shell:trusted-domains:set',
  /** main → renderer:用户受信域名变了(确认框「信任 <域名>」、别的窗口的设置页),payload 为新的用户列表。 */
  TRUSTED_DOMAINS_CHANGED: 'shell:trusted-domains:changed',
} as const;

export interface TrustedDomainsSnapshot {
  readonly user: readonly string[];
  readonly defaults: readonly string[];
}

export interface IpcShellOpenExternalInput {
  readonly url: string;
}

/** shell:exec 入参:由 main 的 zod schema 推出(单一来源,见 shell-exec-schema.ts)。 */
export type IpcShellExecInput = z.infer<typeof ShellExecInputSchema>;

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
