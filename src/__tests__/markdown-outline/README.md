# 转到符号(⇧⌘O,Quick Open `@`)与侧栏「大纲」视图

对齐 VSCode `workbench.action.gotoSymbol`(GotoSymbolQuickAccessProvider,Quick Open 前缀 `@`,`@:` 按类别分组)、Markdown 的
documentSymbolProvider(`vscode-markdown-languageservice` 的 tableOfContents / documentSymbols)与 `outline` 视图(资源管理器视图容器里
文件树下方的可折叠分区)。此前 ⇧⌘O 无反应、⌘P 不认 `@`,长 Markdown 只能靠滚动 / 查找定位章节。

1. **Markdown 文档符号 = 标题**(`markdown-symbols.ts`,复用锚点链接的源码标题解析 `markdownHeadings`(lezer),按源码文本):
   - ATX(`#`…`######`,含结尾 `###`)与 setext(`===` / `---`)标题,含引用 / 列表项里的;围栏 / 缩进代码块里的 `#`、文首 YAML
     frontmatter(其 `---` 不当 setext)不是标题;行号按原文(frontmatter 抹成空白而不删除);CRLF 同样按行计;
   - 名称 = `'#' × 级别 + ' ' + 纯文本`(VSCode 同);纯文本 = 渲染后的文字(去掉强调 / 行内代码反引号 / 链接地址 / 转义符,图片不计),与锚点链接共用 `markdownHeadings`;空标题也收(与编辑 / 预览视图的标题节点按序号对应);
   - 嵌套:更深的标题挂到前面最近的更浅标题下;节范围 = 标题行到下一个级别 ≤ 它的标题的前一行(没有则到文末);
   - 某行所在的节 = 不晚于该行的最后一个标题(第一个标题之前 → 无);
   - 解析器按需加载(不进启动包),结果按文本缓存(大纲与选择器共用);1 万行 / 1000 个标题解析在几十毫秒内;
     大纲在编辑时防抖 150ms 重解析(期间沿用上次结果),换 tab 立即解析。
2. **命令**:`workbench.action.gotoSymbol`,三语标题「转到编辑器中的符号…」,默认键 `mod+shift+o`(mac ⇧⌘O,其它 Ctrl+Shift+O),
   经命令注册表接入快捷键页(可改键 / 解绑)、命令面板、菜单「转到 → 转到编辑器中的符号…」;执行 → 打开 Quick Open 并预填 `@`
   (命令面板开着则关掉);popout 子窗里按键 → 选择器画在该子窗,目标是该子窗的编辑器组。
   另有 `outline.focus`「资源管理器: 聚焦到大纲视图」(VSCode 同,无默认键):显示侧栏、展开大纲分区、焦点进大纲树。
3. **`@` 模式**(⇧⌘O 预填,或在 ⌘P 里键入 `@`):
   - 目标 = 触发窗口编辑器组的活动编辑器;**三种 Markdown 模式都可跳**:源码(CodeMirror,按源码行)、编辑 / 预览(Milkdown,
     按标题序号经 `markdown-outline-registry` 的视图句柄);
   - 列表 = 标题(文档顺序;每行 `## 名称` + 上级标题名;首行右侧「符号（N）」;`@:` 首行「字符串（N）」—— Markdown 标题只有一类);
     `@` 后的文字模糊过滤标题文字(命中字符高亮;同分按文档顺序);
   - 空查询:初始选中光标所在的节,编辑器不动;**移动选中项 → 编辑器跟随预览**(居中,焦点留在输入框,不记导航);
   - **Enter / 单击** → 关闭、定位到标题(源码 / 编辑:光标到标题开头),焦点交给编辑器;源码模式记导航历史「原位置 → 标题」
     (后退回到原处);Milkdown 视图只记文件(既有行为:导航栈不记 Milkdown 光标);
   - **Esc** / 删掉 `@` → 回到打开前的光标与滚动位置;
   - 提示(VSCode 同款):没有文本编辑器「若要转到符号，请先打开包含符号信息的文本编辑器。」;非 Markdown(本项目无语言服务)
     「活动文本编辑器不提供符号信息。」;没有标题「没有编辑器符号」;无匹配「没有匹配的编辑器符号」。
