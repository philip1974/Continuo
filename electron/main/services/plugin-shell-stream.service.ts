import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { IpcMain } from 'electron';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../shared/plugin-shell-stream-channels';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 30 * 60_000;

interface ActiveStream {
  child: ChildProcessWithoutNullStreams;
  timeoutTimer: NodeJS.Timeout | null;
}

export function registerPluginShellStreamHandlers(ipcMain: IpcMain): void {
  const active = new Map<string, ActiveStream>();

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
      active.set(streamId, { child, timeoutTimer });
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
