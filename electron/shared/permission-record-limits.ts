// 权限记录(_permissions.json / path scopes)各项上限的跨进程单一来源(重构:此前 main IPC zod
// schema、main 读盘层、renderer IpcPermissionStore 三处各声明一份,靠注释「对齐 xxx」维持一致;
// E245/E246 就是其中一处对错了值)。读端与写端必须用同一上限,否则「写成功、读回被截断」。

/** plugin id 长度上限(manifest id schema、各 IPC schema、持久化读端共用)。 */
export const PLUGIN_ID_MAX_LEN = 256;

/** 插件版本串长度上限(manifest version 与 marketplace review 的版本字段共用)。 */
export const PLUGIN_VERSION_MAX_LEN = 128;

export const PERMISSION_RECORD_LIMITS = {
  /** permission record 条目数(plugin key 数)。 */
  PLUGIN_KEYS_MAX: 10_000,
  /** 单插件 decisions 数量。 */
  DECISIONS_PER_PLUGIN_MAX: 1000,
  /** 单插件 path scopes 数量(PathScopeRegistry 的内存上限与持久化读/写上限共用此值,E81/E246)。 */
  PATH_SCOPES_PER_PLUGIN_MAX: 256,
  /** 单条 scope path 长度。 */
  SCOPE_PATH_MAX: 8192,
} as const;
