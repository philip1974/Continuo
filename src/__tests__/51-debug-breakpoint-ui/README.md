# topic-51 debug breakpoint UI

本主题覆盖调试状态在 renderer 的可视化契约:

- `debug.store` 的断点按文件路径匹配到 CodeMirror tab 后,显示在独立 debug gutter。
- 最近 `stopped` 的 active session 位置按文件路径匹配到 CodeMirror tab 后,显示 exec-line。
- 路径匹配使用 `path-cross.pathEquals`,包含 Windows 大小写折叠语义。
- Markdown/Milkdown tab 不显示 debug 装饰,避免编辑/预览模式混入 CodeMirror 断点 UI。
- `continued`、`terminated`、session 消失、tab 关闭或关窗时必须清理旧 exec-line 与断点,防止陈旧装饰。
- Debug panel 使用 `@/design` 组件与 renderer i18n catalog,不写硬编码可见文案。

