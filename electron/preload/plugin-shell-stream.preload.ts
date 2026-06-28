// Preload runs in Electron sandbox — `node:*` builtins are unavailable.
// Use Web Crypto's globalThis.crypto.randomUUID() instead (always present in
// modern Electron renderer/preload).
import { ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  PLUGIN_SHELL_STREAM_CHANNELS,
  parseShellStreamEvent,
} from '../shared/plugin-shell-stream-channels';

export interface ShellStreamEvent {
  streamId: string;
  kind: 'stdout' | 'stderr' | 'exit';
  payload: Buffer | { exitCode: number | null; signal: NodeJS.Signals | null };
}

// 可维护性 M7:单个 stream chunk(stdout/stderr)。迭代器 yield 此类型,**结束值为
// void**(`{ value: undefined, done: true }`)。此前各结束分支用 `undefined as never`
// 压过 TS —— 把迭代器结束语义用类型(IteratorResult<ShellChunk, void>)表达后即不需断言。
type ShellChunk = { stream: 'stdout' | 'stderr'; chunk: Uint8Array };
const SHELL_STREAM_DONE: IteratorResult<ShellChunk, void> = {
  value: undefined,
  done: true,
};

export interface PluginShellStreamRaw {
  execStream(
    cmd: string,
    args: string[],
    opts?: { timeoutMs?: number; cwd?: string },
  ): {
    chunks: AsyncIterable<ShellChunk>;
    done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  };
}

// 边界(E61):execStream 输出无背压上限 —— main 端每个 stdout/stderr chunk 直接 send,preload 在
// 消费者未及时 next() 时无界 chunkQueue.push。插件启动高输出命令却不消费/慢消费,即可让 preload
// 内存随输出持续增长(命令最长跑 5-30min)。给未消费缓冲加总字节上限,超限自动 ABORT 子进程 +
// 合成错误 exit(exitCode -1),让等待者收敛、停止接收更多 chunk。
const MAX_STREAM_QUEUE_BYTES = 16 * 1024 * 1024; // 未消费 chunk 缓冲上限(背压)

// 边界(E231,E61 同族/E230 preload 侧兄弟):pending next() 等待者数量上限。无缓冲 chunk 且未退出时
// 每次 next() 把一个 resolver push 进 chunkResolvers(R93:故意支持并发 next() 预取/并发读)。E61 的
// MAX_STREAM_QUEUE_BYTES 只限**已收到字节**,不限**空读等待者** —— 恶意/异常插件对同一 iterator 并发
// 调用海量 next() 而不 await,chunkResolvers 无界增长;且 exit/return/synthesize 时 resolveAllChunksDone
// 同步遍历唤醒全部等待者 → 内存 + 主线程尖峰。超限视为滥用(远超任何合法并发预取),与 E61 背压同构:
// ABORT 子进程 + 合成错误 exit 收敛所有等待者(不只 reject 当次,避免半死状态)。
const MAX_PENDING_NEXT_RESOLVERS = 1024; // 单 stream pending next() 等待者上限
// 边界(E231)测试用。
export const MAX_PENDING_NEXT_RESOLVERS_FOR_TEST = MAX_PENDING_NEXT_RESOLVERS;

