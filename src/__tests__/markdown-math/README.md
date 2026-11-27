# markdown-math

Markdown 里的数学公式在**预览**与**编辑**模式渲染成公式(KaTeX),**源码**模式保持原文。编辑模式下改公式之外的内容,保存后公式的字节不变;改公式本身,公式按规范写法写回。对照 VSCode 内置 Markdown 预览的 `markdown.math.enabled`(`extensions/markdown-math` → `@vscode/markdown-it-katex`)。

## 识别规则(预览 / 编辑同一个解析器,只有这一套)

- 行内 `$…$`、`$$…$$`;块 `$$` 独占一行开栏 / 闭栏(remark-math)。
- 单个 `$` 按 Pandoc 规则:开头的 `$` 后面不是空白;结尾的 `$` 前面不是空白或 `\`、后面不是数字。不满足的 `$` 是普通字符,解析继续 —— `$5 and $10`、`$5-$10`、`$ x $` 不是公式;`$5 *and* $10` 里的强调照常生效(不会被当成一段原文吞掉)。`\$` 是普通 `$`。`$$` 不受这些限制。
- 行内代码 / 代码块里的 `$` 不算。
- 不支持 `\(…\)` / `\[…\]`(VSCode 也不支持)。
- 与 VSCode 的差异(取舍):VSCode 按「相邻字符是否为单词字符」判断(`a$x$b` 不算、`$ x $` 算),本项目沿用 Pandoc / Obsidian / Crepe 的空白规则(`a$x$b` 算、`$ x $` 不算);两者都把 `$5 and $10` 当文字。```` ```math ```` / ```` ```latex ```` 围栏在代码块下方显示公式预览(VSCode 渲染 ```` ```math ````),但仍按代码块保存。

## 原样往返

- 改公式之外的内容:`$x_1 + y_2 = z_{max}$`、`$a\,b$`、`$\{x\}$`、多行 `$$\n\int_0^1 x\,dx\n$$`、`$$x$$`、`$$ x $$`、跨行的行内公式、列表 / 引用 / 表格里的公式,字节不变。
- 公式块:`$` 围栏长度、开栏行 `$$` 之后的文字与空白、未闭合(延伸到文末)按原样写回。
- 文字里的 `$`(`$5 and $10`)不加反斜杠;只有去掉反斜杠会新增 / 拆散公式时才转义(以同一解析器判定,结果与原文语义一致)。
- ```` ```latex ```` 代码块仍写成代码块,不会变成 `$$`。
- 改公式本身(点击行内公式在浮层里改,或改公式块的内容):按规范写法写回(`$…$`;块 `$$\n…\n$$`)。
- 已知仍会规范化的少见写法(与 ``` 代码块一致):块后紧跟一行文字时补一个空行、闭栏前的缩进、空公式块里的空行。
- 含公式的文档不再锁在源码模式(引用式链接定义 / wiki-link / frontmatter 仍锁,见 `editor-milkdown-roundtrip-safety`)。

## 渲染

- KaTeX 懒加载:第一次遇到公式才加载 katex(独立 chunk),之前先显示公式原文。样式表随 Crepe 主题(已在编辑器样式里),字体是本地文件、用到才下载(CSP `font-src 'self'`,无 `unsafe-eval`)。
- `trust: false`(`\href`、`\url`、`\includegraphics`、`\htmlClass` 等不生效),`throwOnError: false`:错误公式显示为错误色(`--md-error`)原文,悬停看错误信息,不影响其余内容。
- 公式颜色随正文(currentColor),深 / 浅主题都跟随 token。
- `$$…$$`(行内写法与公式块)按块级样式显示。
- 大量公式:同一公式的渲染结果缓存;一帧内同步渲染有时间预算,超出的排队分帧补渲。

## 编辑体验(Crepe Latex 自带)

- 点击行内公式 → 浮层里编辑公式原文,回车 / 确认按钮写回,点击别处收起;输入 `$x$` 即成公式。
- 公式块是语言为 LaTeX 的代码块:上方 CodeMirror 编辑原文,下方实时预览;输入 `$$` 加空格新建公式块;斜杠菜单「公式」、浮动工具条「行内公式」。

## 模块

| 文件 | 角色 |
|---|---|
| `src/panels/Editor/milkdown-math.ts` | Pandoc 行内分词器、原文 / 围栏信息、按原文序列化、文字 `$` 转义判定、math_inline / code_block schema 覆盖 |
| `src/panels/Editor/katex-render.ts` | KaTeX 懒加载、选项、缓存、分帧渲染、代码块预览 |
| `src/panels/Editor/MilkdownEditor.tsx` | 开启 `CrepeFeature.Latex`,接 `configureMarkdownMath`,斜杠菜单 / 工具条文案 |
| `src/panels/Editor/milkdown-roundtrip-safety.ts` | 公式不再判为不安全 |

## 规范

- `math-roundtrip.spec.tsx` —— 真实 Crepe / MilkdownEditor:审计用例往返、改别处字节不变、改公式输出规范、```latex 围栏、新建公式块
- `math-syntax.spec.ts` —— Pandoc 规则、文字 `$` 转义、随机段落「解析→保存→再解析」语义不变
- `math-render.spec.tsx` —— KaTeX 渲染、错误公式、trust 关闭、块级显示、懒加载、大量公式
- e2e:`tests/e2e/markdown-math.spec.ts`
