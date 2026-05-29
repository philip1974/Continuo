import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { registerPluginDataStoreHandlers } from '../services/plugin-data-store.service';

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;

class FakeIpcMain {
  readonly handlers = new Map<string, Handler>();

  handle(channel: string, handler: Handler): void {
    this.handlers.set(channel, handler);
  }

  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing handler ${channel}`);
    return handler({}, ...args);
  }
}

let roots: string[] = [];

async function makeHarness(): Promise<{
  root: string;
  ipc: FakeIpcMain;
}> {
  const root = await mkdtemp(join(tmpdir(), 'continuo-plugin-data-'));
  roots.push(root);
  const ipc = new FakeIpcMain();
  registerPluginDataStoreHandlers(ipc as never, { userDataPath: root });
  return { root, ipc };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('plugin-data-store.service', () => {
  it('T2.a load missing file returns empty object', async () => {
    const { ipc } = await makeHarness();

    await expect(ipc.invoke('plugin-data:load', 'p.missing')).resolves.toEqual(
      {},
    );
  });

  it('T2.b save then load round-trips JSON data', async () => {
    const { ipc } = await makeHarness();

    await ipc.invoke('plugin-data:save', 'p.roundtrip', { a: 1 });

    await expect(ipc.invoke('plugin-data:load', 'p.roundtrip')).resolves.toEqual({
      a: 1,
    });
  });

  it('T2.c concurrent saves end with one complete caller payload', async () => {
    const { ipc } = await makeHarness();
    const payloads = Array.from({ length: 5 }, (_, i) => ({
      writer: i,
      id: randomUUID(),
    }));

    await Promise.all(
      payloads.map((payload) =>
        ipc.invoke('plugin-data:save', 'p.concurrent', payload),
      ),
    );
    const loaded = await ipc.invoke('plugin-data:load', 'p.concurrent');

    expect(payloads).toContainEqual(loaded);
  });

  it('T2.d clear deletes data file', async () => {
    const { ipc } = await makeHarness();

    await ipc.invoke('plugin-data:save', 'p.clear', { a: 1 });
    await ipc.invoke('plugin-data:clear', 'p.clear');

    await expect(ipc.invoke('plugin-data:load', 'p.clear')).resolves.toEqual({});
  });

  it('T2.e save creates missing parent plugin dir', async () => {
    const { root, ipc } = await makeHarness();
    const file = join(root, 'plugins', 'p.parent', 'data.json');

    expect(existsSync(file)).toBe(false);
    await ipc.invoke('plugin-data:save', 'p.parent', { created: true });

    expect(existsSync(file)).toBe(true);
  });
});
