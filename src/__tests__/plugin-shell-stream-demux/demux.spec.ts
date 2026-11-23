// perf:插件 execStream 的 preload 事件分发 —— 整窗口对 EVENT 通道只挂一个 ipcRenderer listener,
// 按 streamId 定向分发(Map),不再每条流各挂一个 listener(活跃 S 条流 → 每 chunk O(S) 分发)。
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, payload: unknown) => void;

const ipcMock = vi.hoisted(() => ({
  listeners: new Set<Handler>(),
  onCalls: 0,
  invokeCalls: [] as Array<{ channel: string; args: unknown[] }>,
}));

vi.mock('electron', () => ({
  ipcRenderer: {
    on: (_ch: string, h: Handler) => {
      ipcMock.onCalls += 1;
      ipcMock.listeners.add(h);
    },
    removeListener: (_ch: string, h: Handler) => {
      ipcMock.listeners.delete(h);
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
  ipcMock.invokeCalls = [];
  ipcMock.onCalls = 0;
});

function emit(payload: unknown): void {
  for (const h of [...ipcMock.listeners]) h({}, payload);
}

function startStream() {
  const s = pluginShellStreamRaw.execStream('cmd', []);
  const starts = ipcMock.invokeCalls.filter(
    (c) => c.channel === PLUGIN_SHELL_STREAM_CHANNELS.START,
  );
  const streamId = starts[starts.length - 1]!.args[0] as string;
  return { ...s, streamId, it: s.chunks[Symbol.asyncIterator]() };
}

describe('plugin-shell-stream preload 单 listener 分发', () => {
  it('多条活跃流共用一个 EVENT listener;chunk / exit 只投给对应流', async () => {
    const a = startStream();
    const b = startStream();
    const c = startStream();
    expect(ipcMock.listeners.size).toBe(1);
    expect(ipcMock.onCalls).toBe(1);

    emit({ streamId: b.streamId, kind: 'stdout', payload: new Uint8Array([1]) });
    emit({ streamId: a.streamId, kind: 'stderr', payload: new Uint8Array([2]) });
    emit({ streamId: 'someone-else', kind: 'stdout', payload: new Uint8Array([9]) });

    const rb = await b.it.next();
    const ra = await a.it.next();
    expect(rb).toEqual({ value: { stream: 'stdout', chunk: new Uint8Array([1]) }, done: false });
    expect(ra).toEqual({ value: { stream: 'stderr', chunk: new Uint8Array([2]) }, done: false });

    emit({ streamId: a.streamId, kind: 'exit', payload: { exitCode: 0, signal: null } });
    await expect(a.done).resolves.toEqual({ exitCode: 0, signal: null });
    // c 仍在等待:没收到任何别的流的数据
    const pendingC = c.it.next();
    emit({ streamId: c.streamId, kind: 'stdout', payload: new Uint8Array([3]) });
    expect((await pendingC).value).toEqual({ stream: 'stdout', chunk: new Uint8Array([3]) });

    // 最后一条流结束 → 摘掉 listener(无活跃流时不驻留)
    emit({ streamId: b.streamId, kind: 'exit', payload: { exitCode: 0, signal: null } });
    expect(ipcMock.listeners.size).toBe(1);
    await c.it.return!();
    expect(ipcMock.listeners.size).toBe(0);

    // 已结束流的迟到事件被忽略
    emit({ streamId: a.streamId, kind: 'stdout', payload: new Uint8Array([4]) });
    await expect(a.it.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it('无主畸形 payload 只告警一次,不影响活跃流;本流畸形 → 只收敛本流', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = startStream();
    const b = startStream();
    emit({ kind: 'stdout' });
    expect(warn).toHaveBeenCalledTimes(1);
    // null / 非对象 / streamId 非串:同样只告警、不抛、不动任何流
    for (const bad of [null, 's', 42, { streamId: 1 }]) emit(bad);
    expect(warn).toHaveBeenCalledTimes(5);

    emit({ streamId: a.streamId, kind: 'bogus' });
    await expect(a.done).resolves.toEqual({ exitCode: -1, signal: null });
    emit({ streamId: b.streamId, kind: 'stdout', payload: new Uint8Array([7]) });
    expect((await b.it.next()).value).toEqual({ stream: 'stdout', chunk: new Uint8Array([7]) });
    await b.it.return!();
    warn.mockRestore();
  });
});
