// plugin-fs 的跨进程契约:PathScope 形状 + 三个结构化错误类(重构:此前定义在 renderer 树的
// src/plugins/types.ts,main 的 6 个模块反向从 src/ 导入运行时值 —— 分层倒置)。
// 定义下沉到此;src/plugins/types.ts 原样 re-export,插件 SDK 的公开类型入口不变。

export interface PathScope {
  /** Absolute path. `~` allowed (expanded host-side). Glob not supported v0.1. */
  path: string;
  /** 'r' = read only, 'rw' = read + write + mkdir + rename + rm. */
  mode: 'r' | 'rw';
}

/** plugin-fs:stat / lstat 的返回(main 产出,preload / scoped-app 转给插件)。 */
export interface PluginFsRawStat {
  size: number;
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
}

/** plugin-fs:list-dir 的单条返回。 */
export interface PluginFsRawListEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
}

export class ScopeError extends Error {
  readonly code = 'SCOPE_ERROR' as const;
  readonly cause?: unknown;

  constructor(
    message: string,
    public readonly details?: { target?: string; reason?: string },
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'ScopeError';
    this.cause = options?.cause;
  }
}

export class PluginIdentityError extends Error {
  readonly code = 'PLUGIN_IDENTITY_ERROR' as const;
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = 'PluginIdentityError';
    this.cause = options?.cause;
  }
}

export class ScopeRequestTimeoutError extends Error {
  readonly code = 'SCOPE_REQUEST_TIMEOUT' as const;
  readonly cause?: unknown;

  constructor(
    message: string,
    public readonly requestId: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'ScopeRequestTimeoutError';
    this.cause = options?.cause;
  }
}

/** `plugin-fs:read-for-editor` 的 scope 拒绝码(不在已授 scope / 目标不存在 / 落在受保护目录,三者不可区分)。 */
export const PLUGIN_FS_EDITOR_READ_SCOPE_DENIED = 'SCOPE_ERROR';

/**
 * `plugin-fs:read-for-editor` 的结果:插件发起的 editor.openFile 由主进程在 plugin-fs 全局锁的共享锁内完成
 * 「scope 校验 + 读取」,renderer 用这份内容开标签并绑定 canonicalPath(不再按插件给的路径字符串另读一次)。
 * 失败:code = PLUGIN_FS_EDITOR_READ_SCOPE_DENIED,或与编辑器读取入口相同的 FS_* 码(FS_NOT_FILE /
 * FS_FILE_TOO_LARGE / FS_NOT_UTF8 …)。内容只进宿主的编辑器标签,不回传插件代码。
 */
export type PluginFsEditorRead =
  | { readonly ok: true; readonly canonicalPath: string; readonly content: string }
  | { readonly ok: false; readonly code: string; readonly message: string };
