# 可编辑元素原生右键菜单

只靠鼠标的用户也要能在代码编辑器(CodeMirror)、Markdown 编辑器(Milkdown)、设置搜索框、Git URL 输入框等可编辑元素里复制粘贴(对齐 VSCode / Electron 常见做法)。

- main 在每个 BrowserWindow(主窗与 dockview popout 子窗,`browser-window-created` 统一挂)的 webContents 上监听 `context-menu`,按 `params` 生成原生菜单:
  - 可编辑元素(`isEditable`):「剪切 / 复制 / 粘贴 / ─ / 全选」,用 Electron role 菜单项,可用性分别取 `editFlags.canCut / canCopy / canPaste / canSelectAll`(不可用的项置灰,不隐藏);四项都不可用则不弹。
  - 非可编辑但有选中文本(`selectionText` 非空且 `canCopy`):只给「复制」。
  - 其余(非可编辑、无选区):不弹菜单。
- 文案按当前界面语言(en / zh / ko,`getMainT`)在每次右键时取,切换语言后立即生效。
- 渲染层自定义菜单区域(Explorer 行的 Radix ContextMenu、终端自定义菜单)在 `contextmenu` DOM 事件上 `preventDefault()` —— 已在 Electron 45.3.3 实测:被 preventDefault 的 `contextmenu` 不再触发 webContents `context-menu`,因此不会出现双菜单。约定:**渲染层要接管右键的区域必须对 `contextmenu` 调 `preventDefault()`;需要原生编辑菜单的地方不处理该事件**。
- 拼写建议(`dictionarySuggestions`)不做。
