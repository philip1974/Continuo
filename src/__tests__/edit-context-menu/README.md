# 可编辑元素原生右键菜单

只靠鼠标的用户也要能在代码编辑器(CodeMirror)、Markdown 编辑器(Milkdown)、设置搜索框、Git URL 输入框等可编辑元素里复制粘贴(对齐 VSCode / Electron 常见做法)。

- main 在每个 BrowserWindow(主窗与 dockview popout 子窗,`browser-window-created` 统一挂)的 webContents 上监听 `context-menu`,按 `params` 生成原生菜单:
  - 可编辑元素(`isEditable`):「剪切 / 复制 / 粘贴 / ─ / 全选」,用 Electron role 菜单项,可用性分别取 `editFlags.canCut / canCopy / canPaste / canSelectAll`(不可用的项置灰,不隐藏);四项都不可用则不弹。
  - 非可编辑但有选中文本(`selectionText` 非空且 `canCopy`):只给「复制」。
  - 其余(非可编辑、无选区):不弹菜单。
- 文案按当前界面语言(en / zh / ko,`getMainT`)在每次右键时取,切换语言后立即生效。
- 渲染层自定义菜单区域(Explorer 行的 Radix ContextMenu、终端自定义菜单)在 `contextmenu` DOM 事件上 `preventDefault()` —— 已在 Electron 45.3.3 实测:被 preventDefault 的 `contextmenu` 不再触发 webContents `context-menu`,因此不会出现双菜单。约定:**渲染层要接管右键的区域必须对 `contextmenu` 调 `preventDefault()`;需要原生编辑菜单的地方不处理该事件**。
- **代码编辑器(CodeMirror:代码文件 / Markdown 源码模式 / 冲突对比)里右键** → VSCode 编辑器右键菜单(`MenuId.EditorContext`,无语言服务时)的分组与顺序:
  「更改所有匹配项 ⌘F2 / 格式化文档 ⇧⌥F / ─ / 剪切 / 复制 / 粘贴 / ─ / 命令面板...」(三语照抄 VSCode `changeAll.label` / `formatDocument.label` / `commandPalette`)。
  - 「格式化文档」只在有格式化程序的文档上出现(JSON;VSCode 的该项 precondition 含 `hasDocumentFormattingProvider`,纯文本不出现)。
  - VSCode 编辑器右键菜单没有「全选」→ 代码编辑器里不给(其它可编辑元素照旧)。
  - 编辑器项 = 菜单命令:点击经 `sendMenuCommand` 交给该窗口的主窗执行(popout 子窗 → 打开它的主窗,作用于该子窗的编辑器);
    键位显示同应用菜单(renderer 推送的生效键位,改键 / 解绑跟随)。「更改所有匹配项」(`editor.action.changeAll`,⌘F2 / Ctrl+F2)
    是新增命令,与「选择所有匹配项」(⇧⌘L)同一实现(VSCode CompatChangeAll)。
  - 判定方式:CodeMirror 的 `contextmenu` 观察者在所在文档(主窗 / popout 子窗)的 `<html>` 上打标记(`code` / `code-format`),main 处理
    `context-menu` 时在触发右键的 frame 里读出并清除(DOM 事件先于原生菜单请求);下一次任意右键开始时清掉未被取走的标记,
    不串到之后在输入框上的右键。读不到 → 按普通可编辑元素。
- Markdown 编辑 / 预览模式(Milkdown)保持普通编辑菜单:更改所有匹配项(多光标)、格式化文档不适用,VSCode 也没有所见即所得的 Markdown 编辑器可对照。
- 拼写建议(`dictionarySuggestions`)不做。
