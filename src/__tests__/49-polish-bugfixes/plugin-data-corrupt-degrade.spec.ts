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
    await mkdir(join(userDataPath, 'plugins', id), { recursive: true }); // save 只写已安装插件的目录
    await invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, id, JSON.stringify(data.value));

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
    await invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, id, JSON.stringify('recovered'));
    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).resolves.toEqual({
      value: 'recovered',
    });
  });

  // 边界(E147):data.json 契约是 plain object({value:...})。合法 JSON 但畸形形态(null/字符串/
  // 数组)绕过 renderer 写入 → renderer load 的 hasOwnProperty.call(data,'value') 对 null 抛 / 假丢失。
  it('E147 data.json 是合法 JSON 但非对象(null/字符串/数组)→ load 降级 {} + .corrupt', async () => {
    for (const bad of ['null', '"just a string"', '[1,2,3]', '42']) {
      const id = `e147.${bad.replace(/[^a-z0-9]/gi, '')}`;
      await mkdir(join(userDataPath, 'plugins', id), { recursive: true });
      await writeFile(dataFile(id), bad);
      await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).resolves.toEqual({});
      // 隔离快照保留原始畸形内容
      await expect(
        readFile(`${dataFile(id)}.corrupt`, 'utf-8'),
      ).resolves.toBe(bad);
    }
  });

  // 保存入口只收 value 的 JSON 文本,main 自己包成 `{"value":…}` → 任何 value(含 null / 数组 / 原语)落盘都是
  // plain object,不会破坏 data.json 契约、也不会让下次 load 走损坏隔离。
  it('E147/E237 save 任意 JSON value(null / 数组 / 原语)→ 落盘为 plain object,load 正常且无 .corrupt', async () => {
    for (const [i, value] of [null, [1, 2], 'str', 42, true].entries()) {
      const id = `e147.save${i}`;
      await mkdir(join(userDataPath, 'plugins', id), { recursive: true }); // save 只写已安装插件的目录
      await invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, id, JSON.stringify(value));
      expect(JSON.parse(await readFile(dataFile(id), 'utf-8'))).toEqual({ value });
      await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).resolves.toEqual({ value });
      await expect(access(`${dataFile(id)}.corrupt`)).rejects.toThrow();
    }
  });

  it('E147 save 非字符串 / 非法 JSON 文本 → 拒(BAD_INPUT),不写盘', async () => {
    const id = 'e147.bad';
    await mkdir(join(userDataPath, 'plugins', id), { recursive: true });
    for (const bad of [{ value: 1 }, 42, undefined, '', 'not json', '1,"x":2']) {
      await expect(
        invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, id, bad),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    }
    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).resolves.toEqual({});
  });
});
