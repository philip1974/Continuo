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

export function registerPluginDataStoreHandlers(
  ipcMain: IpcMain,
  deps: PluginDataStoreDeps,
): void {
  const baseDir = join(deps.userDataPath, 'plugins');
  const dataFile = (pluginId: string): string =>
    join(baseDir, pluginId, 'data.json');

  async function ensureDir(pluginId: string): Promise<string> {
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
