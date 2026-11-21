// topic 49 · 审计 P2-A: plugin-shell-stream ABORT 必须清 active 表 + 升级 SIGKILL。
// 旧实现只发 SIGTERM,子进程吞掉信号时会挂到 timeout(最长 30min)且 active 条目驻留。
import { describe, expect, it } from 'vitest';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../../electron/shared/plugin-shell-stream-channels';
import { registerPluginShellStreamHandlers } from '../../../electron/main/services/plugin-shell-stream.service';
import {
  StubIpcMain,
  makeFakeEvent,
  type StubIpcEvent,
} from '../sdk-contract/integration/make-stub-ipc';

interface StreamEvent {
  streamId: string;
  kind: 'stdout' | 'stderr' | 'exit';
  payload: unknown;
}

function makeHarness(): { ipc: StubIpcMain; event: StubIpcEvent } {
  const ipc = new StubIpcMain();
  registerPluginShellStreamHandlers(ipc as never);
  return { ipc, event: makeFakeEvent({ id: 1, isDestroyed: () => false }) };
}

function sentEvents(event: StubIpcEvent): StreamEvent[] {
  return event.sender.send.mock.calls
    .filter((call) => call[0] === PLUGIN_SHELL_STREAM_CHANNELS.EVENT)
    .map((call) => call[1] as StreamEvent);
}

async function waitFor(
  event: StubIpcEvent,
  predicate: (e: StreamEvent) => boolean,
  what: string,
): Promise<StreamEvent> {
  const start = Date.now();
  while (Date.now() - start < 4500) {
    const found = sentEvents(event).find(predicate);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function decode(payload: unknown): string {
  return Buffer.from(payload as Uint8Array).toString('utf-8');
}

describe('topic 49 · shell-stream ABORT 升级 SIGKILL', () => {
  it('ABORT 对吞 SIGTERM 的子进程 1s 后升级 SIGKILL', async () => {
    const { ipc, event } = makeHarness();
    const streamId = 'sigterm-ignorer';
    // 子进程忽略 SIGTERM(注册空 handler)→ 只能靠 SIGKILL 兜底杀掉。
    // 打印 ready 以确保 handler 已注册后再 ABORT(否则 SIGTERM 命中尚未注册的进程)。
    await ipc.invokeWithEvent(
      event,
      PLUGIN_SHELL_STREAM_CHANNELS.START,
      streamId,
      process.execPath,
      ['-e', "process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000)"],
    );
    await waitFor(
      event,
      (e) => e.streamId === streamId && e.kind === 'stdout' && decode(e.payload).includes('ready'),
      'ready',
    );
    await ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.ABORT, streamId);

    const exit = await waitFor(
      event,
      (e) => e.streamId === streamId && e.kind === 'exit',
      'exit',
    );
    expect(exit.payload).toMatchObject({ signal: 'SIGKILL' });
  }, 8000);

  it('ABORT 后立即清 active 表 → 同 streamId 可再次 START', async () => {
    const { ipc, event } = makeHarness();
    const streamId = 'reuse-id';
    await ipc.invokeWithEvent(
      event,
      PLUGIN_SHELL_STREAM_CHANNELS.START,
      streamId,
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
    );
    await ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.ABORT, streamId);

    // 旧实现 ABORT 不删 active → 这里会抛 "already active"
    await expect(
      ipc.invokeWithEvent(
        event,
        PLUGIN_SHELL_STREAM_CHANNELS.START,
        streamId,
        process.execPath,
        ['-e', 'process.exit(0)'],
      ),
    ).resolves.not.toThrow();

    // 收尾:杀掉重启的(若还活着)
    await ipc
      .invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.ABORT, streamId)
      .catch(() => undefined);
  }, 8000);
});
