import { mkdtemp, rm, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_DATA_CHANNELS } from '../../../electron/shared/plugin-data-channels';
import { registerPluginDataStoreHandlers } from '../../../electron/main/services/plugin-data-store.service';
import { StubIpcMain, makeFakeEvent } from '../sdk-contract/integration/make-stub-ipc';

let userDataPath: string;
let ipc: StubIpcMain;

beforeEach(async () => {
  userDataPath = await mkdtemp(join(tmpdir(), `plugin-data-corrupt-${randomUUID()}-`));
  ipc = new StubIpcMain();
  registerPluginDataStoreHandlers(ipc as never, { userDataPath });
});
afterEach(async () => {
  await rm(userDataPath, { recursive: true, force: true });
});

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return ipc.invokeWithEvent(makeFakeEvent(), channel, ...args);
}

function dataFile(pluginId: string): string {
  return join(userDataPath, 'plugins', pluginId, 'data.json');
}

// P2 回归:plugin-data:save 旧实现 fs.writeFile 非原子(truncate-then-write),崩溃/掉电
// 截断 data.json;load 旧实现对 parse 失败直接 rethrow → IPC 永久 reject,该插件持久化
// 数据"假死"丢失。修复:save 用 atomicWriteJson;load 损坏时保留 .corrupt 快照并降级
// 返回 {} 不阻塞插件。
describe('49 · plugin-data 损坏不再永久阻塞 + 原子写', () => {
  it('损坏 data.json → load 降级返 {} 且保留 .corrupt 快照(不再 reject)', async () => {
    const id = 'my.plugin';
    await mkdir(join(userDataPath, 'plugins', id), { recursive: true });
    await writeFile(dataFile(id), '{truncated mid-wr');

    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).resolves.toEqual({});

    const snapshot = await readFile(`${dataFile(id)}.corrupt`, 'utf-8');
    expect(snapshot).toBe('{truncated mid-wr');
  });

  it('save 写出的是合法 JSON(原子写),roundtrip 正确', async () => {
    const id = 'my.plugin';
    const data = { value: { a: 1, 中文: '可以' } };
    await invoke(PLUGIN_DATA_CHANNELS.SAVE, id, data);

    // 文件是合法 JSON
    const raw = await readFile(dataFile(id), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).resolves.toEqual(data);
    // 未触发损坏分支 → 无 .corrupt
    await expect(access(`${dataFile(id)}.corrupt`)).rejects.toThrow();
  });

  it('损坏后再 save → 覆盖成合法 JSON,后续 load 正常', async () => {
    const id = 'my.plugin';
    await mkdir(join(userDataPath, 'plugins', id), { recursive: true });
    await writeFile(dataFile(id), 'NOT JSON');

    expect(await invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).toEqual({});
    await invoke(PLUGIN_DATA_CHANNELS.SAVE, id, { value: 'recovered' });
    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).resolves.toEqual({
      value: 'recovered',
    });
  });
});
