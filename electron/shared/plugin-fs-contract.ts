// plugin-fs 的跨进程契约:PathScope 形状 + 三个结构化错误类(重构:此前定义在 renderer 树的
// src/plugins/types.ts,main 的 6 个模块反向从 src/ 导入运行时值 —— 分层倒置)。
// 定义下沉到此;src/plugins/types.ts 原样 re-export,插件 SDK 的公开类型入口不变。

export interface PathScope {
  /** Absolute path. `~` allowed (expanded host-side). Glob not supported v0.1. */
  path: string;
  /** 'r' = read only, 'rw' = read + write + mkdir + rename + rm. */
  mode: 'r' | 'rw';
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
