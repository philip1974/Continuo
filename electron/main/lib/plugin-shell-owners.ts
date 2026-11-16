// 插件 shell 子进程的 (webContents, 插件) 归属登记(终审 P1)。
//
// shell.exec / plugin-shell-stream 的子进程此前只按 webContents 归属(关窗/重载才清),插件停用/卸载后
// 长任务继续跑到超时(5-30min)。renderer 的 scoped app 在请求里带上插件 id,main 在 spawn 后登记;
// 停用/卸载时 renderer 请求「终止本窗口内该插件的全部进程」。插件 id 是 renderer 自报的,只用于本窗口内
// 按插件分组终止 —— 终止范围始终限定在发送方 webContents 自己的进程,不作授权依据。

import type { ChildProcess } from 'node:child_process';
import { killProcessTreesNow } from './kill-with-grace';

interface Owner {
  readonly senderId: number;
  readonly pluginId: string;
}

const owners = new Map<ChildProcess, Owner>();

/** spawn 成功后登记;无 pluginId(非插件调用)不登记。close/error 后自动注销。 */
export function trackPluginShellProcess(
  child: ChildProcess,
  senderId: number,
  pluginId: string | undefined,
): void {
  if (!pluginId) return;
  owners.set(child, { senderId, pluginId });
  const drop = (): void => {
    owners.delete(child);
  };
  child.once('close', drop);
  child.once('error', drop);
}

/**
 * 立即终止 senderId 名下 pluginId 的全部在途进程树并等待 close(有上限,见 killProcessTreesNow)。
 * 流式子进程被杀后由其 close 回调照常发 exit、回收 active 槽位;一次性 exec 的 Promise 照常结算。
 */
export function killPluginShellProcesses(
  senderId: number,
  pluginId: string,
): Promise<void> {
  const matched: ChildProcess[] = [];
  for (const [child, owner] of owners) {
    if (owner.senderId === senderId && owner.pluginId === pluginId) matched.push(child);
  }
  return killProcessTreesNow(matched);
}
