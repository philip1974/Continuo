import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_DATA_CHANNELS } from '../../../../electron/shared/plugin-data-channels';
import { registerPluginDataStoreHandlers } from '../../../../electron/main/services/plugin-data-store.service';
import { StubIpcMain, makeFakeEvent } from './make-stub-ipc';

let userDataPath: string;
let ipc: StubIpcMain;

beforeEach(async () => {
  userDataPath = await mkdtemp(
    join(tmpdir(), `sdk-contract-data-${randomUUID()}-`),
  );
  ipc = new StubIpcMain();
  registerPluginDataStoreHandlers(ipc as never, { userDataPath });
});

afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true });
});

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return ipc.invokeWithEvent(makeFakeEvent(), channel, ...args);
}

describe('sdk-contract integration: plugin-data-store.service raw IPC', () => {
  it('T3.a returns an empty object when plugin data was never saved', async () => {
    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, 'plugin.data')).resolves.toEqual(
      {},
    );
  });

  it('T3.b saves then loads a JSON roundtrip', async () => {
    const data = { value: { enabled: true, count: 2 } };

    await invoke(PLUGIN_DATA_CHANNELS.SAVE, 'plugin.data', data);

    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, 'plugin.data')).resolves.toEqual(
      data,
    );
  });

  it('T3.c clear removes saved data and load returns empty object again', async () => {
    await invoke(PLUGIN_DATA_CHANNELS.SAVE, 'plugin.data', { value: 'x' });

    await invoke(PLUGIN_DATA_CHANNELS.CLEAR, 'plugin.data');

    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, 'plugin.data')).resolves.toEqual(
      {},
    );
  });

  it('T3.d concurrent saves leave a valid JSON data file', async () => {
    await Promise.all([
      invoke(PLUGIN_DATA_CHANNELS.SAVE, 'plugin.data', { value: { n: 1 } }),
      invoke(PLUGIN_DATA_CHANNELS.SAVE, 'plugin.data', { value: { n: 2 } }),
    ]);

    const raw = await readFile(
      join(userDataPath, 'plugins', 'plugin.data', 'data.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as { value: { n: number } };
    expect([1, 2]).toContain(parsed.value.n);
  });
});
