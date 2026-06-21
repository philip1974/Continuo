// Wraps registerPluginFsHandlers from Op5 service factory.
// All handlers take token as first arg (after event); see (b)-branch design.

import { app, webContents, type IpcMain, type WebContents } from 'electron';
import { join } from 'node:path';
import { PLUGIN_FS_CHANNELS } from '../../shared/plugin-fs-channels';
import { IdentityRegistry } from '../services/identity-registry.service';
import { PathScopeRegistry } from '../services/path-scope-registry.service';
import { registerPluginFsHandlers } from '../services/plugin-fs.service';
import {
  readPluginPathScopes,
  writePluginPathScopes,
} from '../services/plugins.service';
import { ScopeRequestCorrelator } from '../services/scope-request-correlator';

export interface RegisterPluginFsIpcArgs {
  ipcMain: IpcMain;
}

export interface PluginFsIpcHandles {
  identityRegistry: IdentityRegistry;
  pathScopeRegistry: PathScopeRegistry;
  correlator: ScopeRequestCorrelator;
}

/**
 * Register plugin-fs IPC handlers. Returns the underlying registries so callers
 * can issue grant/revoke and listen to scope events in later wiring ops.
 */
// 模块级引用,供窗口硬关闭时 cancelScopeRequestsForWebContents 结算该窗发起的
// pending scope 授权请求(镜像 fs.ipc 的 releaseFsWatchersForWindow)。
let activeCorrelator: ScopeRequestCorrelator | null = null;

/**
 * 窗口关闭时,把该窗 webContents 发起的全部 pending scope 授权请求立即结算掉,
 * 否则 host 侧 `await promise` 要干等满 5min TTL 才被 sweep。返回结算条数。
 */
export function cancelScopeRequestsForWebContents(webContentsId: number): number {
  return activeCorrelator?.cancelBySender(webContentsId) ?? 0;
}

export function registerPluginFsIpc({
  ipcMain,
}: RegisterPluginFsIpcArgs): PluginFsIpcHandles {
  const identityRegistry = new IdentityRegistry();
  const pathScopeRegistry = new PathScopeRegistry(identityRegistry);
  const correlator = new ScopeRequestCorrelator();
  activeCorrelator = correlator;

  // path-scope 持久化落在 userData/plugins/_plugin-path-scopes.json,与决策同目录、分文件。
  const pluginsDir = join(app.getPath('userData'), 'plugins');

  registerPluginFsHandlers(ipcMain, {
    identityRegistry,
    pathScopeRegistry,
    correlator,
    webContentsForSender: (senderId: number): WebContents | null =>
      webContents.fromId(senderId) ?? null,
    loadPersistedScopes: (pluginId) =>
      readPluginPathScopes(pluginsDir, pluginId),
    persistScopes: (pluginId, scopes) =>
      writePluginPathScopes(
        pluginsDir,
        pluginId,
        scopes.map((s) => ({ path: s.path, mode: s.mode })),
      ),
  });

  pathScopeRegistry.on(
    'scope-updated',
    (payload: {
      pluginId: string;
      scopes: readonly { path: string; mode: 'r' | 'rw' }[];
    }) => {
      for (const wc of webContents.getAllWebContents()) {
        if (wc.isDestroyed()) continue;
        wc.send(PLUGIN_FS_CHANNELS.SCOPE_UPDATED, payload);
      }
    },
  );

  return { identityRegistry, pathScopeRegistry, correlator };
}
