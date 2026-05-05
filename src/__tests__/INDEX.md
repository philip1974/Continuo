# BDD 规范索引

> 由 `pnpm bdd:index` 自动生成,请勿手工编辑。

## [动画落点契约 (M3)](./animation-contracts/README.md)

- [`contracts.spec.ts`](./animation-contracts/contracts.spec.ts)

## [column-resize (Sidebar 拖拽改宽)](./column-resize/README.md)

- [`compute.spec.ts`](./column-resize/compute.spec.ts)

## [command-hotkeys(全局快捷键派发)](./command-hotkeys/README.md)

- [`command-hotkeys.spec.ts`](./command-hotkeys/command-hotkeys.spec.ts)

## [command-palette(⌘P 浮层 / 模糊搜索 / 键盘导航)](./command-palette/README.md)

- [`CommandPalette.spec.tsx`](./command-palette/CommandPalette.spec.tsx)
- [`fuzzy.spec.ts`](./command-palette/fuzzy.spec.ts)
- [`hotkey.spec.tsx`](./command-palette/hotkey.spec.tsx)
- [`store.spec.ts`](./command-palette/store.spec.ts)

## [core-plugins(内置插件:editor / terminal / output)](./core-plugins/README.md)

- [`core-plugins.spec.ts`](./core-plugins/core-plugins.spec.ts)

## [装饰层契约 (M4)](./decor-contracts/README.md)

- [`license.spec.ts`](./decor-contracts/license.spec.ts)

## [design-system](./design-system/README.md)

- [`components.spec.tsx`](./design-system/components.spec.tsx)
- [`theme-provider.spec.tsx`](./design-system/theme-provider.spec.tsx)
- [`tokens.spec.ts`](./design-system/tokens.spec.ts)

## [editor-action(EditorHeader 工具按钮贡献)](./editor-action/README.md)

- [`editor-action.spec.ts`](./editor-action/editor-action.spec.ts)

## [editor-hooks (M-Editor Step E2)](./editor-hooks/README.md)

- [`auto-save.spec.ts`](./editor-hooks/auto-save.spec.ts)
- [`editor-file-actions.spec.ts`](./editor-hooks/editor-file-actions.spec.ts)

## [editor-store (M-Editor Step E1)](./editor-store/README.md)

- [`editor-store.spec.ts`](./editor-store/editor-store.spec.ts)

## [event-bus(LM 自定义事件总线 + Plugin.registerEvent)](./event-bus/README.md)

- [`event-bus.spec.ts`](./event-bus/event-bus.spec.ts)

## [explorer-decorator(文件树装饰贡献)](./explorer-decorator/README.md)

- [`explorer-decorator.spec.ts`](./explorer-decorator/explorer-decorator.spec.ts)

## [explorer-dropzone (M-Explorer Step 5d)](./explorer-dropzone/README.md)

- [`drop-handlers.spec.ts`](./explorer-dropzone/drop-handlers.spec.ts)

## [explorer-mutate (M-Explorer Step 5)](./explorer-mutate/README.md)

- [`mutate-actions.spec.ts`](./explorer-mutate/mutate-actions.spec.ts)

## [explorer-stores (M-Explorer Step 3)](./explorer-stores/README.md)

- [`explorer.spec.ts`](./explorer-stores/explorer.spec.ts)
- [`persistence-layer.spec.ts`](./explorer-stores/persistence-layer.spec.ts)
- [`persistence-schema.spec.ts`](./explorer-stores/persistence-schema.spec.ts)
- [`pinned.spec.ts`](./explorer-stores/pinned.spec.ts)
- [`workspace.spec.ts`](./explorer-stores/workspace.spec.ts)

## [explorer-tree (M-Explorer Step 4)](./explorer-tree/README.md)

- [`tree-config.spec.ts`](./explorer-tree/tree-config.spec.ts)

## [explorer-watch (M-Explorer Step 6)](./explorer-watch/README.md)

- [`fs-watch-helpers.spec.ts`](./explorer-watch/fs-watch-helpers.spec.ts)
- [`watch-pool.spec.ts`](./explorer-watch/watch-pool.spec.ts)

## [fs-adapter (M-Explorer Step 1)](./fs-adapter/README.md)

- [`fs-adapter.spec.ts`](./fs-adapter/fs-adapter.spec.ts)

## [fs-ipc-bridge (M-Explorer Step 2)](./fs-ipc-bridge/README.md)

- [`fs-ipc-bridge.spec.ts`](./fs-ipc-bridge/fs-ipc-bridge.spec.ts)

## [IPC safeHandle 契约 (跨里程碑)](./ipc-safe-handle/README.md)

