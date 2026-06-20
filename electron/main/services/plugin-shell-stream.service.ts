import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { IpcMain, WebContents } from 'electron';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../shared/plugin-shell-stream-channels';
import { defaultIsTrustedFrame } from '../safe-handle';
import { IPC_ERR } from '../../shared/ipc-result';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;

interface ActiveStream {
  child: ChildProcessByStdio<null, Readable, Readable>;
  timeoutTimer: NodeJS.Timeout | null;
  senderId: number;
}

export function registerPluginShellStreamHandlers(ipcMain: IpcMain): void {
  const active = new Map<string, ActiveStream>();
  // 已挂生命周期钩子的 webContents(WeakSet 按对象去重,跨 reload 持久且随 wc 销毁
  // 自动回收),避免同一 webContents 多次 START 累积监听器。镜像 plugin-mcp.ipc 的
  // wcAttached —— 用对象身份而非 numeric id,这样 did-start-navigation 的持久监听器
  // 在反复 reload 时只挂一次。
  const wcAttached = new WeakSet<WebContents>();

  // 单个 stream 的强制清理:清 timer + 从 active 摘除 + SIGTERM,1s 后 SIGKILL 兜底
  // (子进程吞掉 SIGTERM 时不至于挂到 timeout)。killStreamsForSender 与 ABORT 共用。
  const forceKillStream = (streamId: string, handle: ActiveStream): void => {
    if (handle.timeoutTimer) clearTimeout(handle.timeoutTimer);
    active.delete(streamId);
    const child = handle.child;
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
    const killTimer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, 1000);
    const maybeUnref = killTimer as { unref?: () => void };
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
  };

  // 窗口/插件 webContents 销毁时,杀掉它名下所有未结束的 stream 子进程,
  // 否则插件不调 ABORT 直接 unload / 关窗会泄漏子进程直到 timeout(审计 P1)。
  const killStreamsForSender = (senderId: number): void => {
    for (const [streamId, handle] of active) {
      if (handle.senderId !== senderId) continue;
      forceKillStream(streamId, handle);
    }
  };

  ipcMain.handle(
    PLUGIN_SHELL_STREAM_CHANNELS.START,
    async (
      event,
      streamId: string,
      cmd: string,
      args: string[],
      opts?: { timeoutMs?: number; cwd?: string },
    ) => {
      // frame-trust 兜底:START 在 main 端直接 spawn,而 'shell' 权限只在 renderer 的
      // scoped-app 包装层检查。不加这道门,能触达 raw IPC 的不可信 frame(ADR-Plugin-5
      // 隔离 iframe / 未来子 frame)即可绕过权限边界触发本机命令执行。与同仓所有写/敏感
      // IPC 的 defaultIsTrustedFrame 纪律一致(codex 复审 loop R8,同 R7 族但 spawn 面更重)。
      if (!defaultIsTrustedFrame(event.senderFrame)) {
        throw Object.assign(new Error('sender frame is not trusted'), {
          code: IPC_ERR.DENIED,
        });
      }
      if (active.has(streamId)) {
        throw new Error(`streamId already active: ${streamId}`);
      }

      const timeoutMs = Math.min(
        opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );
      const child = spawn(cmd, args, {
        cwd: opts?.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const senderWc = event.sender;
      const senderId = senderWc.id;
      if (typeof senderWc.once === 'function' && !wcAttached.has(senderWc)) {
        wcAttached.add(senderWc);
        senderWc.once('destroyed', () => killStreamsForSender(senderId));
        // 审计(第八 session R2):renderer reload(Ctrl+R / HMR full reload /
        // webContents.reload())时 webContents 不销毁、wcId 不变 → 'destroyed' 不触发;
        // 且 renderer 侧 for-await iterator 的 return() 不会在 reload 时跑(reload 直接
        // 撕掉 JS,不触发 generator finalize)→ 不发 ABORT → 子进程 + active 条目 +
        // timeoutTimer 泄漏到 timeout(5-30min),反复 reload 每次累积一个孤儿子进程。
        // 镜像 plugin-mcp.ipc attachWcDestroyHookOnce 的 did-start-navigation hook:在新
        // 文档加载前杀掉该 sender 名下所有在途 stream。仅 main frame 真实(非同文档)导航
        // 才清,避免 hash/pushState 误清;同 wc 持久监听覆盖反复 reload。
        if (typeof senderWc.on === 'function') {
          senderWc.on('did-start-navigation', (details) => {
            if (details.isMainFrame && !details.isSameDocument) {
              killStreamsForSender(senderId);
            }
          });
        }
      }
      let settled = false;

      const send = (
        kind: 'stdout' | 'stderr' | 'exit',
        payload: unknown,
      ): void => {
        if (senderWc.isDestroyed()) return;
        senderWc.send(PLUGIN_SHELL_STREAM_CHANNELS.EVENT, {
          streamId,
          kind,
          payload,
        });
      };

      const finalize = (
        exitCode: number | null,
        signal: NodeJS.Signals | null,
      ): void => {
        if (settled) return;
        settled = true;
        const handle = active.get(streamId);
        if (handle?.timeoutTimer) clearTimeout(handle.timeoutTimer);
        active.delete(streamId);
        send('exit', { exitCode, signal });
      };

      child.stdout.on('data', (chunk: Buffer) => send('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => send('stderr', chunk));
      child.on('close', (code, signal) => finalize(code, signal));
      child.on('error', (err) => {
        send(
          'stderr',
          Buffer.from(
            `[plugin-shell-stream] spawn error: ${err.message}\n`,
            'utf-8',
          ),
        );
        finalize(-1, null);
      });

      const timeoutTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGTERM');
        } catch {
          // ignore
        }
        // SIGKILL 升级 grace timer 必须 unref:否则超时触发后,即便子进程已死,
        // 这个内层 timer 仍会把 event loop 多撑 1s(关窗/退出时延迟退出)。与
        // forceKillStream 的 killTimer 同款防御 —— 此前漏 unref(unref 模式未传播)。
        const killGraceTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 1000);
        const maybeUnrefKill = killGraceTimer as { unref?: () => void };
        if (typeof maybeUnrefKill.unref === 'function') maybeUnrefKill.unref();
      }, timeoutMs);
      const maybeUnref = timeoutTimer as { unref?: () => void };
      if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
      active.set(streamId, { child, timeoutTimer, senderId });
    },
  );

  ipcMain.handle(
    PLUGIN_SHELL_STREAM_CHANNELS.ABORT,
    async (event, streamId: string) => {
      // 同 START 的 frame-trust 兜底(R8)。
      if (!defaultIsTrustedFrame(event.senderFrame)) {
        throw Object.assign(new Error('sender frame is not trusted'), {
          code: IPC_ERR.DENIED,
        });
      }
      const handle = active.get(streamId);
      if (!handle) return;
      // 归属校验:只有发起该 stream 的 sender 能 abort 它,避免跨 sender 按 streamId
      // 终止别人的 stream(codex 复审 loop R8 次要项)。
      if (handle.senderId !== event.sender.id) return;
      // 审计 P2-A:旧实现只发 SIGTERM,不清 active 表也不升级 SIGKILL;子进程
      // 吞掉 SIGTERM 时会挂到 timeout(最长 30min)且 active 条目+timer 驻留。
      forceKillStream(streamId, handle);
    },
  );
}

export const DEFAULT_TIMEOUT_MS_FOR_TEST = DEFAULT_TIMEOUT_MS;
export const MAX_TIMEOUT_MS_FOR_TEST = MAX_TIMEOUT_MS;
