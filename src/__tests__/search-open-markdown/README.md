# 在文件中查找:打开 Markdown 结果在编辑 / 预览模式下定位并选中匹配

VSCode:点搜索结果(Search 视图)打开文件,总是滚到匹配处并选中匹配范围、焦点进编辑器。修复前 Continuo 打开 Markdown 结果时,
Markdown 处于编辑 / 预览(Milkdown 富文本)模式则 `editor.openFile` 直接返回 `lineApplied: false, reason: 'milkdown-engine'`:
文件开在顶部、焦点也不进编辑器(源码模式走 CodeMirror,本来就能定位)。

## 行为(`markdown-reveal.spec.tsx`,真实 Crepe)

- **打开即定位**:`editor.openFile(path, { line, column, length })` 打开的标签处于 Milkdown 模式 → 交给该标签在活动编辑器组里的
  Milkdown 视图:选中匹配、焦点进编辑区(只读预览聚焦预览区)、匹配在视口外则滚到视口中央(VSCode
  `revealRangeInCenterIfOutsideViewport`)。结果:已定位 → `lineApplied: true`;行号超出源码 → `line-out-of-range`;
  期限(`MARKDOWN_REVEAL_TIMEOUT_MS`,5s)内视图未就绪 → `tab-not-mounted`。
- **只读预览的可见高亮**:预览区 `contenteditable=false`,ProseMirror 不把选区画成 DOM 选区(看不到选中)。只读时另用 ⌘F 的
  「当前匹配」装饰(`co-find-match co-find-match-current`)标出该范围;点击正文(mousedown)、文档变化、⌘F 设置查找词 / 跳转时清除。
  编辑模式照常只靠选区(不叠加高亮)。选装饰而非「聚焦后 domAtPos + setBaseAndExtent 手动画 DOM 选区」:后者在只读内容里
  会被下一次聚焦 / 点击 / 选区同步覆盖,且与 ProseMirror 自己的 DOM 选区管理互相打架。
- **视图尚未就绪**(刚打开:读盘、引擎 chunk 加载、Crepe 异步创建):请求记为待兑现,视图就绪时兑现;兑现排在就绪那一帧的
  滚动位置恢复(视图状态缓存 / 切模式锚点)之后,不被它覆盖。新请求取代未兑现的旧请求(F4 连续跳结果)。
- **源码 → 文档的对应**:ProseMirror 文档不保留源码位置。先按源码行定位匹配所在的块(`markdown-position-map`,与切模式保留位置
  同一套 mdast 同步下钻;表格行取行首的单元格),再按「同一段文字的第几次出现」对齐:数源码里从该块起(代码块从正文首行起)到
  匹配前这段文字出现过几次,在文档里从该块起(只看起始行不晚于匹配行的文本块)取同一序号的那次出现。标记符号(`**`)不在
  匹配文字里时不影响序号;链接地址等不渲染成正文的部分里的出现使序号偏大 → 次数不够时取最后一次。正文里没有这段文字
  (匹配落在标记 / 链接地址里)或未给长度 → 光标放到块起点。
- 列 / 长度是 UTF-16 code unit(与搜索 worker、CodeMirror 同一单位,见 `workspace-search`)。

## 取舍

- 选「源码行定位块 + 块内按出现序号对齐」而不是「整篇文档按查询串重新搜」:后者遇到链接地址 / HTML / frontmatter 等不渲染的
  出现会整体错位,前者的误差被限制在匹配所在的块内。也不在 Milkdown 里做源码偏移 ↔ 文档位置的精确映射(remark 位置信息
  到 ProseMirror 节点的逐字符映射成本高,收益只在极少数「同块内标记 / 地址里也出现同一段文字」的情形)。
- 搜索面板与编辑器在同一个 dock 组时,打开结果会激活编辑器 tab、挡住结果列表:保持现状。VSCode 的 Search 视图在侧栏不会被挡;
  放进编辑区的 Search Editor 默认(`search.searchEditor.doubleClickBehaviour: goToLocation`)同样在本组打开结果。用户可把
  搜索面板拖到另一组。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/markdown-reveal-registry.ts` | 按「编辑器组 + tab」登记定位句柄;待兑现请求、超时、取代 |
| `src/panels/Editor/markdown-position-map.ts` | `rangeForSourceMatch`:源码匹配 → 文档范围 |
| `src/panels/Editor/markdown-find.ts` | `selectAndRevealMarkdownRange`:选中并在视口外时滚到中央;只读时加「当前匹配」高亮 |
| `src/panels/Editor/MilkdownEditor.tsx` | 视图就绪时登记定位句柄,卸载注销 |
| `src/plugins/co-app.ts` | `editor.openFile` 在 Milkdown 模式下请求定位并映射结果 |
