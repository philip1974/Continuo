# editor-unicode-highlight(不可见 / 双向控制字符与同形字)

对齐 VSCode `editor.renderControlCharacters`(默认开;`viewLineRenderer` 的 isControlCharacter:C0、DEL、U+202A–202E、
U+2066–2069、U+200E/200F、U+061C)与 `editor.unicodeHighlight.*`(`invisibleCharacters` / `ambiguousCharacters` 默认开,
Markdown 与纯文本的语言默认值关;数据 `src/vs/base/common/strings.ts` InvisibleCharacters / AmbiguousCharacters,规则
`src/vs/editor/common/services/unicodeTextModelHighlighter.ts`)。打开不可信项目时防 Trojan Source(`‮` 让显示顺序与真实内容不符)、
零宽字符、西里尔字母冒充 ASCII。实现:`src/panels/Editor/codemirror-unicode-highlight.ts`(经 `codemirror-basic-setup` 用于代码编辑器、
Markdown 源码模式、冲突比较)。

## 行为(`editor-unicode-highlight.spec.ts`)

- 不可见 / 控制字符显示为占位符(悬停给出码位),代码与 Markdown 源码都生效:CodeMirror 默认集合之外补上 U+202A–202C、U+2068
  (VSCode 视为控制字符)与 VSCode InvisibleCharacters 的大部分(U+034F、U+115F/1160、U+17B4/17B5、U+180B–180E、U+1CBB/1CBC、
  U+2000–200A、U+202F、U+205F、U+2060–206F、U+2800、U+3164、U+FFA0、U+FFF0–FFF8、U+133FC、U+1D173–1D17A、U+E0000–E007F)
- 同形字(易与 ASCII 混淆的非 ASCII 字符)加框(`--md-warning`,强制颜色下 CanvasText),悬停「字符 U+0430 "а" 可能会与 ASCII 字符
  U+0061 "a" 混淆…」;集合 = VSCode `_common` + 界面语言对应集合(英文 `_default` / 中文 `zh-hans` / 韩文 `ko`)
- 词规则(VSCode CodePointHighlighter):所在词里没有 ASCII、又有明显非 ASCII 字符(中文、整段西里尔文)→ 不标
- Markdown / 纯文本不标同形字(VSCode `[markdown]` / `[plaintext]` 默认值);只装饰可视范围

## 与 VSCode 的差异

- 刻意不当作不可见字符替换:ZWNJ / ZWJ(U+200C / 200D)、变体选择符(U+FE00–FE0F、U+E0100–E01EF)、U+00A0、U+3000 ——
  VSCode 画框不改字形,CodeMirror 的占位会替换字符本身,会打散 emoji 组合、破坏中日文排版
- 不可见字符在 Markdown 源码里同样显示(VSCode 的 Markdown 默认关):只改显示,换来不可信 Markdown 里的零宽字符可见
- 注释里同样标同形字(相当于 VSCode 未信任工作区的 `includeComments`);没有 `allowedCharacters` / `allowedLocales` 设置
