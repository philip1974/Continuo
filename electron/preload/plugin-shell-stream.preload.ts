// Preload runs in Electron sandbox — `node:*` builtins are unavailable.
// Use Web Crypto's globalThis.crypto.randomUUID() instead (always present in
// modern Electron renderer/preload).
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../shared/plugin-shell-stream-channels';

export interface ShellStreamEvent {
  streamId: string;
  kind: 'stdout' | 'stderr' | 'exit';
  payload: Buffer | { exitCode: number | null; signal: NodeJS.Signals | null };
}

export interface PluginShellStreamRaw {
  execStream(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; cwd?: string },
  ): {
    chunks: AsyncIterable<{
      stream: 'stdout' | 'stderr';
      chunk: Uint8Array;
    }>;
    done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  };
}

export const pluginShellStreamRaw: PluginShellStreamRaw = {
  execStream(cmd, args, opts) {
    const streamId = globalThis.crypto.randomUUID();
    const chunkQueue: { stream: 'stdout' | 'stderr'; chunk: Uint8Array }[] = [];
    let chunkResolver:
      | ((
          value: IteratorResult<{
            stream: 'stdout' | 'stderr';
            chunk: Uint8Array;
          }>,
        ) => void)
      | null = null;
    let exitInfo: { exitCode: number | null; signal: NodeJS.Signals | null } | null =
      null;
    let exitResolve:
      | ((value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void)
      | null = null;
    const done = new Promise<{
      exitCode: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) => {
      exitResolve = resolve;
    });

    const handler = (_event: IpcRendererEvent, payload: ShellStreamEvent): void => {
      if (payload.streamId !== streamId) return;
      if (payload.kind === 'exit') {
        exitInfo = payload.payload as {
          exitCode: number | null;
          signal: NodeJS.Signals | null;
        };
        if (chunkResolver) {
          chunkResolver({ value: undefined as never, done: true });
          chunkResolver = null;
        }
        exitResolve?.(exitInfo);
        ipcRenderer.removeListener(PLUGIN_SHELL_STREAM_CHANNELS.EVENT, handler);
        return;
      }

      const item = {
        stream: payload.kind,
        chunk: new Uint8Array(payload.payload as Uint8Array),
      };
      if (chunkResolver) {
        chunkResolver({ value: item, done: false });
        chunkResolver = null;
      } else {
        chunkQueue.push(item);
      }
    };

    ipcRenderer.on(PLUGIN_SHELL_STREAM_CHANNELS.EVENT, handler);
    void ipcRenderer.invoke(
      PLUGIN_SHELL_STREAM_CHANNELS.START,
      streamId,
      cmd,
      args,
      opts,
    );

    const chunks: AsyncIterable<{
      stream: 'stdout' | 'stderr';
      chunk: Uint8Array;
    }> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<
            IteratorResult<{ stream: 'stdout' | 'stderr'; chunk: Uint8Array }>
          > {
            if (chunkQueue.length > 0) {
              return Promise.resolve({
                value: chunkQueue.shift()!,
                done: false,
              });
            }
            if (exitInfo) {
              return Promise.resolve({ value: undefined as never, done: true });
            }
            return new Promise((resolve) => {
              chunkResolver = resolve;
            });
          },
        };
      },
    };
    return { chunks, done };
  },
};
