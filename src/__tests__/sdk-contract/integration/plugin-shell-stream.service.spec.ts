import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../../../electron/shared/plugin-shell-stream-channels';
import { registerPluginShellStreamHandlers } from '../../../../electron/main/services/plugin-shell-stream.service';
import { StubIpcMain, makeFakeEvent, type StubIpcEvent } from './make-stub-ipc';

interface StreamEvent {
  streamId: string;
  kind: 'stdout' | 'stderr' | 'exit';
  payload: unknown;
}

const active: { ipc: StubIpcMain; event: StubIpcEvent; streamId: string }[] = [];

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

async function waitForEvent(
  event: StubIpcEvent,
  streamId: string,
  kind: StreamEvent['kind'],
): Promise<StreamEvent> {
  const start = Date.now();
  while (Date.now() - start < 4000) {
    const found = sentEvents(event).find(
      (item) => item.streamId === streamId && item.kind === kind,
    );
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${kind} event on ${streamId}`);
}

afterEach(async () => {
  await Promise.all(
    active.splice(0).map(({ ipc, event, streamId }) =>
      ipc
        .invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.ABORT, streamId)
        .catch(() => undefined),
    ),
  );
});

describe('sdk-contract integration: plugin-shell-stream.service', () => {
  it('T6.a streams stdout chunks through sender.send', async () => {
    const { ipc, event } = makeHarness();
    const streamId = 'stdout';

    await ipc.invokeWithEvent(
      event,
      PLUGIN_SHELL_STREAM_CHANNELS.START,
      streamId,
      process.execPath,
      ['-e', 'console.log("hi")'],
    );

    const stdout = await waitForEvent(event, streamId, 'stdout');
    expect(event.sender.send).toHaveBeenCalledWith(
      PLUGIN_SHELL_STREAM_CHANNELS.EVENT,
      expect.objectContaining({ streamId, kind: 'stdout' }),
    );
    expect(Buffer.from(stdout.payload as Uint8Array).toString('utf-8')).toBe(
      'hi\n',
    );
  });

  it('T6.b sends an exit event with the process exit code', async () => {
    const { ipc, event } = makeHarness();
    const streamId = 'exit';

    await ipc.invokeWithEvent(
      event,
      PLUGIN_SHELL_STREAM_CHANNELS.START,
      streamId,
      process.execPath,
      ['-e', 'process.exit(7)'],
    );

    const exit = await waitForEvent(event, streamId, 'exit');
    expect(exit.payload).toEqual({ exitCode: 7, signal: null });
  });

  it('T6.c timeout terminates a long-running stream', async () => {
    const { ipc, event } = makeHarness();
    const streamId = 'timeout';
    active.push({ ipc, event, streamId });

    await ipc.invokeWithEvent(
      event,
      PLUGIN_SHELL_STREAM_CHANNELS.START,
      streamId,
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      { timeoutMs: 100 },
    );

    const exit = await waitForEvent(event, streamId, 'exit');
    expect(exit.payload).toMatchObject({ signal: 'SIGTERM' });
  }, 5000);

  it('T6.d ABORT terminates an active stream', async () => {
    const { ipc, event } = makeHarness();
    const streamId = 'abort';

    await ipc.invokeWithEvent(
      event,
      PLUGIN_SHELL_STREAM_CHANNELS.START,
      streamId,
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
    );
    await ipc.invokeWithEvent(event, PLUGIN_SHELL_STREAM_CHANNELS.ABORT, streamId);

    const exit = await waitForEvent(event, streamId, 'exit');
    expect(exit.kind).toBe('exit');
  }, 5000);

  // 边界(E45,E12 shell.exec 同族):START 在 spawn 前校验 cmd/args/cwd/streamId 长度/数量,
  // 畸形巨量输入 fail-closed 抛 BAD_INPUT,绝不进入 spawn(防 IPC/内存放大 + spawn E2BIG)。
  describe('E45 · START 输入校验', () => {
    const startWith = (
      ipc: StubIpcMain,
      event: StubIpcEvent,
      streamId: string,
      cmd: string,
      args: unknown,
      opts?: unknown,
    ) =>
      ipc.invokeWithEvent(
        event,
        PLUGIN_SHELL_STREAM_CHANNELS.START,
        streamId,
        cmd,
        args,
        opts,
      );

    it('streamId 超 256 → BAD_INPUT,不 spawn', async () => {
      const { ipc, event } = makeHarness();
      await expect(
        startWith(ipc, event, 'x'.repeat(257), process.execPath, []),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
      expect(event.sender.send).not.toHaveBeenCalled();
    });

    it('cmd 超 8192 → BAD_INPUT', async () => {
      const { ipc, event } = makeHarness();
      await expect(
        startWith(ipc, event, 'ok', 'x'.repeat(8193), []),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    });

    it('args 数量超 1024 → BAD_INPUT', async () => {
      const { ipc, event } = makeHarness();
      const manyArgs = Array.from({ length: 1025 }, () => 'a');
      await expect(
        startWith(ipc, event, 'ok', process.execPath, manyArgs),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    });

    it('单 arg 超 16384 → BAD_INPUT', async () => {
      const { ipc, event } = makeHarness();
      await expect(
        startWith(ipc, event, 'ok', process.execPath, ['x'.repeat(16385)]),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    });

    it('cwd 超 8192 → BAD_INPUT', async () => {
      const { ipc, event } = makeHarness();
      await expect(
        startWith(ipc, event, 'ok', process.execPath, [], {
          cwd: '/' + 'x'.repeat(8192),
        }),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    });
  });
});
