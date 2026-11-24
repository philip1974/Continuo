# dock-plugin-panel-placeholder — 未注册面板类型显示占位,布局不丢

## 背景 / 缺陷

插件面板写进持久化 layout 时 `contentComponent` 就是插件注册的面板 type。启动时布局在
`main-app.ts` 最早预取、DockShell `onReady` 即 `fromJSON`;第三方插件则 fire-and-forget 初始化
(列目录 → 读启用 → 授权 → import → onload → `panels.register`),远慢于布局恢复。

旧实现的 components map 只含当时已注册的类型 → dockview 取 `components[name]` 得 `undefined`
→ `fromJSON` 内构造面板抛错、**先清空全部面板再抛** → DockShell 当作恢复失败,toast + 默认布局,
随后防抖写盘 / 关窗 flush 用默认布局**覆盖磁盘**。编辑器分栏、浮动组全丢。已卸载 / 禁用插件
留下的面板同样触发。

## 行为契约

- `createPanelComponents` 对**任意** name 都返回组件(同一 name 多次取到同一组件)。
- 组件渲染时按 type 从 live 注册表查找:
  - 已注册 → 渲染该 type 当前的 factory(第三方仍只拿最小 props,见 `plugin-panel-props/`);
  - 未注册 → 显示占位文案 `dock.panel.plugin_unavailable`(「插件面板未加载…可关闭此面板」)。
- 注册表变化即重渲染:插件晚到注册 → 占位自动换成真实内容;插件注销 → 回到占位。
- 因此布局含未注册插件面板时 `fromJSON` 不抛、其它面板保留,`toJSON` 仍带着该插件面板
  (不会被默认布局覆盖写盘)。

- factory 可直接是用了 hooks 的组件:渲染进按 spec 稳定 key 的子组件,占位 ↔ 真实内容(及插件 reload 换新 spec)切换时
  整体重挂,不抛 "Rendered more / fewer hooks"。
