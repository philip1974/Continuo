# chrome-select-none(界面外框的标题栏 / tab 栏不可选中文字)

行为契约:**右键或拖选侧栏标题、大纲标题、编辑器 tab 栏时不选中文字、不残留选区高亮**。VSCode 工作台外框
(`.monaco-workbench` 一带)整体 `user-select: none`,只有编辑器、终端、输入框等内容区可选。macOS 上 Chromium 右键会先选中
光标下的词,外框不设 `user-select: none` 就会留下高亮(第五十一轮审计 B 组问题 10)。

## 覆盖

| 区域 | 实现 |
|---|---|
| 资源管理器标题栏(工作区名 + 工具图标) | `ExplorerHeader` 根元素 `select-none` |
| 大纲标题栏 | `OutlineView` 的 `OutlineHeader` 根元素 `select-none` |
| tab 栏(编辑器文件 tab 等 design `TabNav`) | `src/design/TabNav.css` 的 `.wm-tab-nav { user-select: none }` |

已有的同类外框:dock tab 标题(`SharedTab`)、状态栏(`StatusBar`)、标题栏(`TitleBar`)、资源管理器树行(`FileRow`)本就是
`select-none`。不改内容区:编辑器、终端、搜索框 / 输入框、对话框正文仍可选。

## 规范

- `chrome-select-none.spec.tsx`:资源管理器标题、大纲标题(折叠 / 展开)在 `select-none` 之下;`TabNav.css` 根规则含 `user-select: none`
- e2e `tests/e2e/chrome-select-none.spec.ts`:真实右键侧栏标题 / 大纲标题后页面无选区;编辑器 tab 计算样式 `user-select: none`
