import { vi } from 'vitest';

export interface StubWebContents {
  id: number;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
}

export interface StubIpcEvent {
  sender: StubWebContents;
}

export type StubIpcHandler = (
  event: StubIpcEvent,
  ...args: unknown[]
) => unknown;

export class StubIpcMain {
  readonly handlers = new Map<string, StubIpcHandler>();
  readonly listeners = new Map<string, StubIpcHandler[]>();

  handle(channel: string, fn: StubIpcHandler): void {
    this.handlers.set(channel, fn);
  }

  on(channel: string, fn: StubIpcHandler): void {
    const bucket = this.listeners.get(channel) ?? [];
    bucket.push(fn);
    this.listeners.set(channel, bucket);
  }

  async invoke(
    channel: string,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing ipc handler: ${channel}`);
    return handler(makeFakeEvent(), ...args);
  }

  async invokeWithEvent(
    event: StubIpcEvent,
    channel: string,
    ...args: unknown[]
  ): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing ipc handler: ${channel}`);
    return handler(event, ...args);
  }
}

export function makeFakeEvent(
  opts: { id?: number; isDestroyed?: () => boolean } = {},
): StubIpcEvent {
  return {
    sender: {
      id: opts.id ?? 1,
      send: vi.fn(),
      isDestroyed: opts.isDestroyed ?? (() => false),
    },
  };
}

/**
 * Use this from a spec's top-level `vi.mock('electron', () => ...)` factory.
 * Do not call `vi.mock` inside this helper: Vitest hoists mocks before normal
 * imports, so the mock declaration must stay in the spec file.
 */
export function mockElectronAppGetPath(homeDir: string): {
  app: { getPath: ReturnType<typeof vi.fn> };
} {
  return {
    app: {
      getPath: vi.fn((name: string) => (name === 'home' ? homeDir : '')),
    },
  };
}