4. **大纲视图**(侧栏文件树下方的分区,标题栏点击展开 / 折叠,默认折叠;展开状态、跟随光标、排序跨重启保留):
   - 跟随活动编辑器组的活动 tab;Markdown → 标题树;其它 / 无编辑器 →「活动编辑器无法提供大纲信息。」;没有标题 →
     “在文档「x.md」中找不到符号”;过滤无匹配 →「没有匹配的符号」;
   - **当前节**:源码 / 编辑按光标、预览按视口顶部;加粗标出;开「跟随光标」(默认)时活动行跟随它 —— 节被折叠时落在最近的
     可见祖先(VSCode 同:不为此展开);
   - **单击** → 编辑器定位到该标题,焦点留在大纲;**双击 / Enter** → 定位并聚焦编辑器;**空格** → 定位不移焦点;展开 / 折叠只认箭头;
   - **键盘**(同搜索结果树):↑↓ / Home / End / PageUp / PageDown 移动,→ 展开(已展开 → 第一个子项),← 折叠(已折叠 / 叶子 →
     上级);过滤框里 ↓ 进树,Esc 清空过滤;
   - **读屏**:`role=tree`(名称「大纲」)+ `aria-activedescendant`;`treeitem` 带 `aria-level` / `aria-expanded`(有子项时)/
     `aria-selected` / `aria-posinset` / `aria-setsize`,可访问名称为标题文字;空状态 `role=status`;
   - 标题栏:「全部折叠」;「⋯」菜单:跟随光标(`menuitemcheckbox`)、排序依据:位置 / 名称(`menuitemradio`;按名称 = 同级按标题
     文字自然序);过滤框:模糊匹配标题文字,保留命中项的上级并展开全部;
   - 侧栏隐藏(保活)时不解析、不监听。

## 与 VSCode 的差异

- 过滤匹配标题文字,不含名称里的 `#`;VSCode 的「过滤」是在树上键入弹出的查找框,这里是常驻过滤框。
- 大纲没有「按类别排序」:Markdown 标题只有一个类别,结果等同按位置。
- 大纲与文件树的高度比例固定(展开时约 2:3),不可拖拽调整。
- Milkdown(编辑 / 预览)视图的光标不进后退 / 前进导航栈(既有行为),从大纲 / `@` 跳转在这两种模式只记文件。
- 代码文件没有语言服务,`@` 显示「不提供符号信息」,大纲显示「无法提供大纲信息」。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/markdown-symbols.ts` | 标题(`markdown-fragment` 的 `markdownHeadings`,加 `level` / `keepEmpty`)→ 符号树(按需加载) |
| `src/panels/Editor/markdown-outline-model.ts` | 符号类型、按行找节、加载与缓存 |
| `src/panels/Editor/markdown-outline-registry.ts` | Milkdown 视图的大纲句柄(按标题序号定位 / 当前节 / 快照) |
| `src/panels/Editor/markdown-symbol-navigation.ts` | 符号目标解析、当前节、定位(预览 / 确认 + 导航历史)、取消恢复 |
| `src/plugins/quick-open/use-goto-symbol.ts` | `@` 模式:过滤、分组标签、初始选中、预览、Enter、Esc、提示 |
| `src/plugins/quick-open/QuickOpenModal.tsx` | `@` 模式列表 / 提示 |
| `src/panels/Editor/editor-commands.ts` | `GOTO_SYMBOL_COMMAND` / `openGotoSymbol` |
| `src/panels/Outline/*` | 大纲视图:行模型、键盘、状态、命令、组件 |
| `src/shell/ExplorerSidebar.tsx` | 侧栏:文件树 + 大纲分区 |
| `src/design/MenuItem.tsx` | 可勾选菜单项(`checked` / `checkKind`) |

## 规范

- `markdown-symbols.spec.ts`:标题解析(第 1 条)
- `goto-symbol-command.spec.ts`:命令、键位、菜单、popout 分发(第 2 条)
- `goto-symbol-quick-open.spec.tsx`:`@` 模式(源码 / 编辑 / 预览;第 3 条)
- `outline-handle.spec.ts`:Milkdown 视图句柄(当前节 / 定位 / 快照;第 3、4 条)
- `outline-model.spec.ts`:大纲行模型、跟随光标、键盘(第 4 条)
- `outline-view.spec.tsx`:大纲视图(读屏语义、空状态、跟随、单击 / 键盘跳转、过滤、菜单、聚焦命令;第 4 条)
