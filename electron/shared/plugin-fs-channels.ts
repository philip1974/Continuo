// Single source of truth for plugin-fs IPC channel names.
// Renderer (preload) + main both import from here.

import type { PathScope } from './plugin-fs-contract';

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
  /** editor.openFile 专用:主进程在同一次持锁内完成 scope 校验 + 读取,返回已校验的内容(见 PluginFsEditorRead)。 */
  READ_FOR_EDITOR: 'plugin-fs:read-for-editor',
  /** 宿主编辑器释放 read-for-editor 记下的一份「插件打开的路径」(标签关闭 / 未新建标签)。 */
  RELEASE_EDITOR_PATH: 'plugin-fs:release-editor-path',
  ATOMIC_REPLACE: 'plugin-fs:atomic-replace',
  USER_HOME: 'plugin-fs:user-home',
  REQUEST_SCOPE: 'plugin-fs:request-scope',
  SCOPE_DECISION: 'plugin-fs:scope-decision',
  /** main -> renderer event (sent via webContents.send) */
  SCOPE_REQUEST: 'plugin-fs:scope-request',
  /** main -> renderer event:某个已发出的 scope-request 在 main 侧已收口(超时 / 插件已注销),撤掉对应弹窗 */
  SCOPE_REQUEST_CANCELLED: 'plugin-fs:scope-request-cancelled',
} as const;


/** scope 授权请求 requestId 长度上限(renderer 入口守卫;与 agent-auth requestId 同量级)。 */
export const SCOPE_REQUEST_ID_MAX = 256;

/** main 推来的 scope:displayPath 是 main 归一化后的路径(`~` 已展开,弹窗展示用),超长时不带;path 仍是插件请求的原始值。 */
export type ScopeRequestScope = PathScope & { readonly displayPath?: string };

/** main -> renderer `SCOPE_REQUEST` 的 payload(renderer 收到时未经校验,须先过运行时守卫)。 */
export interface ScopeRequestPayload {
  readonly requestId: string;
  readonly pluginId: string;
  readonly scopes: readonly ScopeRequestScope[];
}

/** main -> renderer `SCOPE_REQUEST_CANCELLED` 的 payload(同上,未经校验)。 */
export interface ScopeRequestCancelledPayload {
  readonly requestId: string;
}
