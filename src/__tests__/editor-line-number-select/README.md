# 行号栏鼠标选行(对齐 VSCode)

此前点击 / 拖动行号什么都不选,拖动时浏览器反而把行号数字当文字选中。VSCode 在行号上按下即进入「按行选择」
(`viewController.dispatchMouse` 的 `startedOnLineNumbers` 分支 → `CursorMoveCommands.line`)。

1. **单击行号** → 选中整行,含换行:选区从该行行首到下一行行首(光标在下一行行首);最后一行 → 到文末。折叠的行块整块选中。
2. **按住拖动** → 按行扩展:向下拖到第 N 行 → 起始行行首 … 第 N+1 行行首;向上拖 → 起始行的下一行行首(锚点)… 第 N 行行首(头);
   拖回起始行 → 只剩起始行。拖出编辑器上 / 下缘时自动滚动并继续扩展。
3. **⇧ 单击行号** → 从当前选区锚点按行扩展到所点行(紧接在行号选行之后,以那整行为起点 —— VSCode `selectionStart`)。
4. **⌥ 单击行号**(多光标修饰键)→ 保留已有光标,另加一个选中该行的光标;**⇧⌥ 单击** → 把主光标换成选中该行。
5. mac 上 ⌃ 单击 / 右键 / 中键不处理(留给右键菜单);折叠栏、断点栏不受影响(只挂在行号栏上);获得焦点(随后可直接键入)。
6. **行号栏不可选中文字**:`.cm-gutters` `user-select: none` —— 在正文里拖选经过 gutter、或在行号上拖动时,行号数字不会被选中。
7. 代码编辑器、Markdown 源码模式、冲突对比视图同样适用(共用 `codeEditorBasicSetup`)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/codemirror-line-number-select.ts` | 整行区间 / 按行扩展(纯函数)、行号 mousedown、拖动跟踪与自动滚动 |
| `src/panels/Editor/codemirror-basic-setup.ts` | 把选行挂到 basicSetup 的行号栏 |
| `src/panels/Editor/code-editor-theme.ts` | gutter `user-select: none` |

## 规范

- `line-number-select.spec.ts`:区间计算、单击 / ⇧ 单击 / ⌥ 单击 / 拖动、右键与 mac ⌃ 单击不处理、gutter 不可选
- e2e `tests/e2e/editor-line-number-select.spec.ts`:真实鼠标在行号上单击 / 拖动 / ⇧ 单击,选中文本与光标行
