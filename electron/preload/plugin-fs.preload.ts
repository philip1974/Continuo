// Renderer-facing raw plugin-fs IPC. Token is explicit first arg.
// scoped-app.ts wraps these with token closure so plugin code never sees token.

import { ipcRenderer, type IpcRendererEvent } from 'electron';
import { PLUGIN_FS_CHANNELS } from '../shared/plugin-fs-channels';

export interface PluginFsRawStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface PluginFsRawListEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

export interface PluginFsRaw {
  _registerPlugin(pluginId: string): Promise<{ token: string; generation: number }>;
  _unregisterPlugin(token: string): Promise<void>;

  readFile(token: string, target: string): Promise<string>;
  writeFile(token: string, target: string, content: string): Promise<void>;
  listDir(token: string, target: string): Promise<PluginFsRawListEntry[]>;
  stat(token: string, target: string): Promise<PluginFsRawStat>;
  lstat(token: string, target: string): Promise<PluginFsRawStat>;
  realpath(token: string, target: string): Promise<string>;
  mkdir(
    token: string,
    target: string,
    opts?: { recursive?: boolean },
  ): Promise<void>;
  rename(token: string, src: string, dst: string): Promise<void>;
  rm(
    token: string,
    target: string,
    opts?: { recursive?: boolean; force?: boolean },
  ): Promise<void>;
  cp(
    token: string,
    src: string,
    dst: string,
    opts?: { recursive?: boolean },
  ): Promise<void>;
  readGitBlob(token: string, repoDir: string, sha: string): Promise<Uint8Array>;
  atomicReplaceWithinScope(
    token: string,
    staging: string,
    final: string,
    opts?: { overwrite?: boolean },
  ): Promise<void>;

  requestScope(
    token: string,
    scopes: readonly { path: string; mode: 'r' | 'rw' }[],
  ): Promise<'grant' | 'deny'>;
  /** Called by Op20 PromptStore after user grants/denies; not by plugin code. */
  _scopeDecision(requestId: string, decision: 'grant' | 'deny'): Promise<void>;

  onScopeRequest(
    handler: (payload: {
      requestId: string;
      pluginId: string;
      scopes: readonly { path: string; mode: 'r' | 'rw' }[];
    }) => void,
  ): () => void;
  onScopeUpdated(
    handler: (payload: {
      pluginId: string;
      scopes: readonly { path: string; mode: 'r' | 'rw' }[];
    }) => void,
  ): () => void;
}

export const pluginFsRaw: PluginFsRaw = {
  _registerPlugin: (pluginId) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.REGISTER_PLUGIN, pluginId),
  _unregisterPlugin: (token) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.UNREGISTER_PLUGIN, token),

  readFile: (token, target) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.READ_FILE, token, target),
  writeFile: (token, target, content) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.WRITE_FILE, token, target, content),
  listDir: (token, target) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.LIST_DIR, token, target),
  stat: (token, target) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.STAT, token, target),
  lstat: (token, target) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.LSTAT, token, target),
  realpath: (token, target) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.REALPATH, token, target),
  mkdir: (token, target, opts) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.MKDIR, token, target, opts),
  rename: (token, src, dst) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.RENAME, token, src, dst),
  rm: (token, target, opts) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.RM, token, target, opts),
  cp: (token, src, dst, opts) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.CP, token, src, dst, opts),
  readGitBlob: (token, repoDir, sha) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.READ_GIT_BLOB, token, repoDir, sha),
  atomicReplaceWithinScope: (token, staging, final, opts) =>
    ipcRenderer.invoke(
      PLUGIN_FS_CHANNELS.ATOMIC_REPLACE,
      token,
      staging,
      final,
      opts,
    ),

  requestScope: (token, scopes) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.REQUEST_SCOPE, token, scopes),
  _scopeDecision: (requestId, decision) =>
    ipcRenderer.invoke(PLUGIN_FS_CHANNELS.SCOPE_DECISION, requestId, decision),

  onScopeRequest: (handler) => {
    const wrap = (
      _event: IpcRendererEvent,
      payload: Parameters<typeof handler>[0],
    ) => handler(payload);
    ipcRenderer.on(PLUGIN_FS_CHANNELS.SCOPE_REQUEST, wrap);
    return () => ipcRenderer.removeListener(PLUGIN_FS_CHANNELS.SCOPE_REQUEST, wrap);
  },
  onScopeUpdated: (handler) => {
    const wrap = (
      _event: IpcRendererEvent,
      payload: Parameters<typeof handler>[0],
    ) => handler(payload);
    ipcRenderer.on(PLUGIN_FS_CHANNELS.SCOPE_UPDATED, wrap);
    return () => ipcRenderer.removeListener(PLUGIN_FS_CHANNELS.SCOPE_UPDATED, wrap);
  },
};
