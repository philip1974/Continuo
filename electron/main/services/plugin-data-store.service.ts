import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import lockfile from 'proper-lockfile';

const LOCK_OPTS: lockfile.LockOptions = {
  // Op12.5 spike not executed in this batch; using library defaults/recommendation.
  stale: 5_000,
  retries: { retries: 5, minTimeout: 50, maxTimeout: 500, factor: 2 },
};

export interface PluginDataStoreDeps {
  userDataPath: string;
}

// plugin id 必须是单段安全标识符 —— 与 plugins.service / loader 的 id 正则一致。
// 拒绝路径分隔符 / .. / 空,防 dataFile() 的 join 越出 plugins 目录(路径穿越:
// save('../../foo',...) 可在 userData 外任意写/删/读文件)。
const PLUGIN_ID_RE = /^[a-z0-9._-]+$/;

function assertPluginId(pluginId: unknown): asserts pluginId is string {
  if (
    typeof pluginId !== 'string' ||
    pluginId.length === 0 ||
    pluginId === '.' ||
    pluginId === '..' ||
    !PLUGIN_ID_RE.test(pluginId)
  ) {
    throw new Error(`invalid plugin id: ${String(pluginId)}`);
  }
}

export function registerPluginDataStoreHandlers(
  ipcMain: IpcMain,
  deps: PluginDataStoreDeps,
): void {
  const baseDir = join(deps.userDataPath, 'plugins');
  const dataFile = (pluginId: string): string => {
    assertPluginId(pluginId);
    return join(baseDir, pluginId, 'data.json');
  };

  async function ensureDir(pluginId: string): Promise<string> {
    assertPluginId(pluginId);
    const dir = join(baseDir, pluginId);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }

  ipcMain.handle('plugin-data:load', async (_event, pluginId: string) => {
    const file = dataFile(pluginId);
    try {
      const buf = await fs.readFile(file, 'utf-8');
      return JSON.parse(buf) as Record<string, unknown>;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err;
    }
  });

  ipcMain.handle(
    'plugin-data:save',
    async (_event, pluginId: string, data: Record<string, unknown>) => {
      await ensureDir(pluginId);
      const file = dataFile(pluginId);
      try {
        await fs.access(file);
      } catch {
        await fs.writeFile(file, '{}', 'utf-8');
      }

      let release: (() => Promise<void>) | null = null;
      try {
        release = await lockfile.lock(file, LOCK_OPTS);
        await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
      } finally {
        if (release) await release();
      }
    },
  );

  ipcMain.handle('plugin-data:clear', async (_event, pluginId: string) => {
    const file = dataFile(pluginId);
    try {
      await fs.rm(file, { force: true });
    } catch {
      // best effort
    }
  });
}
