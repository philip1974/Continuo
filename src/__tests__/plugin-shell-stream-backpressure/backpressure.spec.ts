// 边界(E61):app.shell.execStream() 输出背压 —— preload chunkQueue 未消费缓冲有总字节上限,
// 慢/不消费的插件让缓冲无界增长时自动 ABORT 子进程 + 合成错误 exit。
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Handler = (event: unknown, payload: unknown) => void;

const ipcMock = vi.hoisted(() => ({
  handlers: [] as Handler[],
  invokeCalls: [] as Array<{ channel: string; args: unknown[] }>,
  removed: [] as Handler[],
}));

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (_ch: string, h: Handler) => {
      ipcMock.handlers.push(h);
    },
    removeListener: (_ch: string, h: Handler) => {
      ipcMock.removed.push(h);
    },
    invoke: (channel: string, ...args: unknown[]) => {
      ipcMock.invokeCalls.push({ channel, args });
      return Promise.resolve(undefined);
    },
  },
}));

import { pluginShellStreamRaw } from '../../../electron/preload/plugin-shell-stream.preload';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../../electron/shared/plugin-shell-stream-channels';

beforeEach(() => {
  ipcMock.handlers = [];
  ipcMock.invokeCalls = [];
  ipcMock.removed = [];
});

function emit(handler: Handler, streamId: string, kind: string, payload: unknown) {
  handler({}, { streamId, kind, payload });
}

describe('execStream 背压上限 (E61)', () => {
  it('未消费缓冲超 16MiB → 自动 ABORT + done 收敛为错误 exit', async () => {
    const { done } = pluginShellStreamRaw.execStream('cmd', []);
    // START invoke 后,handler 已注册;streamId 是 START 调用的首个 arg。
    const startCall = ipcMock.invokeCalls.find(
      (c) => c.channel === PLUGIN_SHELL_STREAM_CHANNELS.START,
    );
    expect(startCall).toBeDefined();
    const streamId = startCall!.args[0] as string;
    const handler = ipcMock.handlers[0]!;

    // 不消费 chunks,持续灌 1MiB stdout chunk(17 × 1MiB = 17MiB > 16MiB 上限)。
    const oneMiB = new Uint8Array(1024 * 1024);
    for (let i = 0; i < 17; i++) emit(handler, streamId, 'stdout', oneMiB);

    // 超限自动 ABORT 该 stream + done 收敛为合成错误 exit。
    const abortCall = ipcMock.invokeCalls.find(
      (c) =>
        c.channel === PLUGIN_SHELL_STREAM_CHANNELS.ABORT && c.args[0] === streamId,
    );
    expect(abortCall).toBeDefined();
    await expect(done).resolves.toEqual({ exitCode: -1, signal: null });
  });

  it('上限内正常消费 → 不 ABORT', async () => {
    const { chunks } = pluginShellStreamRaw.execStream('cmd', []);
    const startCall = ipcMock.invokeCalls.find(
      (c) => c.channel === PLUGIN_SHELL_STREAM_CHANNELS.START,
    );
    const streamId = startCall!.args[0] as string;
    const handler = ipcMock.handlers[0]!;
    const it = chunks[Symbol.asyncIterator]();

    emit(handler, streamId, 'stdout', new Uint8Array([1, 2, 3]));
    const r = await it.next();
    expect(r.done).toBe(false);
    expect((r.value as { chunk: Uint8Array }).chunk).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    const abortCall = ipcMock.invokeCalls.find(
      (c) => c.channel === PLUGIN_SHELL_STREAM_CHANNELS.ABORT,
    );
    expect(abortCall).toBeUndefined(); // 正常消费不触发背压 ABORT
  });
});
