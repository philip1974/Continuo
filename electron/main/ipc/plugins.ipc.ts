// 插件 IPC(M-Plugin v4.1,主进程端)。
// 扫 userData/plugins/<id>/,读 manifest + main.js + styles.css 通过 IPC 给 renderer。

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import { PLUGINS_CHANNELS } from '../../shared/plugins-channels';
import {
  createPluginsWatcher,
  installFromGit,
  listPluginDirs,
  readEnabledIds,
  readPermissions,
  uninstallPlugin,
  writeEnabledIds,
  writePermissions,
} from '../services/plugins.service';

const NoInput = z.undefined();
const WriteEnabledInput = z
  .object({ ids: z.array(z.string()) })
  .strict();
const DecisionSchema = z
  .object({
    permission: z.string(),
    granted: z.boolean(),
    decidedAt: z.number(),
  })
  .strict();
// 可维护性 M6:与 shared IpcPermissionRecord 同步 —— 接受旧数组形态与新
// `{ decisions, pathScopes? }` 形态,让 IPC 校验契约与 renderer 序列化契约一致。
const PathScopeSchema = z
  .object({ path: z.string(), mode: z.enum(['r', 'rw']) })
  .strict();
const PermissionRecordSchema = z.union([
  z.array(DecisionSchema),
  z
    .object({
      decisions: z.array(DecisionSchema),
      pathScopes: z.array(PathScopeSchema).optional(),
    })
    .strict(),
]);
const WritePermissionsInput = z
  .object({ data: z.record(z.string(), PermissionRecordSchema) })
  .strict();
const InstallFromGitInput = z
  .object({ url: z.string().min(1), overwrite: z.boolean().optional() })
  .strict();
const UninstallInput = z
  .object({ id: z.string().min(1) })
  .strict();

export function registerPluginsIpc(): void {
  const userData = app.getPath('userData');
  const pluginsDir = path.join(userData, 'plugins');
  const trusted = defaultIsTrustedFrame;

  safeHandle(
    PLUGINS_CHANNELS.LIST_DIRS,
    NoInput,
    () => listPluginDirs(pluginsDir),
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.READ_ENABLED,
    NoInput,
    () => readEnabledIds(pluginsDir),
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.WRITE_ENABLED,
    WriteEnabledInput,
    async ({ ids }) => {
      await writeEnabledIds(pluginsDir, ids);
    },
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.READ_PERMISSIONS,
    NoInput,
    () => readPermissions(pluginsDir),
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.WRITE_PERMISSIONS,
    WritePermissionsInput,
    async ({ data }) => {
      await writePermissions(pluginsDir, data);
    },
    trusted,
  );

  // v4.3.1 mtime 自动 watch:任一 plugin main.js 改 → 推所有窗口
  const watcher = createPluginsWatcher(pluginsDir, (id) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(PLUGINS_CHANNELS.CHANGED, { id });
      }
    }
  });
  watcher.start(2000);

  // v4.5 从 git URL 安装
  safeHandle(
    PLUGINS_CHANNELS.INSTALL_FROM_GIT,
    InstallFromGitInput,
    ({ url, overwrite }) => installFromGit(url, pluginsDir, { overwrite }),
    trusted,
  );

  // v4.6 卸载
  safeHandle(
    PLUGINS_CHANNELS.UNINSTALL,
    UninstallInput,
    async ({ id }) => {
      await uninstallPlugin(pluginsDir, id);
    },
    trusted,
  );
}