- [`safe-handle.spec.ts`](./ipc-safe-handle/safe-handle.spec.ts)

## [layout 持久化 (M2)](./layout-persistence/README.md)

- [`persistence.spec.ts`](./layout-persistence/persistence.spec.ts)

## [permission-prompt(授权 UI store + Modal + Manager 集成)](./permission-prompt/README.md)

- [`PermissionPrompt.spec.tsx`](./permission-prompt/PermissionPrompt.spec.tsx)
- [`promptStore.spec.ts`](./permission-prompt/promptStore.spec.ts)

## [plugin-base(插件基类与 Disposable 模型)](./plugin-base/README.md)

- [`plugin-base.spec.ts`](./plugin-base/plugin-base.spec.ts)

## [plugin-contributions-core(3 个核心贡献点)](./plugin-contributions-core/README.md)

- [`plugin-integration.spec.ts`](./plugin-contributions-core/plugin-integration.spec.ts)
- [`registries.spec.ts`](./plugin-contributions-core/registries.spec.ts)

## [plugin-data(loadData / saveData)](./plugin-data/README.md)

- [`plugin-data.spec.ts`](./plugin-data/plugin-data.spec.ts)

## [plugin-loader(ESM 动态加载 + styles 注入)](./plugin-loader/README.md)

- [`plugin-loader.spec.ts`](./plugin-loader/plugin-loader.spec.ts)

## [plugin-manager(插件目录扫描 + 启用禁用 + 生命周期编排)](./plugin-manager/README.md)

- [`plugin-manager.spec.ts`](./plugin-manager/plugin-manager.spec.ts)

## [plugin-manifest(manifest.json 解析与版本比对)](./plugin-manifest/README.md)

- [`plugin-manifest.spec.ts`](./plugin-manifest/plugin-manifest.spec.ts)

## [plugin-permissions(声明式权限 + 授权门)](./plugin-permissions/README.md)

- [`plugin-permissions.spec.ts`](./plugin-permissions/plugin-permissions.spec.ts)

## [plugins-service(主进程插件目录扫描)](./plugins-service/README.md)

- [`plugins-service.spec.ts`](./plugins-service/plugins-service.spec.ts)

## [plugins-watcher(mtime 自动 watch)](./plugins-watcher/README.md)

- [`plugins-watcher.spec.ts`](./plugins-watcher/plugins-watcher.spec.ts)

## [popout 契约 (M5)](./popout-contracts/README.md)

- [`popout-mode.spec.ts`](./popout-contracts/popout-mode.spec.ts)

## [protocol-url(lm:// 路由)](./protocol-url/README.md)

- [`protocol-url.spec.ts`](./protocol-url/protocol-url.spec.ts)

## [ribbon-registry(IconSidebar 活动栏图标贡献)](./ribbon-registry/README.md)

- [`ribbon-registry.spec.ts`](./ribbon-registry/ribbon-registry.spec.ts)

## [工程骨架就绪 (M1)](./scaffold/README.md)

- [`preload-api.spec.ts`](./scaffold/preload-api.spec.ts)

## [scoped-app(per-plugin LMApp 包装)](./scoped-app/README.md)

- [`sandbox-sweep.spec.ts`](./scoped-app/sandbox-sweep.spec.ts)
- [`scoped-app.spec.ts`](./scoped-app/scoped-app.spec.ts)

## [setting-tab-registry(设置标签贡献)](./setting-tab-registry/README.md)

- [`setting-tab-registry.spec.ts`](./setting-tab-registry/setting-tab-registry.spec.ts)

## [settings-modal(设置弹窗 UI)](./settings-modal/README.md)

- [`settings-modal.spec.tsx`](./settings-modal/settings-modal.spec.tsx)

## [terminal-ipc (M-Terminal Step T2)](./terminal-ipc/README.md)

- [`terminal-ipc.spec.ts`](./terminal-ipc/terminal-ipc.spec.ts)

## [terminal-service (M-Terminal Step T1)](./terminal-service/README.md)

- [`helpers.spec.ts`](./terminal-service/helpers.spec.ts)

## [terminal-store (M-Terminal Step T3)](./terminal-store/README.md)

- [`terminal-store.spec.ts`](./terminal-store/terminal-store.spec.ts)

## [terminal-write (M-Terminal Step T4)](./terminal-write/README.md)

- [`safe-write.spec.ts`](./terminal-write/safe-write.spec.ts)

## [text-stats(StatusBar 用统计)](./text-stats/README.md)

- [`text-stats.spec.ts`](./text-stats/text-stats.spec.ts)