export const pluginShellStreamRaw: PluginShellStreamRaw = {
  execStream(cmd, args, opts) {
    const streamId = globalThis.crypto.randomUUID();
    const chunkQueue: Array<ShellChunk | undefined> = [];
    let chunkQueueHead = 0;
    let queuedBytes = 0; // 边界(E61):chunkQueue 中未消费字节数
    // race(R93):FIFO 等待者队列(不是单 resolver)。两个 next() 并发等待时,单 resolver 会被后者
    // 覆盖 → 先发 next() 的 Promise 永久不 resolve,消费方(预取/并发读 stream 的插件/封装库)挂死;
    // 且后续 chunk/exit 只能唤醒最后一个等待者。FIFO 队列:chunk 到达 resolve 队首,exit/synthesize/
    // return 时 resolve 所有 pending 为 done。不变量:chunkQueue 与 chunkResolvers 不会同时非空
    // (next 先查 queue 命中即返,不会再 push resolver)。
    type ChunkResolver = (value: IteratorResult<ShellChunk, void>) => void;
    const chunkResolvers: Array<ChunkResolver | undefined> = [];
    let chunkResolverHead = 0;
    const pendingResolverCount = (): number =>
      chunkResolvers.length - chunkResolverHead;
    const dequeueResolver = (): ChunkResolver | undefined => {
      if (chunkResolverHead >= chunkResolvers.length) return undefined;
      const waiter = chunkResolvers[chunkResolverHead];
      chunkResolvers[chunkResolverHead] = undefined;
      chunkResolverHead += 1;
      if (chunkResolverHead === chunkResolvers.length) {
        chunkResolvers.length = 0;
        chunkResolverHead = 0;
      }
      return waiter;
    };
    const dequeueChunk = (): ShellChunk | undefined => {
      if (chunkQueueHead >= chunkQueue.length) return undefined;
      const chunk = chunkQueue[chunkQueueHead];
      chunkQueue[chunkQueueHead] = undefined;
      chunkQueueHead += 1;
      if (chunkQueueHead === chunkQueue.length) {
        chunkQueue.length = 0;
        chunkQueueHead = 0;
      }
      return chunk;
    };
    const resolveAllChunksDone = (): void => {
      for (let i = chunkResolverHead; i < chunkResolvers.length; i += 1) {
        const resolve = chunkResolvers[i];
        chunkResolvers[i] = undefined;
        resolve?.(SHELL_STREAM_DONE);
      }
      chunkResolvers.length = 0;
      chunkResolverHead = 0;
    };
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

    const handler = (_event: IpcRendererEvent, rawPayload: unknown): void => {
      // 边界(E175,E168-E174 同族 IPC ingress 纵深防御):事件经 parseShellStreamEvent runtime 校验。
      // not-ours 静默忽略;unattributable(无主畸形)warn+drop 但不动本 stream;invalid(本 stream
      // 但形态非法)warn + 合成 exit 收敛(防 done/chunks 永久挂起)。
      const parsed = parseShellStreamEvent(rawPayload, streamId);
      if (parsed.kind === 'not-ours') return;
      if (parsed.kind === 'unattributable') {
        console.warn(
          '[plugin-shell-stream] unattributable event payload, dropped',
          rawPayload,
        );
        return;
      }
      if (parsed.kind === 'invalid') {
        console.warn(
          '[plugin-shell-stream] invalid event payload for stream, synthesizing exit',
          rawPayload,
        );
        synthesizeExit({ exitCode: -1, signal: null });
        return;
      }
      if (parsed.kind === 'exit') {
        exitInfo = {
          exitCode: parsed.exitCode,
          signal: parsed.signal as NodeJS.Signals | null,
        };
        resolveAllChunksDone(); // race(R93):唤醒所有 pending 等待者为 done
        exitResolve?.(exitInfo);
        ipcRenderer.removeListener(PLUGIN_SHELL_STREAM_CHANNELS.EVENT, handler);
        return;
      }

      const item: ShellChunk = { stream: parsed.stream, chunk: parsed.bytes };
      const waiter = dequeueResolver(); // race(R93):FIFO 唤醒队首
      if (waiter) {
        waiter({ value: item, done: false });
      } else {
        chunkQueue.push(item);
        queuedBytes += item.chunk.length;
        // 边界(E61):未消费缓冲超上限 → 背压。ABORT 子进程 + 合成错误 exit(停止接收更多 chunk)。
        // 已缓冲的 chunk 仍可被消费者 drain(next 先查 queue),drain 完得 done。
        if (queuedBytes > MAX_STREAM_QUEUE_BYTES) {
          ipcRenderer.removeListener(PLUGIN_SHELL_STREAM_CHANNELS.EVENT, handler);
          void ipcRenderer
            .invoke(PLUGIN_SHELL_STREAM_CHANNELS.ABORT, streamId)
            .catch(() => {});
          synthesizeExit({ exitCode: -1, signal: null });
        }
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
      resolveAllChunksDone(); // race(R93):唤醒所有 pending 等待者为 done
      exitResolve?.(exitInfo);
      ipcRenderer.removeListener(PLUGIN_SHELL_STREAM_CHANNELS.EVENT, handler);
    };

    ipcRenderer.on(PLUGIN_SHELL_STREAM_CHANNELS.EVENT, handler);
    void ipcRenderer
      .invoke(PLUGIN_SHELL_STREAM_CHANNELS.START, streamId, cmd, args, opts)
      .catch(() => synthesizeExit({ exitCode: -1, signal: null }));

    const chunks: AsyncIterable<ShellChunk> = {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<ShellChunk, void>> {
            const c = dequeueChunk();
            if (c) {
              queuedBytes -= c.chunk.length; // 边界(E61):消费即释放缓冲计数
              return Promise.resolve({ value: c, done: false });
            }
            if (exitInfo) {
              return Promise.resolve(SHELL_STREAM_DONE);
            }
            // 边界(E231):pending next() 等待者数量上限。超限视为滥用(海量 next() 不 await)→
            // 与 E61 字节背压同构:ABORT 子进程 + 合成错误 exit 收敛全部等待者(含本次),停止接收。
            if (pendingResolverCount() >= MAX_PENDING_NEXT_RESOLVERS) {
              ipcRenderer.removeListener(
                PLUGIN_SHELL_STREAM_CHANNELS.EVENT,
                handler,
              );
              void ipcRenderer
                .invoke(PLUGIN_SHELL_STREAM_CHANNELS.ABORT, streamId)
                .catch(() => {});
              synthesizeExit({ exitCode: -1, signal: null });
              return Promise.resolve(SHELL_STREAM_DONE);
            }
            return new Promise((resolve) => {
              chunkResolvers.push(resolve); // race(R93):入 FIFO 等待队列,不覆盖既有等待者
            });
          },
          // 消费方提前 break / return(没读完就跳出 for-await)→ ABORT 子进程 + 摘
          // listener。缺这个钩子时,子进程会一直跑到 timeout(最长 30min),preload 的
          // handler 驻留在 EVENT 通道、chunkQueue 随输出无界堆积。多次「读够就 break」
          // 会累积多个孤儿进程。见第十四轮 P2-AM。
          return(): Promise<IteratorResult<ShellChunk, void>> {
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
              resolveAllChunksDone(); // race(R93):提前 return 时唤醒所有 pending next() 为 done
            }
            return Promise.resolve(SHELL_STREAM_DONE);
          },
        };
      },
    };
    return { chunks, done };
  },
};
