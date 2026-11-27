# 状态栏光标位置「行 X，列 Y」

此前状态栏只有行数 / 词数 / 字符数统计,没有光标位置。对齐 VSCode `status.editor.selection`(editorStatus.ts,右侧,优先级 100.5:
在缩进 / 编码 / 行尾项之前)。

1. **文案**(照抄 VSCode 本地化;zh 的括号按本项目中文排版规范用全角 —— VSCode 原文为半角「 (已选择12)」/「(已选择 9 个字符)」,`i18n-en-zh-ko` 守护;`singleSelection` / `singleSelectionRange` / `multiSelection` / `multiSelectionRange`):
   - 单个光标:`Ln 16, Col 1` /「行 16，列 1」/「줄 16, 열 1」;
   - 单个选区有选中:`Ln 16, Col 1 (12 selected)` /「行 16，列 1（已选择12）」/「줄 16, 열 1(12 선택됨)」;
   - 多个光标:`3 selections` /「3 选择」/「3 선택 항목」;有选中:`3 selections (9 characters selected)` /「3 选择（已选择 9 个字符）」/
     「3 선택 항목(9자 선택됨)」。
2. **行列**取主选区的头(光标所在处);**列是可视列**:tab 跳到下一个制表位(按文档 tabSize,随状态栏缩进项变化),其余每个码点算 1
  (VSCode `CursorColumns.toStatusbarColumn`)。**已选字符数**按码点,换行按文件行尾计(CRLF 算 2;`getCharacterCountInRange`)。
3. 随光标移动 / 选区 / 打字 / 改 tab 宽度即时更新;显示主窗编辑器组活动 tab 的视图(同一文件在两个组各自一份)。
4. **点击** → 转到行/列(`workbench.action.gotoLine`,同 ⌃G),悬浮提示「Go to Line/Column」/「转到行/列」/「줄/열로 이동」。
5. **只在行编辑器里显示**:代码编辑器与 Markdown 源码模式;Markdown 编辑 / 预览模式(Milkdown)、图片 tab、终端等非编辑器面板不显示
  (VSCode 的 Markdown 预览同样没有该项)。窄宽时比缩进 / 编码项更晚隐藏(容器 < md;VSCode 优先级 100.5 高于缩进 100.4)。
6. 保留原有的行数 / 词数 / 字符数统计项(本项目既有设计),位置项是新增的独立项。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-selection-status.ts` | 位置 / 可视列 / 选中字符数计算(纯函数)、按「组 + tab」登记的 store、文案 key |
| `src/panels/Editor/CodeEditor.tsx` | 选区 / 内容 / tab 宽度变化时登记,卸载时移除 |
| `src/shell/StatusBar.tsx` | `EditorSelectionItem` |

## 规范

- `statusbar-selection.spec.tsx`:可视列 / 字符数、三语文案、随编辑器更新、点击转到行、Milkdown 不显示
- e2e `tests/e2e/statusbar-editor-selection.spec.ts`:真实鼠标点击正文 / 拖选后状态栏文案,点击项打开转到行
