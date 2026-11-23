// 卸载后迟到的 saveData 不能复活插件目录;历史残留目录不挡重装。行为见同目录 README。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, promises as fs } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// installFromGit 的 clone 用 mock:把 manifest / main 写进真实 tmp clone 目录,其余走真 fs。
const ctl = vi.hoisted(() => ({ manifest: { id: 'com.x.p', name: 'P', version: '1.0.0' } }));
vi.mock('node:child_process', async () => {
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const np = await import('node:path');
  return {
    spawn: (_cmd: string, args: readonly string[]) => {
      const cloneDir = args[args.length - 1] as string;
      const listeners: Record<string, ((arg?: unknown) => void)[]> = {};
      const child = {
        stderr: { on() {} },
        on(ev: string, cb: (arg?: unknown) => void) {
          (listeners[ev] ??= []).push(cb);
          return child;
        },
        kill() {},
      };
      queueMicrotask(() => {
        mkdirSync(cloneDir, { recursive: true });
        writeFileSync(np.join(cloneDir, 'manifest.json'), JSON.stringify(ctl.manifest));
        writeFileSync(np.join(cloneDir, 'main.js'), '// plugin');
        listeners['exit']?.forEach((cb) => cb(0));
      });
      return child;
    },
  };
});

import { registerPluginDataStoreHandlers } from '../../../electron/main/services/plugin-data-store.service';
import { installFromGit, listPluginDirs, uninstallPlugin } from '../../../electron/main/services/plugins.service';
import { PLUGIN_DATA_CHANNELS } from '../../../electron/shared/plugin-data-channels';

const ID = 'com.x.p';
const URL = 'https://example.com/p.git';
const NOT_INSTALLED = expect.objectContaining({ code: 'NOT_INSTALLED' });

type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
let userData: string;
let baseDir: string;
let handlers: Map<string, Handler>;

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => handlers.get(channel)!({}, ...args);
const saveSerialized = (id: string, json: string): Promise<unknown> =>
  invoke(PLUGIN_DATA_CHANNELS.SAVE_SERIALIZED, id, json);

async function installed(id: string): Promise<void> {
  await fs.mkdir(path.join(baseDir, id), { recursive: true });
  await fs.writeFile(path.join(baseDir, id, 'manifest.json'), JSON.stringify({ id, name: 'p', version: '1.0.0' }));
  await fs.writeFile(path.join(baseDir, id, 'main.js'), '');
}

beforeEach(async () => {
  userData = await mkdtemp(path.join(tmpdir(), 'plugin-data-zombie-'));
  baseDir = path.join(userData, 'plugins');
  await fs.mkdir(baseDir);
  handlers = new Map();
  registerPluginDataStoreHandlers({ handle: (c: string, h: Handler) => handlers.set(c, h) } as never, {
    userDataPath: userData,
  });
  ctl.manifest = { id: ID, name: 'P', version: '1.0.0' };
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

describe('saveData 只写已安装插件的目录', () => {
  it('插件目录不存在 → SAVE_SERIALIZED 拒绝(NOT_INSTALLED),不创建目录', async () => {
    await expect(saveSerialized(ID, '{"a":1}')).rejects.toEqual(NOT_INSTALLED);
    expect(existsSync(path.join(baseDir, ID))).toBe(false);
  });

  it('已安装 → 照常保存与读取', async () => {
    await installed(ID);
    await saveSerialized(ID, '{"a":1}');
    expect(await invoke(PLUGIN_DATA_CHANNELS.LOAD, ID)).toEqual({ value: { a: 1 } });
  });

  it('卸载完成后才到达的 saveData → 被拒,目录不复活,同 id 可以重装', async () => {
    await installed(ID);
    await uninstallPlugin(baseDir, ID);
    await expect(saveSerialized(ID, '{"late":true}')).rejects.toEqual(NOT_INSTALLED);
    expect(existsSync(path.join(baseDir, ID))).toBe(false);

    await expect(installFromGit(URL, baseDir)).resolves.toMatchObject({ id: ID });
    expect((await listPluginDirs(baseDir)).map((d) => d.id)).toEqual([ID]);
  });

  it('卸载进行中发起的 saveData 与卸载同锁串行:等卸载结束后被拒,不在 rm 之后重建目录', async () => {
    await installed(ID);
    const uninstalling = uninstallPlugin(baseDir, ID);
    const saving = saveSerialized(ID, '{"late":true}');
    await uninstalling;
    await expect(saving).rejects.toEqual(NOT_INSTALLED);
    expect(existsSync(path.join(baseDir, ID))).toBe(false);
  });
});

describe('历史残留:只剩 data.json 的插件目录(无 manifest.json)', () => {
  async function zombie(extra: Record<string, string> = {}): Promise<string> {
    const dir = path.join(baseDir, ID);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'data.json'), '{"value":{"late":true}}');
    await fs.mkdir(path.join(dir, 'data.json.lock'));
    for (const [name, text] of Object.entries(extra)) await fs.writeFile(path.join(dir, name), text);
    return dir;
  }

  it('前提:残留目录不被列出(UI 没有卸载入口)', async () => {
    await zombie();
    expect(await listPluginDirs(baseDir)).toEqual([]);
  });

  it('安装同 id → 清掉残留后正常安装(不报 EEXIST),不继承残留的 data.json', async () => {
    const dir = await zombie();
    await expect(installFromGit(URL, baseDir)).resolves.toMatchObject({ id: ID, version: '1.0.0' });
    expect(existsSync(path.join(dir, 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(dir, 'data.json'))).toBe(false);
    expect(existsSync(path.join(dir, 'data.json.lock'))).toBe(false);
  });

  it('overwrite 安装同样先清残留,不把残留 data.json 带进新安装', async () => {
    const dir = await zombie();
    await installFromGit(URL, baseDir, { overwrite: true });
    expect(existsSync(path.join(dir, 'data.json'))).toBe(false);
  });

  it('无 manifest 但还有别的文件的目录不是残留 → 不删,照旧 EEXIST', async () => {
    const dir = await zombie({ 'notes.txt': 'user work in progress' });
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(path.join(dir, 'notes.txt'), 'utf8')).toBe('user work in progress');
  });

  it('有 manifest.json 的已安装目录 → 照旧 EEXIST,不动', async () => {
    await installed(ID);
    await fs.writeFile(path.join(baseDir, ID, 'data.json'), '{"value":1}');
    await expect(installFromGit(URL, baseDir)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(path.join(baseDir, ID, 'data.json'), 'utf8')).toBe('{"value":1}');
  });
});
