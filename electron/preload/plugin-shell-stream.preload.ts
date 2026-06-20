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

    // 把 START reject 转成本地合成的 exit。主进程可能在 spawn 任何进程之前就
    // reject(如 streamId 已占用是同步 throw,或 handler 在 emit 'exit' 之前抛错)
    // —— 这种情况下永远不会有 'exit' 事件回来,`done` 与 chunk 迭代器会永久挂起,
    // 插件的 `await done` / `for await (chunks)` 死锁。合成一个终止 exit 让等待者收敛。
    const synthesizeExit = (
      info: { exitCode: number | null; signal: NodeJS.Signals | null },
    ): void => {
      if (exitInfo) return;
      exitInfo = info;
      if (chunkResolver) {
        chunkResolver({ value: undefined as never, done: true });
        chunkResolver = null;
      }
      exitResolve?.(exitInfo);
      ipcRenderer.removeListener(PLUGIN_SHELL_STREAM_CHANNELS.EVENT, handler);
    };

    ipcRenderer.on(PLUGIN_SHELL_STREAM_CHANNELS.EVENT, handler);
    void ipcRenderer
      .invoke(PLUGIN_SHELL_STREAM_CHANNELS.START, streamId, cmd, args, opts)
      .catch(() => synthesizeExit({ exitCode: -1, signal: null }));

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
          // 消费方提前 break / return(没读完就跳出 for-await)→ ABORT 子进程 + 摘
          // listener。缺这个钩子时,子进程会一直跑到 timeout(最长 30min),preload 的
          // handler 驻留在 EVENT 通道、chunkQueue 随输出无界堆积。多次「读够就 break」
          // 会累积多个孤儿进程。见第十四轮 P2-AM。
          return(): Promise<
            IteratorResult<{ stream: 'stdout' | 'stderr'; chunk: Uint8Array }>
          > {
            if (!exitInfo) {
              exitInfo = { exitCode: null, signal: null };
              ipcRenderer.removeListener(
                PLUGIN_SHELL_STREAM_CHANNELS.EVENT,
                handler,
              );
              void ipcRenderer
                .invoke(PLUGIN_SHELL_STREAM_CHANNELS.ABORT, streamId)
                .catch(() => {});
              exitResolve?.(exitInfo);
            }
            return Promise.resolve({ value: undefined as never, done: true });
          },
        };
      },
    };
    return { chunks, done };
  },
};
