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
  CHECK_PATH: 'plugin-fs:check-path',
  ATOMIC_REPLACE: 'plugin-fs:atomic-replace',
  USER_HOME: 'plugin-fs:user-home',
  REQUEST_SCOPE: 'plugin-fs:request-scope',
  SCOPE_DECISION: 'plugin-fs:scope-decision',
  /** main -> renderer event (sent via webContents.send) */
  SCOPE_REQUEST: 'plugin-fs:scope-request',
  /** main -> renderer event after PathScopeRegistry grant/revoke */
  SCOPE_UPDATED: 'plugin-fs:scope-updated',
} as const;

/**
 * scope 授权请求的存活时间。main 的 correlator 到期按超时收口;renderer 的授权弹窗队列须用同一 TTL
 * 做本地过期(否则过期弹窗滞留、挡住后续请求)。
 */
export const SCOPE_REQUEST_TTL_MS = 300_000;

/** scope 授权请求 requestId 长度上限(renderer 入口守卫;与 agent-auth requestId 同量级)。 */
export const SCOPE_REQUEST_ID_MAX = 256;
