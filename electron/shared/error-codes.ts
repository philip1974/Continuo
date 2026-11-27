// topic-15 unified-toast-notification: 全仓业务错误码枚举。
// 范围:main 端 object-literal `code: 'X'`(MAIN_ERROR_CODES)+ fs/** `fsError('FS_X', ...)` / `mapNodeErrnoCode()` 返回(FS_ERROR_CODES)。
// 不含:IPC_ERR.*(infra-level, 已是常量见 ipc-result.ts)、plugin user code、third-party error.code。

const MAIN_ERROR_CODES = {
  // renderer 应答的 agent 授权请求已不在等待(撤销 / 超时 / 窗口关闭已结算)。
  AGENT_AUTH_REQUEST_NOT_PENDING: 'AGENT_AUTH_REQUEST_NOT_PENDING',
  AGENT_NOT_AUTHORIZED: 'AGENT_NOT_AUTHORIZED',
  AWAIT_STOP_HOOK_ALREADY_PENDING: 'AWAIT_STOP_HOOK_ALREADY_PENDING',
  BAD_INPUT: 'BAD_INPUT',
  BAD_MAIN: 'BAD_MAIN',
  BAD_MANIFEST: 'BAD_MANIFEST',
  BAD_ROOT: 'BAD_ROOT',
  BAD_URL: 'BAD_URL',
  DEBUG_ADAPTER_LAUNCH_FAILED: 'DEBUG_ADAPTER_LAUNCH_FAILED',
  DEBUG_NOT_AUTHORIZED: 'DEBUG_NOT_AUTHORIZED',
  // 被调试程序的 node 运行时:main 进程在自身 PATH 中找不到 node(不按 agent 传入的 env 解析)。
  DEBUG_NODE_RUNTIME_NOT_FOUND: 'DEBUG_NODE_RUNTIME_NOT_FOUND',
  DEBUG_PROGRAM_OUTSIDE_WORKSPACE: 'DEBUG_PROGRAM_OUTSIDE_WORKSPACE',
  DEBUG_SESSION_NOT_FOUND: 'DEBUG_SESSION_NOT_FOUND',
  DEBUG_WAIT_TIMEOUT: 'DEBUG_WAIT_TIMEOUT',
  EEXIST: 'EEXIST',
  GIT_FAILED: 'GIT_FAILED',
  GIT_SPAWN_FAILED: 'GIT_SPAWN_FAILED',
  // 插件安装 git clone 超时(常见原因:全局 insteadOf 改写成 ssh 后等待 host key 确认 / 私钥口令)。
  GIT_TIMEOUT: 'GIT_TIMEOUT',
  INVALID_ID: 'INVALID_ID',
  NO_WINDOW: 'NO_WINDOW',
  NO_WINDOW_SEQ: 'NO_WINDOW_SEQ',
  NOT_INSTALLED: 'NOT_INSTALLED',
  // 卸载插件:path scope 授权记录清理失败,中止卸载(不删目录,可重试)。
  PATH_SCOPE_CLEANUP_FAILED: 'PATH_SCOPE_CLEANUP_FAILED',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  // 激活时插件 manifest 已不是列举时的版本(期间被更新):拒绝以旧 manifest 执行新 main。
  PLUGIN_MANIFEST_CHANGED: 'PLUGIN_MANIFEST_CHANGED',
  // 插件安装:clone 到的 manifest.id 与 marketplace entry.id(expectedId)不一致。
  PLUGIN_ID_MISMATCH: 'PLUGIN_ID_MISMATCH',
  // 插件安装 / 更新:manifest.minLMVersion 高于当前应用版本(装上也载不了),覆盖前拒绝、旧版保留。
  PLUGIN_INCOMPATIBLE: 'PLUGIN_INCOMPATIBLE',
  // 插件仓库(克隆树)含符号链接:宿主会读安装目录里的文件,链接可把读取引到目录外,一律拒装。
  PLUGIN_SYMLINK_REJECTED: 'PLUGIN_SYMLINK_REJECTED',
  // 插件安装 / 更新:clone 的体积或文件数超过上限,已终止 git 并清理临时目录。
  PLUGIN_REPO_TOO_LARGE: 'PLUGIN_REPO_TOO_LARGE',
  // 插件更新:旧安装目录里的 data.json(插件数据)无法安全带入新版本(是链接 / 超限 / 读写失败)→ 中止更新,不丢数据。
  PLUGIN_DATA_PRESERVE_FAILED: 'PLUGIN_DATA_PRESERVE_FAILED',
  RM_FAILED: 'RM_FAILED',
  // 在文件中查找:搜索 worker 崩溃 / 异常退出(查询本身的错误另有 BAD_INPUT / BAD_ROOT / FS_*)。
  SEARCH_FAILED: 'SEARCH_FAILED',
  TERMINAL_CREATE_CANCELLED: 'TERMINAL_CREATE_CANCELLED',
  TERMINAL_CWD_UNRESOLVED: 'TERMINAL_CWD_UNRESOLVED',
  TERMINAL_FORBIDDEN_SHELL: 'TERMINAL_FORBIDDEN_SHELL',
  TERMINAL_NO_WINDOW: 'TERMINAL_NO_WINDOW',
  TERMINAL_NOT_FOUND: 'TERMINAL_NOT_FOUND',
  TERMINAL_SESSION_DUPLICATE: 'TERMINAL_SESSION_DUPLICATE',
  TERMINAL_SESSION_NOT_FOUND: 'TERMINAL_SESSION_NOT_FOUND',
  // 边界(E235,E230 数量上限族):终端会话(真实 PTY)数超全局/每窗口上限。
  TOO_MANY_TERMINALS: 'TOO_MANY_TERMINALS',
  // 边界(数量上限):debug 会话(含在途 launch 预占)超全局 / 每窗口上限(同 TOO_MANY_TERMINALS)。
  TOO_MANY_DEBUG_SESSIONS: 'TOO_MANY_DEBUG_SESSIONS',
  TERMINAL_WRITE_FAILED: 'TERMINAL_WRITE_FAILED',
  // 边界(E230,E227/E228/E229 数量上限族):并发 active 资源(流式 shell 子进程)超全局/per-sender 上限。
  TOO_MANY_STREAMS: 'TOO_MANY_STREAMS',
  // 边界(数量上限):renderer 发起的新建窗口超全局主窗口数上限(防插件循环执行 window.new 指数开窗)。
  TOO_MANY_WINDOWS: 'TOO_MANY_WINDOWS',
  WORKSPACE_NOT_ABSOLUTE: 'WORKSPACE_NOT_ABSOLUTE',
  WORKSPACE_NOT_DIRECTORY: 'WORKSPACE_NOT_DIRECTORY',
  WORKSPACE_NOT_FOUND: 'WORKSPACE_NOT_FOUND',
} as const;

