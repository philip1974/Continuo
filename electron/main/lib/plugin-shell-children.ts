// 插件 shell 子进程(一次性 exec = shell.service、流式 = plugin-shell-stream)的共用生命周期管理。
// 两个入口此前各写一份在途登记 / 退出闸 / 「快照 + 补杀」清理 / 容量双闸 / 超时终止链,外加第三份
// (webContents, 插件) 归属表,防御屡次只修到其中一边(exec 的 timeout clamp 带 trunc,stream 手写的没有)。
//
// 归属(终审 P1):子进程按 (senderId, pluginId) 登记。插件停用 / 卸载时 renderer 请求「终止本窗口内该插件的
// 全部进程」;插件 id 是 renderer 自报的,只用于本窗口内按插件分组终止 —— 终止范围始终限定在发送方
// webContents 自己的进程,不作授权依据。无 senderId(内部调用)或无 pluginId 的进程不参与按插件终止。
//
// 子进程是 detached 进程组,不随 IDE 退出而终止,故退出清理须显式强杀。

import type { ChildProcess } from 'node:child_process';
import { SHELL_MAX_TIMEOUT_MS } from '../../shared/shell-limits';
import { killProcessTreesNow, killWithGrace, processTreeKillable } from './kill-with-grace';

/** 超时终止进程树后仍等不到 close(后代逃出进程组仍持管道)时,最多再等这么久即强制结算。 */
export const FORCE_SETTLE_MS = 3000;

// 边界(E10 / E248,clamp 非有限值族):raw IPC / 直接调用的 service 入口都可能绕过 schema。
// 非数字 / 非有限 / ≤0 回默认值(负 / NaN 会让 setTimeout 立即触发);有限正数取整后封顶。
/** timeoutMs 归一到 (0, SHELL_MAX_TIMEOUT_MS];不合法走 defaultMs。 */
export function clampShellTimeoutMs(input: unknown, defaultMs: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) return defaultMs;
  return Math.min(Math.trunc(input), SHELL_MAX_TIMEOUT_MS);
}

/**
 * 超时终止链:SIGTERM 整棵进程树,graceMs 后整组 SIGKILL(不随结算取消:直接子进程先退出时同组忽略 SIGTERM 的
 * 后代仍须被杀);FORCE_SETTLE_MS 后仍未 close 则销毁 stdio 并调用 onForceSettle,不让调用方无限等待。
 * 返回取消强制结算的函数(close 已到时调用;不撤销 SIGKILL)。timer 均 unref。
 */
export function killTreeWithForceSettle(
  child: ChildProcess,
  graceMs: number | undefined,
  onForceSettle: () => void,
): () => void {
  killWithGrace(processTreeKillable(child), graceMs);
  const forceTimer = setTimeout(() => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    onForceSettle();
  }, FORCE_SETTLE_MS);
  forceTimer.unref?.();
  return () => clearTimeout(forceTimer);
}

interface Owner {
  readonly senderId: number | undefined;
  readonly pluginId: string | undefined;
}

export interface PluginShellChildren {
  /** 退出清理已开始:此后入口一律拒绝新 spawn(插件收到结算即重启的任务不在清理快照内)。 */
  isShuttingDown(): boolean;
  /** 全局 / 单 sender 名额是否已满(spawn 前 fail-fast;无 senderId 只看全局)。 */
  atCapacity(senderId: number | undefined): boolean;
  /**
   * spawn 成功后登记:占一个名额并记录归属,close / error 时自动注销与归还名额。
   * 返回提前归还名额的函数(幂等;进程仍留在登记表内,直到 close,退出清理 / 按插件终止照常覆盖)。
   */
  track(child: ChildProcess, senderId: number | undefined, pluginId: string | undefined): () => void;
  /** 立即强杀 senderId 名下全部在途进程树并等待 close(有上限)。 */
  killForSender(senderId: number): Promise<void>;
  /** 退出清理(before-quit awaited):置退出闸,强杀快照,结束前补杀清理期间漏网登记的进程。 */
  cleanupAll(): Promise<void>;
  /** 测试用:复位退出闸。 */
  resetShutdownForTest(): void;
}

const allRegistries: Array<Map<ChildProcess, Owner>> = [];

export function createPluginShellChildren(limits: {
  readonly maxGlobal: number;
  readonly maxPerSender: number;
}): PluginShellChildren {
  const owners = new Map<ChildProcess, Owner>();
  allRegistries.push(owners);
  let slots = 0;
  const slotsBySender = new Map<number, number>();
  let shuttingDown = false;

  const kill = (match: (owner: Owner) => boolean): Promise<void> =>
    killProcessTreesNow([...owners].filter(([, o]) => match(o)).map(([child]) => child));

  return {
    isShuttingDown: () => shuttingDown,
    atCapacity: (senderId) =>
      slots >= limits.maxGlobal ||
      (senderId !== undefined && (slotsBySender.get(senderId) ?? 0) >= limits.maxPerSender),
    track(child, senderId, pluginId) {
      owners.set(child, { senderId, pluginId: pluginId || undefined });
      slots += 1;
      if (senderId !== undefined) slotsBySender.set(senderId, (slotsBySender.get(senderId) ?? 0) + 1);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        slots -= 1;
        if (senderId === undefined) return;
        const n = (slotsBySender.get(senderId) ?? 1) - 1;
        if (n > 0) slotsBySender.set(senderId, n);
        else slotsBySender.delete(senderId);
      };
      // close / error 可能先后都到:release 幂等,只归还一次。
      const drop = (): void => {
        owners.delete(child);
        release();
      };
      child.once('close', drop);
      child.once('error', drop);
      return release;
    },
    killForSender: (senderId) => kill((o) => o.senderId === senderId),
    async cleanupAll() {
      shuttingDown = true;
      const snapshot = new Set(owners.keys());
      await killProcessTreesNow(snapshot);
      await killProcessTreesNow([...owners.keys()].filter((child) => !snapshot.has(child)));
    },
    resetShutdownForTest() {
      shuttingDown = false;
    },
  };
}

/**
 * 立即终止 senderId 名下 pluginId 的全部在途进程树(跨 exec / 流式)并等待 close(有上限)。
 * 流式子进程被杀后由其 close 回调照常发 exit、回收 active 槽位;一次性 exec 的 Promise 照常结算。
 */
export function killPluginShellProcesses(senderId: number, pluginId: string): Promise<void> {
  const matched: ChildProcess[] = [];
  for (const owners of allRegistries) {
    for (const [child, o] of owners) {
      if (o.senderId === senderId && o.pluginId === pluginId) matched.push(child);
    }
  }
  return killProcessTreesNow(matched);
}
