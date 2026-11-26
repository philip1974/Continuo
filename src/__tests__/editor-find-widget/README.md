# 编辑器查找控件:计数 / 无结果、快捷键、历史、强制颜色(对齐 VSCode findWidget)

行为契约:**编辑器 ⌘F 查找面板显示「当前 / 总数」与「无结果」(标红 + 读屏播报),支持 VSCode 的替换 / 选项切换快捷键与
查找框 ↑ / ↓ 历史;强制颜色下当前匹配、其它匹配与选区可区分。** CodeEditor(代码文件 + Markdown 源码模式)与 Markdown
编辑模式代码块(Crepe 的 CodeMirror)同样生效;终端查找不受影响(各自的键位只挂在 CodeMirror 上)。

## 行为

- **计数**:查找框右侧 `role=status` 计数区。查找词非空时:主选区正落在某个匹配上 →「3 / 154」;否则只显示总数
  「154 个匹配」(单复数,同终端查找)。只数到 1000 个即停(大文档不整篇遍历),显示「1000+」。查询 / 选项 / 文档 / 选区变化
  随之更新,文案不变不写 DOM(不重复播报)。
- **非法正则**:正则模式下查找词不是合法正则 → 计数区显示「正则表达式无效」(en / zh / ko,`editor.find.invalid_regex`,
  同无结果标红 + `aria-invalid`),`new RegExp` 的错误信息(按 CodeMirror 编译用的 `gmu`)作查找框与计数区的 `title`
  (悬停可见,也是查找框的可访问描述;VSCode 查找框弹出正则错误信息)。改回合法 / 清空即恢复。
- **无结果**:无匹配 → 计数区显示「无结果」(en / zh / ko,`editor.find.no_results`,错误色),查找框
  `aria-invalid="true"` + 错误色描边(同 design Input 校验失败态);改回有匹配或清空即恢复。读屏经计数区 live region 听到
  「无结果」,不再停在上次「当前匹配…」。
- **快捷键**(VSCode,平台差异照搬):
  - 替换:mac ⌥⌘F,Windows / Linux Ctrl+H → 打开查找面板并聚焦替换框(只读文档无替换框,停在查找框)。代码编辑器里查找 /
    替换 / 查找下一个·上一个的键经命令注册表分发(可改键,见 `editor-find-keybindings`);Markdown 代码块仍在 CodeMirror 键表里。
  - 切换区分大小写 / 全字匹配 / 正则:mac ⌥⌘C / ⌥⌘W / ⌥⌘R,Windows / Linux Alt+C / W / R;面板打开时在查找框与编辑区都生效,
    复选框同步,计数按新选项重算;面板未打开时不处理(按键照常传出)。
- **历史**:查找框里 ↑ 翻到更早的查找词、↓ 回到更新的,越过最新回到空;回车查找与关闭面板时把当前词记入。去重、最多 50 条,
  同一窗口内所有编辑器共享(内存,不落盘)。IME 组合中的方向键不处理。
- **强制颜色**:`@media (forced-colors: active)` 下当前匹配 `2px solid Highlight`,其它匹配 `1px dashed CanvasText`,选区
  `.cm-selectionBackground` 画 Highlight 轮廓。
- **键位冲突核查**:⌥⌘F / ⌥⌘C / ⌥⌘W / ⌥⌘R / Ctrl+H / Alt+C/W/R 不与工作台命令默认键(useCommandHotkeys 注册的命令、⌘P / ⌘⇧P
  保留键)及应用菜单 accelerator 重合;全局命令按修饰键精确匹配,⌥⌘R 不等于菜单「重新加载」⌘R。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/find-widget-model.ts` | 引擎无关的纯逻辑:`FindHistory` / 窗口共享 `editorFindHistory`、`formatFindCount`、`FIND_MATCH_LIMIT` |
| `src/panels/Editor/codemirror-find.ts` | `codeEditorFind` / `codeMirrorFind` 扩展:默认面板上追加计数、aria-invalid、↑↓ 历史;选项切换键位(`codeMirrorFind` 另带替换键) |
| `src/panels/Editor/CodeEditor.tsx` | 挂 `codeEditorFind` |
| `src/panels/Editor/code-editor-theme.ts` | 计数 / 无结果样式、强制颜色规则;`markdownCodeBlockTheme` 带上 `codeMirrorFind`(Crepe 代码块) |

## Specs

- `editor-find-widget.spec.tsx`
- `find-widget-model.spec.ts`
