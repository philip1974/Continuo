# 编辑器查找控件:计数 / 无结果、快捷键、历史、强制颜色(对齐 VSCode findWidget)

行为契约:**编辑器 ⌘F 查找面板显示「当前 / 总数」与「无结果」(标红 + 读屏播报),支持 VSCode 的替换 / 选项切换快捷键与
查找框 ↑ / ↓ 历史;强制颜色下当前匹配、其它匹配与选区可区分。** CodeEditor(代码文件 + Markdown 源码模式)与 Markdown
编辑模式代码块(Crepe 的 CodeMirror)同样生效;终端查找不受影响(各自的键位只挂在 CodeMirror 上)。

## 行为

- **计数**:查找框右侧 `role=status` 计数区。查找词非空时:主选区正落在某个匹配上 →「3 / 154」;否则只显示总数
  「154 个匹配」(单复数,同终端查找)。只数到 1000 个即停(大文档不整篇遍历),显示「1000+」。查询 / 选项 / 文档 / 选区变化
  随之更新,文案不变不写 DOM(不重复播报)。
- **大文档计数不阻塞按键**(VSCode findModel:装饰延迟更新、`MATCHES_LIMIT` 内用装饰跳转):计数按块分片扫描,按键里同步只扫
  一个分片(时间上限 8ms);扫不完的在后续宏任务里每片同样上限继续。期间查询刚变 → 显示已数到的部分「12+ 个匹配」/「3 / 12+」,
  一个都没数到显示「…」(不标红、不报「无结果」);数完换成准确计数。大文档(上次一个分片没扫完)编辑时不在按键里重数:已数到
  的匹配随编辑移动(当前序号照常),约 100ms 无编辑后(VSCode `_updateDecorationsScheduler` 同为 100ms)重数,数完再换。小文档
  一个分片就扫完,行为同前(当场更新)。分片结果与整篇一个 cursor 扫出的匹配序列一致(块边界:正则 / 全字匹配按行对齐,跨块
  匹配靠块尾重叠区接住;例外:跨行正则 + 全字匹配时 CodeMirror 自身在第一个不满足全字的匹配处就停,分片会数得更全)。
- **查找下一个 / 上一个用已数到的匹配**:计数已完整(未封顶、查询与文档未变)时,查找框回车 / ⇧回车、面板「下一个 / 上一个」
  按钮、`editor.action.nextMatchFindAction` / `previousMatchFindAction`(⌘G / ⇧⌘G / F3)直接跳到已数到的匹配(从选区往后 / 往前,
  到头绕回;读屏播报与滚动同 CodeMirror),不再整篇重新搜索;计数未完成 / 封顶 1000+ 时搜索(文本查询沿用 CodeMirror 的
  findNext / findPrevious)。
- **空匹配逐个前进**(VSCode `_moveToNextMatch` / `_moveToPrevMatch`):正则可匹配空串(`^`、`$`、`x*`、`\b`)时,下一个匹配恰是
  选区终点处的空匹配 → 从下一位置再找(上一个对称:跳过选区起点处的空匹配),回车 / ⇧回车 / 按钮 / ⌘G 逐个走、到头绕回,不停在
  原地;计数完整或封顶都一样。
- **替换一次一步**(VSCode `findModel.replace()`):面板「替换」按钮与替换框回车 —— 选区恰是起点不早于选区起点的第一个匹配 →
  替换它并选中替换结尾之后的下一个匹配;否则只选中那个匹配(第一次按 = 选中)。替换结果仍匹配(不区分大小写 `id`→`ID`)也从替换
  结尾之后继续,不卡在同一处;`^` 替换为 `> ` 一次一行。一次替换一个撤销步;正则 `$1` / `$&` / `$$`、`\n` / `\t` 转义同
  CodeMirror;计数分片期间同样一次一步。「全部替换」仍是 CodeMirror 的 replaceAll(`^` 每行一次)。
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
- **输入法组字**:查找框 / 替换框里组字中的按键(`isComposing` 或 `keyCode === 229`)止于面板(捕获阶段 `stopPropagation`,
  不 `preventDefault`):Esc 是取消组字,不关查找条;Enter 是确认候选,不跳下一个、不进历史;方向键选候选,不翻历史;也不冒泡到
  工作台全局热键。组字结束后 Esc / Enter 照常。代码编辑器与 Markdown 代码块同样生效。
- **强制颜色**:`@media (forced-colors: active)` 下当前匹配 `2px solid Highlight`,其它匹配 `1px dashed CanvasText`,选区
  `.cm-selectionBackground` 画 Highlight 轮廓。
- **键位冲突核查**:⌥⌘F / ⌥⌘C / ⌥⌘W / ⌥⌘R / Ctrl+H / Alt+C/W/R 不与工作台命令默认键(useCommandHotkeys 注册的命令、⌘P / ⌘⇧P
  保留键)及应用菜单 accelerator 重合;全局命令按修饰键精确匹配,⌥⌘R 不等于菜单「重新加载」⌘R。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/find-widget-model.ts` | 引擎无关的纯逻辑:`FindHistory` / 窗口共享 `editorFindHistory`、`formatFindCount`、`FIND_MATCH_LIMIT` |
| `src/panels/Editor/codemirror-find.ts` | `codeEditorFind` / `codeMirrorFind` 扩展:默认面板上追加计数(分片 / 防抖)、aria-invalid、↑↓ 历史、用已数到的匹配跳转(`findNextMatch` / `findPreviousMatch`)、空匹配前进、替换一次一步;选项切换键位(`codeMirrorFind` 另带替换键) |
| `src/panels/Editor/find-match-scan.ts` | `MatchScan`:按时间预算分块扫描匹配,结果同整篇 cursor |
| `src/panels/Editor/codemirror-text-commands.ts` | 查找下一个 / 上一个命令接 `findNextMatch` / `findPreviousMatch` |
| `src/panels/Editor/CodeEditor.tsx` | 挂 `codeEditorFind` |
| `src/panels/Editor/code-editor-theme.ts` | 计数 / 无结果样式、强制颜色规则;`markdownCodeBlockTheme` 带上 `codeMirrorFind`(Crepe 代码块) |

## Specs

- `editor-find-widget.spec.tsx`
- `find-widget-model.spec.ts`
- `find-match-scan.spec.ts`(分片 vs 整篇 cursor 的随机对照)
- `find-replace-step.spec.tsx`(替换一次一步、空匹配逐个前进)
- e2e:`tests/e2e/editor-find-large-file.spec.ts`(10 万行文件开查找条输入 / 编辑 / 回车的每键耗时)
- e2e:`tests/e2e/editor-find-replace-step.spec.ts`(替换一次一处、替换结果仍匹配继续前进、`^` 回车逐行、全部替换 `^`)
