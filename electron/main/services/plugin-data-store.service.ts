import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { IpcMain } from 'electron';
import lockfile from 'proper-lockfile';
import { atomicWriteJson } from '../lib/atomic-write';

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
    let buf: string;
    try {
      buf = await fs.readFile(file, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw err; // 权限等真正的 IO 错误仍抛
    }
    try {
      return JSON.parse(buf) as Record<string, unknown>;
    } catch {
      // 文件存在但 JSON 损坏(旧实现非原子写,崩溃/掉电会截断)。旧实现在这里直接
      // rethrow → IPC 永久 reject,该插件持久化数据"假死"丢失。改为:保留一次性
      // `.corrupt` 快照后降级返回 {},不阻塞插件继续运行(与 loadExplorer 同款)。
      await fs.writeFile(`${file}.corrupt`, buf, { flag: 'wx' }).catch(() => {});
      return {};
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
        // 原子写(temp+fsync+rename):旧实现 fs.writeFile 先 truncate 再写,崩溃/
        // 掉电落在中途会把 data.json 截断成损坏 JSON(审计)。
        await atomicWriteJson(file, data);
      } finally {
        // release()(proper-lockfile 解锁)本身可能 reject —— 锁 stale(>5s)被其它
        // 进程接管、或 .lock 目录被外部清掉时抛 "Lock is not owned by you"。若
        // atomicWriteJson 已成功而 release() reject,这个 finally 的 reject 会覆盖
        // 成功结果 → 一次本已落盘成功的写被 IPC 报成失败(未闭环:成功却报错,
        // 上层可能误触发重试或丢弃用户数据反馈)。解锁失败 best-effort 吞掉(锁会在
        // stale 超时后自动回收),不掩盖主结果。与上面 .corrupt 写同款 .catch 风格。
        if (release) await release().catch(() => {});
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
