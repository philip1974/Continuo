# editor-markdown-writing-keys

行为契约:**Markdown 编辑模式(Milkdown)里的常用写作按键与主流编辑器一致**。

## 背景(第四十七轮审计 B7 / B9)

- 选中 "documentation" 粘贴 `https://example.com/docs` → 选中文字被替换成 `<https://example.com/docs>`(源码模式则正确生成
  `[documentation](url)`);⌘K 无反应(mac 上落到全局「清除终端」,活动面板不是终端时 no-op)。
- 表格最后一格按 Tab:Crepe 的缩进插件(size 4)接住表格导航没处理的 Tab,在格内插 4 个空格。

参照:VSCode `markdown.editor.pasteUrlAsFormattedLink`;Typora / Obsidian 的 ⌘K;VSCode / Typora / Notion 表格末格 Tab 新起一行。

## 行为

- 选中文字(同一段内、不在代码里)后粘贴的纯文本是单个 URL(`http(s)://` / `ftp://` / `file://` / `mailto:`,两端空白忽略、
  中间无空白)→ 给选区加链接,选中的文字保留,光标收到链接末尾,接着输入的文字不替换链接文字、也不并进链接(VSCode 粘贴成格式化链接
  后光标在插入内容末尾)。没有选区、不是单个 URL、选区在代码块 / 行内代码里、剪贴板带文件 → 照常粘贴。
- ⌘K(Windows / Linux:Ctrl+K)→ 打开 Crepe 链接编辑框:光标在链接文字内部或选区整个落在链接里 → 编辑该链接(框里是原地址,
  范围是整个链接);否则给选区加链接(没有选区 → 确认后插入地址本身作链接文字)。确认后光标在链接末尾,接着输入不并进链接
  (第四十八轮审计 A6:此前选区停在链接文字上,一打字就替换掉链接文字)。按键由编辑器处理(preventDefault),
  全局快捷键让行;焦点不在 Markdown 编辑区(如终端)时 ⌘K 仍是「清除终端」。
- 表格里 Tab → 下一格(选中格内文字);最后一格 → 表格末尾加一行(对齐方式随表头列)并进入其首格。⇧Tab → 上一格;首格 → 不动。
  表格外的 Tab 照旧(列表缩进等)。
- 回车拆段落在空白前(第五十二轮审计 A2:`… BETA tail` 在 `BETA` 后回车,新段保存成 `&#x20;tail`)→ 新段段首的空格 / 制表符去掉,
  编辑器显示与保存一致;与回车同一步撤销。段落、列表项、引用块都一样;CommonMark 段首空白只含空格 / 制表符,全角空格(U+3000)保留;
  代码块里不动;拆点在块首不算(新块是原来的整块)。空格后回车:前一段段尾空格照旧(Markdown 段尾空白本不显示)。
  拆点落在行内代码里(第五十三轮审计 4:`` Para `co de` x `` 在 `co` 后回车,原先保存成 `` `de` ``,改了代码)→ 不删:代码里的空格是内容,
  保存成 `` ` de` `` 重新打开仍是「 de」。强调 / 加粗 / 链接 / 删除线里的段首空格照删:实测序列化把它移到标记外、落在段首
  (` *ph* x`),重新打开即被 CommonMark 丢弃,不删则编辑器显示与保存不一致。
  参照:CommonMark「段落的原始内容去掉首尾空格 / 制表符」;Typora / Obsidian 拆段后新段不以空白开头。
- 只读预览里以上都不处理。

## Specs

| File | 覆盖 |
|---|---|
| `writing-keys.spec.tsx` | 真实 Crepe(jsdom):粘贴 URL 成链接(之后输入不替换 / 不并进链接)/ 照常粘贴的情形 / URL 识别 / 只读;⌘K 新建与编辑链接(确认后输入同上,无选区插入地址)、preventDefault、只读;表格 Tab / ⇧Tab / 末格加行 / 表格外 Tab;回车拆段去掉新段段首空白(段落 / 列表 / 引用 / 全角空格 / 代码块 / 撤销;行内代码里保留、强调 / 链接 / 删除线里照删);MilkdownEditor 接线 |
| `tests/e2e/markdown-writing.spec.ts` | 真实 Electron:选中粘贴 URL、⌘K 加链接(之后接着打字不替换链接文字)、表格末格 Tab |

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/milkdown-writing-keys.ts` | ProseMirror 插件(排在所有插件最前):handlePaste + Mod-k / Tab / Shift-Tab;appendTransaction 里拆段后去掉新段段首空白(`splitLeadingSpace`) |
| `src/panels/Editor/MilkdownEditor.tsx` | `crepe.editor.use(markdownWritingKeys)` |
