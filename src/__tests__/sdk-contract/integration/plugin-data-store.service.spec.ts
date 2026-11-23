import { mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLUGIN_DATA_CHANNELS } from '../../../../electron/shared/plugin-data-channels';
import { MAX_PLUGIN_DATA_BYTES } from '../../../../electron/shared/plugin-data-limits';
import { registerPluginDataStoreHandlers } from '../../../../electron/main/services/plugin-data-store.service';
import { StubIpcMain, makeFakeEvent } from './make-stub-ipc';

let userDataPath: string;
let ipc: StubIpcMain;

beforeEach(async () => {
  userDataPath = await mkdtemp(
    join(tmpdir(), `sdk-contract-data-${randomUUID()}-`),
  );
  // save 只写已安装插件的目录(不 mkdir -p):先建好。
  await mkdir(join(userDataPath, 'plugins', 'plugin.data'), { recursive: true });
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

    await invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, 'plugin.data', JSON.stringify(data.value));

    await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, 'plugin.data')).resolves.toEqual(
      data,
    );
  });

  it('T3.d concurrent saves leave a valid JSON data file', async () => {
    await Promise.all([
      invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, 'plugin.data', JSON.stringify({ n: 1 })),
      invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, 'plugin.data', JSON.stringify({ n: 2 })),
    ]);

    const raw = await readFile(
      join(userDataPath, 'plugins', 'plugin.data', 'data.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as { value: { n: number } };
    expect([1, 2]).toContain(parsed.value.n);
  });

  // perf P2:renderer 已为字节预检算好 value 的序列化串,直接把串过 IPC(结构化克隆字符串远快于克隆对象图),
  // main JSON.parse 一次做形态 / 上限校验后直接落盘 `{"value":<串>}` 。
  describe('SAVE_SERIALIZED:传 value 的 JSON 串', () => {
    const file = () => join(userDataPath, 'plugins', 'plugin.data', 'data.json');

    it('落盘文本即 JSON.stringify({ value }),load 返回同一形态', async () => {
      const value = { enabled: true, n: [1, 2.5, -3], s: '中文\u{1F600}', nested: { a: null } };
      await invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, 'plugin.data', JSON.stringify(value));
      const viaString = await readFile(file(), 'utf-8');
      expect(viaString).toBe(JSON.stringify({ value }));
      await expect(invoke(PLUGIN_DATA_CHANNELS.LOAD, 'plugin.data')).resolves.toEqual({ value });
    });

    it('非字符串 / 非法 JSON / 多值拼接注入 → BAD_INPUT,不写', async () => {
      for (const bad of [{ value: 1 }, null, 42, '', '{', '1,"x":2', '1}, {"y":2']) {
        await expect(
          invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, 'plugin.data', bad),
        ).rejects.toMatchObject({ code: 'BAD_INPUT' });
      }
      await expect(readFile(file(), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('超过 assertJsonValue 形态上限(嵌套过深)→ BAD_INPUT', async () => {
      const deep = '['.repeat(300) + ']'.repeat(300);
      await expect(
        invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, 'plugin.data', deep),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    });

    it('落盘文本超 MAX_PLUGIN_DATA_BYTES → PAYLOAD_TOO_LARGE(按落盘文本计:含 {"value":} 包装)', async () => {
      // value 串本身恰好 = 上限,加包装后超限
      const s = JSON.stringify('x'.repeat(MAX_PLUGIN_DATA_BYTES - 2));
      expect(s.length).toBe(MAX_PLUGIN_DATA_BYTES);
      await expect(
        invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, 'plugin.data', s),
      ).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    });

    it('非法 plugin id → BAD_INPUT', async () => {
      await expect(
        invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, '../evil', '1'),
      ).rejects.toMatchObject({ code: 'BAD_INPUT' });
    });
  });
});
