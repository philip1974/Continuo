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
  /** 声明式权限请求(v3.3),首次启用提示用户授权. */
  readonly permissions?: readonly import('./permissions').PermissionKey[];
}

/**
 * 插件可访问的 LM 应用门面。
 * 后续按贡献点扩 stores / dock / events / fs / log。
 */
export interface CoApp {
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
  /** 设置标签贡献(v2.4). */
  readonly settingTabs: import('./registries/SettingTabRegistry').SettingTabRegistry;
  /** Explorer 文件树装饰贡献(v3.1). */
  readonly explorerDecorators: import('./registries/ExplorerDecoratorRegistry').ExplorerDecoratorRegistry;
  /** EditorHeader 工具按钮贡献(v3.2). */
  readonly editorActions: import('./registries/EditorActionRegistry').EditorActionRegistry;
}

// ── v5 Phase 1:plugin 拿到的扩展 app(per-plugin scoped) ────────────

export interface PluginFsApi {
  /** 检 'fs',未授抛 PermissionError(Phase 3 启用). */
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(
    path: string,
  ): Promise<readonly import('../../electron/shared/fs-entry').FileEntry[]>;
}

export interface PluginNetworkApi {
  /** 检 'network',未授抛 PermissionError(Phase 3 启用). */
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface PluginShellApi {
  // Phase 3 实装(spawn / exec)。Phase 1 占位,保持接口稳定。
}

export interface PluginClipboardApi {
  /** 检 'clipboard',未授抛 PermissionError(Phase 3 启用). */
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
}

export interface PluginPermissionApi {
  /** 当前 plugin 是否已被授予该权限. */
  check(perm: import('./permissions').PermissionKey): Promise<boolean>;
  /** 当前 plugin 实际拿到的授权列表(decisions 中 granted=true 的). */
  granted(): Promise<readonly import('./permissions').PermissionKey[]>;
}

/**
 * Plugin 拿到的 app:在 CoApp 基础上加 5 个 per-plugin 命名空间。
 * 由 createScopedApp(coApp, pluginId, store) 在激活时构造。
 */
export interface CoPluginApp extends CoApp {
  readonly fs: PluginFsApi;
  readonly network: PluginNetworkApi;
  readonly shell: PluginShellApi;
  readonly clipboard: PluginClipboardApi;
  readonly permission: PluginPermissionApi;
}
