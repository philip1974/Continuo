import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { IpcMain } from 'electron';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../shared/plugin-shell-stream-channels';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;

interface ActiveStream {
  child: ChildProcessByStdio<null, Readable, Readable>;
  timeoutTimer: NodeJS.Timeout | null;
  senderId: number;
}

export function registerPluginShellStreamHandlers(ipcMain: IpcMain): void {
  const active = new Map<string, ActiveStream>();
  // 已挂 'destroyed' 钩子的 sender,避免同一 webContents 多次 START 累积监听器。
  const hookedSenders = new Set<number>();

  // 窗口/插件 webContents 销毁时,杀掉它名下所有未结束的 stream 子进程,
  // 否则插件不调 ABORT 直接 unload / 关窗会泄漏子进程直到 timeout(审计 P1)。
  const killStreamsForSender = (senderId: number): void => {
    for (const [streamId, handle] of active) {
      if (handle.senderId !== senderId) continue;
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
    }
    hookedSenders.delete(senderId);
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
      if (typeof senderWc.once === 'function' && !hookedSenders.has(senderId)) {
        hookedSenders.add(senderId);
        senderWc.once('destroyed', () => killStreamsForSender(senderId));
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
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
        }, 1000);
      }, timeoutMs);
      const maybeUnref = timeoutTimer as { unref?: () => void };
      if (typeof maybeUnref.unref === 'function') maybeUnref.unref();
      active.set(streamId, { child, timeoutTimer, senderId });
    },
  );

  ipcMain.handle(
    PLUGIN_SHELL_STREAM_CHANNELS.ABORT,
    async (_event, streamId: string) => {
      const handle = active.get(streamId);
      if (!handle) return;
      try {
        handle.child.kill('SIGTERM');
      } catch {
        // ignore
      }
    },
  );
}

export const DEFAULT_TIMEOUT_MS_FOR_TEST = DEFAULT_TIMEOUT_MS;
export const MAX_TIMEOUT_MS_FOR_TEST = MAX_TIMEOUT_MS;
