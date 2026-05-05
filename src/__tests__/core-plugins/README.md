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
