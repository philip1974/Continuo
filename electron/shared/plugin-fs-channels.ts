// Single source of truth for plugin-fs IPC channel names.
// Renderer (preload) + main both import from here.

export const PLUGIN_FS_CHANNELS = {
  REGISTER_PLUGIN: 'plugin-fs:_register-plugin',
  UNREGISTER_PLUGIN: 'plugin-fs:_unregister-plugin',
  READ_FILE: 'plugin-fs:read-file',
  WRITE_FILE: 'plugin-fs:write-file',
  LIST_DIR: 'plugin-fs:list-dir',
  STAT: 'plugin-fs:stat',
  LSTAT: 'plugin-fs:lstat',
  REALPATH: 'plugin-fs:realpath',
  MKDIR: 'plugin-fs:mkdir',
  RENAME: 'plugin-fs:rename',
  RM: 'plugin-fs:rm',
  CP: 'plugin-fs:cp',
  READ_GIT_BLOB: 'plugin-fs:read-git-blob',
  ATOMIC_REPLACE: 'plugin-fs:atomic-replace',
  USER_HOME: 'plugin-fs:user-home',
  REQUEST_SCOPE: 'plugin-fs:request-scope',
  SCOPE_DECISION: 'plugin-fs:scope-decision',
  /** main -> renderer event (sent via webContents.send) */
  SCOPE_REQUEST: 'plugin-fs:scope-request',
  /** main -> renderer event after PathScopeRegistry grant/revoke */
  SCOPE_UPDATED: 'plugin-fs:scope-updated',
} as const;

export type PluginFsChannel =
  (typeof PLUGIN_FS_CHANNELS)[keyof typeof PLUGIN_FS_CHANNELS];
