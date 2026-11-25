# Markdown 编辑 / 预览模式 ⌘F 查找(对齐 VSCode 编辑器 / Markdown 预览的查找)

行为契约:**Markdown 文件在编辑(Milkdown 可编辑)与预览(只读)模式下按 ⌘F(Windows / Linux Ctrl+F)打开查找条,高亮全部
匹配、显示「当前 / 总数」,Enter / ⇧Enter 在匹配间跳转并把当前匹配滚入视图,Esc 关闭并把焦点还给编辑区(选区停在当前匹配)。**
修复前 Milkdown 没有查找,⌘F 无反应。

## VSCode 参照

- 编辑器查找控件(findWidget):输入即查、高亮所有匹配,当前匹配单独强调并滚入视图(视口外时居中);Enter 下一个、⇧Enter
  上一个(循环);区分大小写 / 全字匹配 / 正则三个开关;计数「3 / 154」、无匹配「无结果」;Esc 关闭,焦点回编辑器,选区停在
  当前匹配上;已打开时再按 ⌘F 重新聚焦并全选查找词。
- Markdown 预览(webview)的查找同样是 ⌘F,只读。
- 替换(⌥⌘F)本轮不做:编辑模式只提供查找(VSCode Markdown 预览本身也只有查找;需要替换可切「源码」模式,用代码编辑器的查找替换)。

## 行为

- **入口**:焦点在 Milkdown 编辑区(编辑模式的 ProseMirror,或预览模式的只读 ProseMirror —— 预览区可聚焦,tabIndex=0)或已打开的
  查找条内时,⌘F 被编辑器拦下(preventDefault + 不再冒泡):打开查找条并聚焦、全选查找词;不触发其它全局命令。焦点在正文里的代码块
  (CodeMirror)时 ⌘F 仍归代码块自己的查找面板(CodeMirror 先处理并 preventDefault,Milkdown 不再拦)。
- **查找条**:复用终端查找条(`TerminalSearchBar`)的结构、样式与文案 —— 查找输入、计数(`role=status`)、正则 / 区分大小写 /
  全字匹配开关、上一个 / 下一个 / 关闭;计数文案同代码编辑器查找面板(`find-widget-model` 的 `formatFindCount`:「3 / 154」、
  选区不在匹配上时「154 个匹配」、「无结果」、「1000+」,空查找词不显示);窄宽收缩规则同终端(容器 < 24rem 计数只给读屏,< 20rem 只剩输入框 + 关闭);IME 组合中的
  Enter / Esc 归输入法。浮在编辑区右上角,不随正文滚动。
- **匹配**:在每个文本块(段落 / 标题 / 列表项 / 表格单元格 / 引用…)的纯文本内匹配,可跨行内格式(粗体、链接、行内代码)边界;
  不跨块。代码块(CodeMirror 渲染,有自己的查找)与图片等非文本节点不参与。正则非法 → 无匹配;空匹配跳过。全字匹配:前后不是
  字母 / 数字 / 下划线(Unicode)。匹配数只收集到 1000 个即停,计数显示「1000+」(同终端查找)。
- **当前匹配**:输入 / 改选项时取光标(选区)之后的第一个匹配(没有则第一个);Enter 下一个 / ⇧Enter 上一个(循环)—— 若选区已不在
  当前匹配上(用户点过正文),从选区位置起找。当前匹配同时成为编辑器选区(只读预览同样记录,不影响内容)并在视口外时滚到视口中央。
- **高亮**:ProseMirror 行内装饰 `co-find-match`,当前匹配另加 `co-find-match-current`(颜色同 CodeMirror 查找:其它匹配
  警告色 30%、当前匹配主色 28% + 主色描边;强制颜色下当前匹配 `2px solid Highlight`、其它 `1px dashed CanvasText`)。装饰不改
  文档,不影响序列化 / 自动保存。
- **编辑中**:查找条打开时编辑文档,匹配与计数随之重算。
- **关闭**:Esc(焦点在查找条任意控件上)或关闭按钮 → 清除高亮,焦点回编辑区。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/markdown-find.ts` | ProseMirror 查找插件:`buildFindRegExp` / `findTextMatches`(纯函数)、装饰状态、`setMarkdownFindQuery` / `stepMarkdownFind` / `markdownFindResult` / `revealMarkdownFindMatch` |
| `src/panels/Editor/MilkdownEditor.tsx` | 注册插件、⌘F 拦截、查找条状态与渲染 |
| `src/panels/Terminal/TerminalSearchBar.tsx` | 查找条 UI(复用;`formatResult` 传入编辑器计数文案) |
| `src/panels/Editor/find-widget-model.ts` | 计数文案 `formatFindCount` 与上限 `FIND_MATCH_LIMIT`(与代码编辑器查找共用) |
| `src/styles/milkdown-font-override.css` | 匹配高亮样式(含强制颜色) |

## Specs

- `markdown-find.spec.tsx`:真实 Crepe —— 纯匹配函数、编辑 / 预览模式 ⌘F、计数与跳转、选项、编辑重算、Esc 焦点与选区
