// 插件系统 IPC 通道(M-Plugin v4.1)。
// 主进程扫 userData/plugins/<id>/,renderer 拿到 manifest + main.js 文本
// 通过 Blob URL 动态 import。

export const PLUGINS_CHANNELS = {
  /** 扫描 plugins 目录,返回所有候选(每个含 manifestText + mainText). */
  LIST_DIRS: 'plugins:list-dirs',
  /** 读取 enabled.json(string[] of plugin ids). */
  READ_ENABLED: 'plugins:read-enabled',
  /** 写 enabled.json. */
  WRITE_ENABLED: 'plugins:write-enabled',
  /** 读 _permissions.json(v4.2). */
  READ_PERMISSIONS: 'plugins:read-permissions',
  /** 写 _permissions.json. */
  WRITE_PERMISSIONS: 'plugins:write-permissions',
  /** main → renderer push:某 plugin main.js mtime 变化(v4.3.1). */
  CHANGED: 'plugins:changed',
  /** main → renderer push:外部 lm:// URL 唤起(v4.4). */
  PROTOCOL_URL: 'plugins:protocol-url',
  /** 从 git URL clone + 安装到 plugins 目录(v4.5). */
  INSTALL_FROM_GIT: 'plugins:install-from-git',
} as const;

export type PluginsChannel = (typeof PLUGINS_CHANNELS)[keyof typeof PLUGINS_CHANNELS];

/** 主→renderer 一次返回的插件目录信息. */
export interface IpcPluginDir {
  /** 目录名(以 manifest.id 为准,renderer 端再校验). */
  readonly id: string;
  /** manifest.json 文件文本. */
  readonly manifestText: string;
  /** main.js 入口文本(renderer Blob URL + dynamic import). */
  readonly mainText: string;
  /** styles.css 文本(可选). */
  readonly stylesText?: string;
}

/** v4.2 权限决策存储的磁盘格式. */
export interface IpcPermissionDecision {
  readonly permission: string;        // 'fs' | 'network' | 'shell' | 'clipboard'(运行时校验)
  readonly granted: boolean;
  readonly decidedAt: number;
}

export type IpcPermissionsMap = Readonly<
  Record<string, readonly IpcPermissionDecision[]>
>;