export const FS_ERROR_CODES = {
  FS_BAD_NAME: 'FS_BAD_NAME',
  FS_DENIED: 'FS_DENIED',
  FS_EEXIST: 'FS_EEXIST',
  FS_IO: 'FS_IO',
  FS_NOT_DIRECTORY: 'FS_NOT_DIRECTORY',
  FS_NOT_FILE: 'FS_NOT_FILE',
  FS_NOT_FOUND: 'FS_NOT_FOUND',
  // 边界(E18):readFile 目标超大小上限(防整文件读入内存 + IPC 发送卡死/崩溃)。
  FS_FILE_TOO_LARGE: 'FS_FILE_TOO_LARGE',
  // 数据安全:编辑器文本读取入口遇非法 UTF-8(GBK / 二进制等)拒绝打开,防 U+FFFD 替换后保存损坏原文件。
  FS_NOT_UTF8: 'FS_NOT_UTF8',
  // 边界(E30):目录条目数超硬上限(防超大目录一次性构造数组 + IPC 全量返回卡死)。
  FS_DIR_TOO_LARGE: 'FS_DIR_TOO_LARGE',
  // 边界(内存峰值):插件 fs 的大块读取(read-file / list-dir / 仓库对象读取 / editor.openFile)全局并发闸排队已满。
  FS_BUSY: 'FS_BUSY',
  // Explorer 批量移动(粘贴 / 拖动)把文件夹移进它自身或子文件夹:renderer 漏斗先拦,不发 IPC。
  FS_MOVE_INTO_SELF: 'FS_MOVE_INTO_SELF',
  // 保存:目标文件写保护(无写位 / 对当前用户不可写 / Windows 只读属性)。编辑器保存可经用户确认后 overwriteReadonly 覆盖。
  FS_READONLY: 'FS_READONLY',
  // ENOSPC:磁盘空间不足。
  FS_NO_SPACE: 'FS_NO_SPACE',
  // EROFS:只读文件系统(只读挂载的卷 / 镜像)。
  FS_READONLY_FS: 'FS_READONLY_FS',
  // 移到废纸篓失败且不是权限 / 只读卷原因(卷不支持废纸篓等):资源管理器询问是否永久删除。
  FS_TRASH_FAILED: 'FS_TRASH_FAILED',
} as const;

export const ERROR_CODES = {
  ...MAIN_ERROR_CODES,
  ...FS_ERROR_CODES,
} as const;

export type FsErrorCode = (typeof FS_ERROR_CODES)[keyof typeof FS_ERROR_CODES];
