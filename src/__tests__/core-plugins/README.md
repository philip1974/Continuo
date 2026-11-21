# core-plugins(内置插件:editor / terminal / output)

行为契约:**Continuo 启动期同步 boot 3 个内置插件,通过 `coApp.panels.register`
注入 Dockview panel 类型;DockShell 渲染时从 registry 派生组件 map。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/core-plugins/EditorPlugin.ts` | 注册 'editor' panel |
| `src/core-plugins/TerminalPlugin.ts` | 注册 'terminal' panel |
| `src/core-plugins/OutputPlugin.ts` | 注册 'output' panel |
| `src/core-plugins/index.ts` | bootCorePlugins / shutdownCorePlugins |

## 关键行为

### bootCorePlugins

- 同步执行(register 在 onload 内同步);_activate Promise 微任务后 resolve
- 完成后 `coApp.panels.getAll()` 含 3 个 type:`editor / terminal / output`
- 重复 boot → 重复注册,registry 后注册赢 + warn(应避免)

### shutdownCorePlugins

- 反序 _deactivate 全部内置实例
- 完成后 `coApp.panels.getAll()` 为空
- 内部 `instances` 数组清空

### Plugin 集成

- 每个内置插件 manifest.id = `core.<name>`,version `1.0.0`
- onload 调 `this.registerPanel({ type, title, factory })`
- factory 返回 React element(`createElement(Editor)` 等)

### WindowPlugin · 在新窗口打开文件夹

- selectDirectory 返回 `{ok:false}` → notifyFailure 失败 toast(与 Explorer 打开文件夹一致),不建窗
- 用户取消(`{ok:true,data:null}`)→ 静默

### 设置 tab 内容懒加载(perf)

- 内置插件不得静态导入 `CategoryTabContent` / `PluginsTabContent`(源码钉测试):General / Editor / Explorer / Terminal
  共用 `src/core-plugins/lazy-category-tab.ts` 一个 lazy chunk,Plugins tab 内容独立 chunk;模式同 Keybindings
  (`lazy()` + 模块级 `lazyPanel`,Suspense fallback=null,首次打开 tab 一帧空白后显示内容)。
- 各 tab 的 `render()` 多次调用返回同一组件类型。
- 设置首开不走两级 chunk 瀑布:SettingsPanel 外壳的 lazy 工厂同时发起 CategoryTabContent 加载(复用
  `lazy-category-tab` 的 `loadCategoryTabContent`,同一模块实例);注册期不加载;分类预取不阻塞外壳、失败不影响
  外壳加载(`settings-chunk-parallel.spec.tsx`)。
