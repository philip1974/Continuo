# plugin-panel-props(第三方插件面板 factory 只拿到最小 props)

## 背景

`DockShell` 把 dockview 的原始面板 props 原样传给注册的面板 factory。原始 props 带 `containerApi`
(整个 dock 的 `DockviewApi`)和完整的 `api`(`DockviewPanelApi`,可达 `group` / `close` / `moveTo` …)。
零权限第三方插件注册一个面板即可:枚举全部面板及其 params(终端 sessionId / cwd / title)、关闭或新增任意
面板、导出 / 重置布局 —— 绕过 scoped `app.dock` 只开放 `openPanel` 的限制。

## 行为

- 经 **第三方插件的 scoped app**(PluginManager 激活,带 plugin-fs token)注册的面板:factory 收到的 props
  只有 SDK 类型 `PluginPanelProps` 声明的字段:

  ```ts
  { api: { id, isVisible, onDidVisibilityChange(cb): Disposable } }
  ```

  - `isVisible` 实时反映面板可见性;`onDidVisibilityChange` 回调只收到 `{ isVisible }`。
  - props / api 对象冻结;同一个面板实例多次渲染拿到同一个对象(可放进 effect 依赖)。
  - 没有 `containerApi`、`params`,`api` 上没有 `close` / `group` / `setTitle` 等其它成员。
- 宿主直接注册、或内置插件(不带 token 的 scoped app)注册的面板(terminal / editor / settings …):
  照旧收到 dockview 原始 props。
- 面板 type 已被注销(插件停用)→ 渲染空,不调用旧 factory(既有行为)。

## 残余

- 插件代码与宿主同在 renderer 主世界(无隔离),能从自己渲染的 DOM 节点经 React 内部结构等途径摸到宿主对象;
  本主题只收窄 SDK 正式交到插件手里的接口面。
