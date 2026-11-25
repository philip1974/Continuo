# Markdown 切换模式保留阅读位置与光标(对齐 VSCode 预览与源码按行同步)

VSCode:Markdown 预览与编辑器按源码行同步滚动(预览元素带 `data-line`,`markdown.preview.scrollPreviewWithEditor` /
`scrollEditorWithPreview` 默认开),在编辑器与预览间切换时看到的是同一段内容。修复前 Continuo 切换 源码 / 编辑 / 预览
(EditorPanel 按模式换 key 重挂)时两套滚动各存各的:源码滚到约 660 行切预览 → 回到开头;编辑模式的光标也带不到源码模式。

## 行为

### 交接(`mode-handoff.spec.tsx`)

- 视图卸载时(layout 清理,DOM 仍在、量得到位置)记下 **锚点** = { 模式, 顶部可见的源码行, 光标所在源码行(只读预览无) },
  存在 `editor-view-state-cache`(按 tab id;随重命名迁移、随关闭丢弃,与其它视图状态同一套 LRU)。
- 另一模式的视图挂载 / 就绪时 **取用一次**:把该源码行滚到视口顶边;有光标行时光标移到该行(源码:行首;编辑:对应块,
  代码块内精确到行)。只读预览不动光标。
- **同模式重挂不取用**(切 tab 回来、外部修改重载):仍按各视图自己的状态恢复(CodeMirror 的 EditorState + 滚动快照、
  Milkdown 的 scrollTop,见 `editor-view-state`)。锚点优先于另一模式自己缓存的像素滚动位置(它是用户最近看的位置)。
- 非 Markdown 文件的代码编辑器不记也不取。
- Milkdown 列表项节点视图在挂载后的下一帧恢复它记下的选区,故编辑模式的光标在下一帧设置(否则被改回文档开头)。

### 映射(`position-map.spec.tsx`,真实 Crepe)

ProseMirror 文档不保留源码位置。用 Milkdown 自己的 remark 处理器(slice `remark`,与它建文档同一套解析与插件)把同一份
markdown 解析成带行号的 mdast,与 ProseMirror 文档按「同层第 i 个子节点」同步下钻到最深的块:

- 标题、段落、列表项、引用内段落、表格行、代码块一一对应;代码块内按换行精确到行;其它块内按比例插值(块的源码行数 ×
  顶部已滚过的比例)。块间空行归下一个块。
- 精度:块级(段落内多行时光标落到段落起始行)。Milkdown 不建节点的链接引用定义同层对齐时跳过;预览把 frontmatter 换成
  代码块(多一行空行),其后内容在预览侧的行号偏差 1 行。
- 编辑模式的「当前内容」= 最近一次上抛 / 挂载时的内容(文档未变时),否则序列化当前文档(与随后回写 store 的一致)。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/markdown-position-map.ts` | mdast ↔ ProseMirror 同步下钻:源码行 ↔ 位置、顶部可见行、源码行的视口 y |
| `src/panels/Editor/codemirror-mode-anchor.ts` | 源码视图的锚点记录(`lineBlockAtHeight`)与应用(`scrollIntoView(y:start)` + 光标) |
| `src/panels/Editor/editor-view-state-cache.ts` | 锚点存取(`saveMarkdownModeAnchor` / `takeMarkdownModeAnchor`)、重命名迁移、关闭丢弃 |
| `src/panels/Editor/CodeEditor.tsx` | Markdown 源码视图挂载取用、卸载记录 |
| `src/panels/Editor/MilkdownEditor.tsx` | 定位句柄(就绪回调带出);就绪取用、卸载记录 |

## 端到端

- `tests/e2e/markdown-mode-position.spec.ts`:源码滚到中段切预览,预览顶部可见内容在对应段落附近;切回源码仍在该段;
  编辑模式光标所在段落切到源码后光标在该段的行。
