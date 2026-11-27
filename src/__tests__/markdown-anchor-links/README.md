# Markdown 锚点链接(`#标题` / `other.md#section` / `#L10`)

对齐 VSCode markdown-language-features(vscode-markdown-languageservice 的 `githubSlugifier`、文档链接解析与
`getSelectionFromLocationFragment`)。此前 `[Section 50](#section-50)` 点了不动,`./sub/other.md#section-b` 只打开文件停在开头。

## 行为

1. **哪些点击会跳转**:编辑模式 Cmd/Ctrl+click(及 Cmd/Ctrl+Enter)、预览模式直接点(见 `markdown-link-resolve`);源码模式
   (CodeMirror)Cmd/Ctrl+click 链接 —— `[文字](地址)`、`![alt](地址)`、`<地址>`;引用式链接等无地址的不处理。源码模式命中链接时
   不再把这次 Cmd/Ctrl+click 当成「添加光标」。
2. **片段解析**(`resolveLink`):`#片段` = 当前文档 + 片段;`path#片段` = 该文件 + 片段;空片段 `#` 同无片段。
3. **定位**:打开(同一文档不重新打开;跨文件打开失败照常提示)后按标签内容找片段:
   - **Markdown 文件先找标题**:按文档顺序给全部标题(ATX / setext,含引用 / 列表项里的;代码块、文首 YAML frontmatter 里的
     不算)算 slug,与片段(URL 解码后)**不区分大小写**比较;
   - **再认行号**:`#L10`、`#L10,5`(第 5 列)、`#10`、`#L10-L20`(取起点)。非 Markdown 文件只认行号。
   - 源码模式:光标移到目标行(行首或指定列)并居中;编辑 / 预览模式:经 `markdown-reveal-registry` 按源码行定位(视图未就绪时
     就绪后兑现)。
   - **找不到**:只打开文件(同文档则什么都不做),不报错(VSCode 同)。
4. **slug 规则**(GitHub / VSCode `githubSlugifier`):标题的渲染文字(去掉强调、删除线、链接地址、图片、行内 HTML 等标记,
   行内代码留内容,转义 / 实体还原)→ 去首尾空白 → 小写 → 删去字母 / 组合符 / 十进制数字 / `_` / 空格 / `-` 以外的字符
   (标点、符号、emoji)→ 空格换 `-`。中文等 Unicode 字母保留。重复标题第 2 个起加 `-1`、`-2`…(加后缀后仍重名继续递增,同
   github-slugger)。例:`Hello, World! 🎉` → `hello-world-`,`安装 指南` → `安装-指南`,第二个 `FAQ` → `faq-1`。
5. **渲染 id 一致**:编辑 / 预览里标题元素的 `id` 用同一个 slug 函数、同一套重复后缀(替换 Milkdown 默认的「小写 + 空格转 `-`、
   重复加 `-#2`」);编辑改名后随之重算。
6. **后退 / 前进**:跳转前记下当前位置(源码:光标;编辑:光标所在源码行;预览:顶部可见源码行),目标相距 ≥ 10 行(或换了文件)
   即新记一条,⌃- 回到跳转前的位置;编辑 / 预览模式的记录按源码行,后退时经 `markdown-reveal-registry` 定位回去。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/markdown-heading-slug.ts` | `githubSlug` / `createSlugBuilder`(渲染与解析共用) |
| `src/panels/Editor/markdown-fragment.ts` | 源码标题收集(lezer)与 `#片段` → 行 |
| `src/panels/Editor/markdown-heading-id.ts` | Milkdown 标题 id 换成 GitHub slug |
| `src/panels/Editor/markdown-link-follow.ts` | 打开 + 定位 + 导航记录 |
| `src/panels/Editor/codemirror-markdown-links.ts` | 源码模式 Cmd/Ctrl+click 链接 |
| `src/panels/Editor/link-resolve.ts` | href → 文件 + 片段 |
| `src/panels/Editor/navigation-history.ts` | `recordNavigationOrigin`;Markdown 记录按源码行定位回去 |

## 规范

- `slug-and-fragment.spec.ts`:slug 规则、重复后缀、源码标题收集、片段解析、源码模式链接地址提取
- `heading-ids.spec.ts`:真实 Crepe 渲染出的标题 id = 源码解析出的 slug(中文 / 重复 / emoji / 标点 / 行内标记),改名后重算
- `follow-anchor-link.spec.ts`:同文档 / 跨文件 / 中文 / 重复 / 行号 / 找不到;源码与编辑 / 预览模式定位;后退回原位
- e2e `tests/e2e/markdown-anchor-links.spec.ts`:三种模式同文档锚点、跨文件锚点、中文 / 重复标题、后退回原位
