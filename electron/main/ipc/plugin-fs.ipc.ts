// Wraps registerPluginFsHandlers from Op5 service factory.
// All handlers take token as first arg (after event); see (b)-branch design.

import { webContents, type IpcMain, type WebContents } from 'electron';
import { PLUGIN_FS_CHANNELS } from '../../shared/plugin-fs-channels';
import { IdentityRegistry } from '../services/identity-registry.service';
import { PathScopeRegistry } from '../services/path-scope-registry.service';
import { registerPluginFsHandlers } from '../services/plugin-fs.service';
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
export function registerPluginFsIpc({
  ipcMain,
}: RegisterPluginFsIpcArgs): PluginFsIpcHandles {
  const identityRegistry = new IdentityRegistry();
  const pathScopeRegistry = new PathScopeRegistry(identityRegistry);
  const correlator = new ScopeRequestCorrelator();

  registerPluginFsHandlers(ipcMain, {
    identityRegistry,
    pathScopeRegistry,
    correlator,
    webContentsForSender: (senderId: number): WebContents | null =>
      webContents.fromId(senderId) ?? null,
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
