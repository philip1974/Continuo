# editor-milkdown-roundtrip-style

行为契约:**在 Markdown 编辑模式(Milkdown)里改一处再保存,文件只变改动的那几行** —— 不按 Milkdown 自己的风格重写整篇。

## 背景(第四十七轮审计 B4 / B8)

Milkdown 序列化用 remark-stringify 默认风格:只勾一个任务框保存,`- [ ]` → `* [ ]`、`+ item` → `- item`、setext 标题 → ATX、
4 格缩进代码 → 围栏、表格补空格对齐、`2 * 3` → `2 \* 3`、`snake_case` → `snake\_case`;连按两次回车留下的空段落被写成
`<br />`(`@milkdown/preset-commonmark` 的 remarkPreserveEmptyLine 占位)。

## 行为

- 未改动的块原样写回(见 `editor-milkdown-roundtrip-verbatim/`);下列风格用于被改动 / 新建的块。被改动的块若有原文对应块,
  再按该块自己的写法覆盖。
- 序列化风格跟随原文件:挂载时(随 Milkdown 对初始内容的那次解析,不另解析)按文档顺序取第一个无序列表的符号(`-` / `*` / `+`)、
  有序列表分隔符(`.` / `)`)与编号是否递增(前两项编号相同 → `1. 1. 1.`)、分隔线写法(字符 / 个数 / 是否带空格)、一二级标题是 setext 还是 ATX、代码块是围栏(``` / ~~~)
  还是缩进、硬换行是 `\` 还是行尾两空格、与地址同文的链接是 `<url>` 还是裸写;表格是否按列对齐看原文件第一个表格各行是否等宽。原文件没有的结构按 Prettier markdown 默认:`-`、`.`、`---`、
  ATX、``` 围栏、对齐的表格;与地址同文的链接裸写(GFM 自动链接文字,同在纯文本里打的网址;裸写会变义时写 `<url>`,`<url>` 也不成立时
  写 `[文字](地址)`)。强调 / 加粗的符号由 Milkdown 按节点保留(remarkMarker)。之后的解析(粘贴片段、另一编辑器组的
  内容同步)不改风格。
- 同一文件里混用多种列表符号时只能统一成第一个(remark-stringify 只有全局 bullet;相邻的两个列表按其规则换用另一符号)。
- 空段落(连按两次回车)序列化时丢弃,不写 `<br />`;文件里手写的 `<br />` 作为 HTML 原样保留。
- 纯文字里不会被解析成强调的 `*`(两侧空白,且不在文字开头 —— 行首 `* ` 是列表)与 `_`(两侧都是字母 / 数字)不转义;
  会被误解析的照样转义(`\_\_init\_\_`、行首 `\*`)。文中 `[x]` 不在段首、后面不是 `(` / `[` / `:`、不以 `^` 开头时不转义。
- 裸写的链接只在裸写后仍解析成同一链接时裸写:地址形状保守(不含 `&` `*` `'` 括号等,末字符不是句末标点)、前面是段首 / 空白 /
  换行、后面是段尾 / 换行 / 空白(之间可有句末标点);否则写 `<url>`。
- 引用式链接定义(`[text][ref]` + `[ref]: url`)Milkdown 无法保留(解析时内联并删定义,schema 无对应节点)→ 这类文档由
  `isMilkdownUnsafe` 锁在源码模式(见 `editor-milkdown-roundtrip-safety/`)。
- 不影响 frontmatter / wiki-link / 公式的源码模式保护、mermaid 代码块与普通代码块往返。

## Specs

| File | 覆盖 |
|---|---|
| `roundtrip-style.spec.tsx` | 真实 Crepe(jsdom):Prettier 风格 GFM 文档与 `*` / `1)` / `***` / setext / 缩进代码 / 不对齐表格文档编辑一字后只差一行;新结构用默认风格;空段落不写 `<br />`、手写 `<br />` 保留;转义规则(含 `[x]`);表格对齐判定;编号 / 硬换行 / 裸链接推断与整段重写后保持;裸写会变义时写 `<url>`;MilkdownEditor 卸载回写只差一处 |
| `tests/e2e/markdown-writing.spec.ts` | 真实 Electron:编辑模式勾一个任务框保存后文件只变那一行 |

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/milkdown-markdown-style.ts` | 风格推断 + remark 设置 + 去掉空行占位插件 + 少转义 |
| `src/panels/Editor/MilkdownEditor.tsx` | 创建 Crepe 时调 `configureMarkdownStyle(crepe, defaultValue)` |
