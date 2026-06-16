import { afterEach, describe, expect, it } from 'vitest';
import { PLUGIN_SHELL_STREAM_CHANNELS } from '../../shared/plugin-shell-stream-channels';
import { registerPluginShellStreamHandlers } from '../services/plugin-shell-stream.service';

type Handler = (event: { sender: MockWebContents }, ...args: unknown[]) => Promise<void>;

let nextWcId = 1;

class MockWebContents {
  readonly id = nextWcId++;
  readonly sent: { channel: string; payload: unknown }[] = [];
  destroyed = false;
  private destroyHandlers: (() => void)[] = [];

  isDestroyed(): boolean {
    return this.destroyed;
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload });
  }

  once(event: string, handler: () => void): void {
    if (event === 'destroyed') this.destroyHandlers.push(handler);
  }

  /** Test helper: simulate the webContents being destroyed (window close). */
  emitDestroyed(): void {
    this.destroyed = true;
    const handlers = this.destroyHandlers.splice(0);
    for (const h of handlers) h();
  }
}

class FakeIpcMain {
  readonly handlers = new Map<string, Handler>();

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }

  invoke(sender: MockWebContents, channel: string, ...args: unknown[]): Promise<void> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return handler({ sender }, ...args);
  }
}

const childrenToAbort: { ipc: FakeIpcMain; sender: MockWebContents; id: string }[] = [];

function makeHarness(): { ipc: FakeIpcMain; sender: MockWebContents } {
  const ipc = new FakeIpcMain();
  registerPluginShellStreamHandlers(ipc as never);
  return { ipc, sender: new MockWebContents() };
}

function streamEvents(sender: MockWebContents): {
  streamId: string;
  kind: 'stdout' | 'stderr' | 'exit';
  payload: unknown;
}[] {
  return sender.sent
    .filter((s) => s.channel === PLUGIN_SHELL_STREAM_CHANNELS.EVENT)
    .map((s) => s.payload as {
      streamId: string;
      kind: 'stdout' | 'stderr' | 'exit';
      payload: unknown;
    });
}

async function waitForExit(
  sender: MockWebContents,
  streamId: string,
): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
  const started = Date.now();
  while (Date.now() - started < 4000) {
    const exit = streamEvents(sender).find(
      (e) => e.streamId === streamId && e.kind === 'exit',
    );
    if (exit) {
      return exit.payload as {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${streamId}`);
}

function textFor(sender: MockWebContents, kind: 'stdout' | 'stderr'): string {
  return streamEvents(sender)
    .filter((e) => e.kind === kind)
    .map((e) => Buffer.from(e.payload as Uint8Array).toString('utf-8'))
    .join('');
}

afterEach(async () => {
  await Promise.all(
    childrenToAbort.splice(0).map(({ ipc, sender, id }) =>
      ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.ABORT, id).catch(() => {}),
    ),
  );
});

describe('plugin-shell-stream.service', () => {
  it('T3.a streams stdout, stderr, and zero exit', async () => {
    const { ipc, sender } = makeHarness();
    const id = 'happy';

    await ipc.invoke(
      sender,
      PLUGIN_SHELL_STREAM_CHANNELS.START,
      id,
      process.execPath,
      ['-e', "console.log('hello'); console.error('warn'); process.exit(0)"],
    );
    const exit = await waitForExit(sender, id);

    expect(textFor(sender, 'stdout')).toContain('hello\n');
    expect(textFor(sender, 'stderr')).toContain('warn\n');
    expect(exit).toEqual({ exitCode: 0, signal: null });
  });

  it('T3.b supports multiple stdout chunks and exits', async () => {
    const { ipc, sender } = makeHarness();
    const id = 'chunks';

    await ipc.invoke(
      sender,
      PLUGIN_SHELL_STREAM_CHANNELS.START,
      id,
      process.execPath,
      ['-e', "for(let i=0;i<3;i++){console.log(i);} process.exit(0)"],
    );
    const exit = await waitForExit(sender, id);

    expect(textFor(sender, 'stdout')).toContain('0\n1\n2\n');
    expect(streamEvents(sender).filter((e) => e.kind === 'stdout').length).toBeGreaterThanOrEqual(1);
    expect(exit).toEqual({ exitCode: 0, signal: null });
  });

  it('T3.c reports non-zero exit code', async () => {
    const { ipc, sender } = makeHarness();
    const id = 'non-zero';

    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, id, process.execPath, [
      '-e',
      'process.exit(42)',
    ]);
    const exit = await waitForExit(sender, id);

    expect(exit).toEqual({ exitCode: 42, signal: null });
  });

  it('T3.d timeout terminates long-running process', async () => {
    const { ipc, sender } = makeHarness();
    const id = 'timeout';
    childrenToAbort.push({ ipc, sender, id });

    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, id, process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], { timeoutMs: 100 });
    const exit = await waitForExit(sender, id);

    expect(exit.signal === 'SIGTERM' || (exit.exitCode ?? 0) !== 0).toBe(true);
  });

  it('T3.e duplicate streamId throws', async () => {
    const { ipc, sender } = makeHarness();
    const id = 'duplicate';
    childrenToAbort.push({ ipc, sender, id });

    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, id, process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ]);

    await expect(
      ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, id, process.execPath, [
        '-e',
        'process.exit(0)',
      ]),
    ).rejects.toThrow('streamId already active');
  });

  it('T3.f kills stream child + clears active when webContents destroyed', async () => {
    const { ipc, sender } = makeHarness();
    const id = 'destroy-leak';

    await ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, id, process.execPath, [
      '-e',
      'setInterval(() => {}, 1000)',
    ]);

    // 模拟窗口关闭 → webContents 'destroyed' → killStreamsForSender 杀子进程 + 清 active。
    sender.emitDestroyed();

    // active 已清:同 id 重新 START 不再抛 "already active"(否则说明销毁没清理 → 泄漏)。
    childrenToAbort.push({ ipc, sender, id });
    await expect(
      ipc.invoke(sender, PLUGIN_SHELL_STREAM_CHANNELS.START, id, process.execPath, [
        '-e',
        'process.exit(0)',
      ]),
    ).resolves.toBeUndefined();
  });
});
