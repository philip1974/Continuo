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

  it('E147 save 非 plain object(数组/字符串/数字)→ 拒(BAD_INPUT),不写盘', async () => {
    const id = 'e147.save';
    for (const bad of [[1, 2], 'str', 42, true]) {
      await expect(
        invoke(PLUGIN_DATA_CHANNELS.SAVE, id, bad),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    }
    // 未写盘 → load 仍 {}
    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).resolves.toEqual({});
  });

  it('E147 save null/undefined → 归一空对象({}),load 正常', async () => {
    const id = 'e147.null';
    await invoke(PLUGIN_DATA_CHANNELS.SAVE, id, null);
    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).resolves.toEqual({});
  });

  // 边界(E237):校验跑归一后的 payload(data ?? {}),但旧实现落盘写**原始 data** → raw IPC save(id, null)
  // 校验按 {} 过,却把 "null" 写进 data.json,破坏 plain object 契约 → 下次 load 当损坏隔离(.corrupt)+ 降级
  // = 数据静默丢失/重置。E147 的 null 测试只断言 load 返 {}(损坏降级也返 {},漏检);此处断言**落盘内容**
  // 就是合法 {} 且不产生 .corrupt(证落盘对象 === 校验对象)。
  it('E237 raw IPC save(id, null/undefined) → 落盘为合法 {} 且不触发损坏隔离', async () => {
    for (const bad of [null, undefined]) {
      const id = `e237.${bad === null ? 'null' : 'undef'}`;
      await invoke(PLUGIN_DATA_CHANNELS.SAVE, id, bad);
      // 落盘内容就是合法的空对象(不是 "null"/"undefined")
      const raw = await readFile(dataFile(id), 'utf-8');
      expect(JSON.parse(raw)).toEqual({});
      // 未破坏契约 → 后续 load 不走损坏分支,无 .corrupt 快照
      await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, id)).resolves.toEqual({});
      await expect(access(`${dataFile(id)}.corrupt`)).rejects.toThrow();
    }
  });
});
