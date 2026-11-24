// 子进程强杀升级:SIGTERM,GRACE_MS 后仍未退出则 SIGKILL(子进程吞掉 SIGTERM 时不至于一直挂着)。
// plugin-shell-stream 的强制清理 / 超时分支与 plugins.service 的 git 超时此前各手写一份。
//
// grace timer 必须 unref:否则触发后即便子进程已死,这个内层 timer 仍会把 event loop 多撑 GRACE_MS,
// 关窗 / 退出时延迟退出(第七 session R3:unref 曾逐个兄弟 timer 补)。kill 抛错(进程已退出等)忽略。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { resolveSpawnCommand } from './child-spawn-hardening';
import { waitAtMost } from './wait-at-most';

interface Killable {
  kill(signal?: NodeJS.Signals | number): boolean;
}

// 进程树终止:spawn 须配 `detached: TREE_KILL_DETACHED`(POSIX 下子进程成为新进程组组长,pgid = pid)。
// 只杀直接子进程时,`sh -c 'sleep 600 & wait'` 的后台后代成孤儿继续跑并持有 stdout/stderr 管道 →
// close 迟迟不来,上层 done / Promise 挂住。POSIX 对 `-pid` 发信号覆盖整个进程组;Windows 用
// `taskkill /T /F` 杀进程树(Windows 上 detached 会另开控制台,故不设)。pid 缺失 / 组已不存在时回退直杀。
// 返回 Killable,直接交给 killWithGrace(SIGTERM → 宽限 → SIGKILL 语义不变)。
export const TREE_KILL_DETACHED = process.platform !== 'win32';

interface TreeKillTarget extends Killable {
  readonly pid?: number | undefined;
}

// Windows:等待 taskkill 结束的上限。taskkill 靠根 PID 遍历子进程,根进程须在它结束后才可直杀;
// taskkill 卡住时不能无限推迟兜底,1s 后照常直杀根进程(退出清理 killProcessTreesNow 的总上限为 2s)。
export const TASKKILL_WAIT_MS = 1000;

// taskkill 的绝对路径:裸名 spawn 时 libuv 先查主进程 cwd(CLI 启动时即用户所在目录,可能是不可信仓库),
// 其中的 taskkill.exe 会被执行。优先 %SystemRoot%\System32;SystemRoot 缺失 / 非绝对路径时回落 PATH 绝对
// 目录解析(解析不到抛错 → 调用方回退直杀根进程)。
function taskkillCommand(): string {
  const root = process.env.SystemRoot;
  if (root && path.win32.isAbsolute(root)) return path.win32.join(root, 'System32', 'taskkill.exe');
  return resolveSpawnCommand('taskkill', process.env);
}

export function processTreeKillable(child: TreeKillTarget): Killable {
  // Windows:在途 taskkill 结束(或到等待上限)时 resolve;SIGKILL 兜底排在它之后。
  let taskkillDone: Promise<void> | undefined;
  return {
    kill(signal) {
      const pid = child.pid;
      if (pid === undefined || pid <= 0) return child.kill(signal);
      if (process.platform === 'win32') {
        // taskkill /F 本身即强杀,SIGKILL 只需直杀兜底 —— 但须等 taskkill 结束:根进程先死则 taskkill
        // 无从遍历子进程树(终审 P1:killProcessTreesNow 曾紧接 SIGTERM 同步直杀根进程)。
        if (signal === 'SIGKILL') {
          if (!taskkillDone) return child.kill(signal);
          void taskkillDone.then(() => {
            try {
              child.kill(signal);
            } catch {
              // 已退出
            }
          });
          return true;
        }
        try {
          const tk = spawn(taskkillCommand(), ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          taskkillDone = new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, TASKKILL_WAIT_MS);
            (timer as { unref?: () => void }).unref?.();
            const finish = () => {
              clearTimeout(timer);
              resolve();
            };
            tk.once('exit', finish);
            tk.once('error', finish);
          });
          tk.on('error', () => child.kill(signal));
          return true;
        } catch {
          return child.kill(signal);
        }
      }
      try {
        process.kill(-pid, signal);
        return true;
      } catch {
        return child.kill(signal);
      }
    },
  };
}

interface TreeKillChild extends TreeKillTarget {
  readonly stdout?: { destroy(): void } | null;
  readonly stderr?: { destroy(): void } | null;
  once(event: 'close', listener: () => void): unknown;
}

/**
 * 退出清理:对所有在途子进程的进程树立即强杀(不给宽限),并等待各自 close,整体最多 capMs。
 * SIGTERM 在 Windows 即 `taskkill /T /F`(整树强杀,紧随的 SIGKILL 直杀根进程排在 taskkill 结束之后),
 * POSIX 下紧随的整组 SIGKILL 才是实际生效的一击。
 * 到上限仍未 close(后代逃出进程组仍持管道)→ 销毁 stdio 促成 close,不让退出被拖住。
 * 调用方传入的必须是尚未 close 的子进程(close 时自行从集合摘除)。
 */
export async function killProcessTreesNow(
  children: Iterable<TreeKillChild>,
  capMs = 2000,
): Promise<void> {
  const list = [...children];
  if (list.length === 0) return;
  const closed = list.map((child) => {
    const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
    const tree = processTreeKillable(child);
    for (const sig of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        tree.kill(sig);
      } catch {
        // 已退出
      }
    }
    return done;
  });
  if ((await waitAtMost(Promise.all(closed), capMs)) === 'timeout') {
    for (const child of list) {
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }
}

const GRACE_MS = 1000;

export function killWithGrace(child: Killable, graceMs: number = GRACE_MS): void {
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
  const killGraceTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, graceMs);
  // 非 Node 计时器环境(测试里的 fake timers / jsdom)下 setTimeout 可能返回 number,故探测后再调。
  const timer = killGraceTimer as { unref?: () => void };
  if (typeof timer.unref === 'function') timer.unref();
}
