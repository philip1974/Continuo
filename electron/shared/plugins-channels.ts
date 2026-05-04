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
