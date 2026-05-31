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
});
