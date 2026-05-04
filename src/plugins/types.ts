// LM 插件系统核心类型(M-Plugin v1)。
// 详见 doc/10-插件系统方案.md。

/** 任意"可清理"资源的最小契约。 */
export interface Disposable {
  dispose(): void;
}

/** 插件 manifest.json 解析结果(zod 校验后)。 */
export interface PluginManifest {
  /** 唯一 id,反 DNS 命名(com.example.foo)。 */
  readonly id: string;
  /** 用户可见名称。 */
  readonly name: string;
  /** semver,LM 兼容性比对用。 */
  readonly version: string;
  /** 入口 ESM 文件相对路径,默认 'main.js'. */
  readonly main?: string;
  readonly description?: string;
  readonly author?: string;
  readonly authorUrl?: string;
  /** LM 应用最小版本(semver),低于则拒载。 */
  readonly minLMVersion?: string;
  /** 仅桌面 LM 可加载(暂留,LM 目前只有桌面). */
  readonly isDesktopOnly?: boolean;
}

/**
 * 插件可访问的 LM 应用门面。
 * 后续按贡献点扩 stores / dock / events / fs / log。
 */
export interface LMApp {
  /** LM 应用版本,用于插件 minLMVersion 兼容判断。 */
  readonly version: string;
  /** Dockview panel 类型注册表. */
  readonly panels: import('./registries/PanelRegistry').PanelRegistry;
  /** 命令注册表(命令面板 / hotkey 路由). */
  readonly commands: import('./registries/CommandRegistry').CommandRegistry;
  /** StatusBar item 注册表. */
  readonly statusBar: import('./registries/StatusBarRegistry').StatusBarRegistry;
  /** IconSidebar 活动栏图标贡献(v2.1). */
  readonly ribbon: import('./registries/RibbonRegistry').RibbonRegistry;
  /** LM 自定义事件总线(v2.2). */
  readonly events: import('./EventBus').EventBus;
  /** 插件本地 KV 存储(v2.3),writable so tests 可 monkey-patch. */
  dataStore: import('./PluginDataStore').PluginDataStore;
}
