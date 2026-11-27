# editor-markdown-autolink-edit

行为契约:**Markdown 编辑模式里编辑自动链接的文字,地址跟随文字;保存结果绝不出现文字与地址分家的链接**。

## 背景(第五十轮审计 A2)

段落 `Para with https://example.com bare.`,编辑模式光标放在 URL 末尾输入 `/p`,保存 → `Para with [https://example.com/p](https://example.com) bare.`,
点击跳原地址。链接 mark 是 inclusive 的(接着链接打字并进链接),但只改了文字、地址仍是旧的;序列化只在文字 = 地址时写裸形式,
于是写成文字与地址不一致的 `[文字](地址)`。

参照:Typora / Obsidian 实时预览 —— 裸链接的地址就是它的文字,改文字即改链接;GFM 自动链接规则(micromark-extension-gfm-autolink-literal)。

## 行为

只针对**编辑前文字 = 地址**的链接(原文是裸链接 `https://…` / `www.…`(地址 `http://www.…`)/ 邮箱(地址 `mailto:…`),或 `<url>` 自动链接),
且只看这次编辑碰到的(改了它的文字,或紧挨着它前面改动):

- 编辑后文字仍是合法链接 → 地址 = 新文字(www. 补 `http://`,邮箱补 `mailto:`);保存成裸链接(原文是 `<url>` 的保持 `<url>`)。
  URL 末尾 / 中间插字、删字都一样。
- 裸链接形状(http(s):// / www. / 邮箱)按 GFM 重新认定:
  - 遇空白截止(末尾打空格再打字:只有空格前的一段是链接);GFM 不算进链接的结尾(句末标点 `?!.,:*_~'";`、不配对的 `)`、像实体的 `&x;`)
    不带链接(末尾打 `.` → 句号是普通文字)
  - 开头不再合法(删掉协议、段首在链接前打字并进了链接)→ 去掉链接,剩普通文字
  - 链接前紧挨着打了字母 / 删掉了前面的空格,使前一个字符不再满足 GFM 要求(`xhttps://…`)→ 去掉链接(保存成 `xhttps://…` 普通文字,
    不写出 `x<https://…>`)。原文本来就是 `x<https://…>` 的不按此判定
- 其它协议的 `<url>`(如 `<ftp://…>`)按 CommonMark 自动链接:取到空白为止,仍是 `协议:…` 形状 → 地址 = 文字,否则去掉链接。
- 文字 ≠ 地址的链接(`[docs](https://example.com)`、`[https://a.com](https://b.com)`)改文字 → 地址不动。
- 一次撤销:文字与地址一起回到原样。
- 输入法组字期间不改(组字中改 mark 会打断输入法)。
- 就地改原文(只差打的那几个字,`milkdown-source-blocks`)与整块重写两条序列化路径结果都正确;整块重写时普通文字里的 `://` 按 remark
  转义(`xhttps\://…`),解析回来同样是文字。

## Specs

| File | 覆盖 |
|---|---|
| `autolink-edit.spec.tsx` | 真实 Crepe(jsdom),就地改原文 / 整块重写各一遍:末尾 / 中间插字、删字、链接前打字(句中 / 段首)、末尾空格 / 句号、删协议、`<url>` / www. / 邮箱 / `<ftp://>`、`[文字](地址)` 不动、撤销 |
| `src/__tests__/editor-milkdown-roundtrip-verbatim/roundtrip-verbatim.spec.tsx` | 模糊测试(含裸链接)装上同一插件,编辑后输出解析回来与文档相同 |
| `tests/e2e/markdown-writing.spec.ts` | 真实 Electron:裸链接末尾打字保存后为裸链接、地址跟随 |

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/milkdown-autolink-follow.ts` | `followEditedAutolinks`:appendTransaction 里按编辑后的文字重新认定自动链接 |
| `src/panels/Editor/milkdown-writing-keys.ts` | 写作按键插件的 appendTransaction 调用它 |
