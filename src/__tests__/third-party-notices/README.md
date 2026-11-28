# third-party-notices(第三方声明:从 VSCode 移植 / 复制的代码与数据)

Continuo 有若干代码与数据直接移植 / 复制自 Visual Studio Code(microsoft/vscode,MIT)。MIT 要求随副本保留版权与许可声明,
`LICENSE-3RD-PARTY.md` 汇总这些声明,并经 electron-builder `extraResources` 打进安装包(`resources/licenses/`)。

## 行为(`vscode-notice.spec.ts`)

- `LICENSE-3RD-PARTY.md` 有「Visual Studio Code (microsoft/vscode) · MIT License」一节:© Microsoft Corporation、仓库地址、
  涉及的文件清单、MIT 全文(VSCode `LICENSE.txt`,「Copyright (c) 2015 - present Microsoft Corporation」)
- 清单里的每个文件都存在
- 源码文件头写了「Ported from microsoft/vscode」或「原样取自 VSCode」的文件都必须列在清单里(新增移植时不会漏登记)
- 通用规则:源码注释(文件头,或文件中段某一段上方的段注释;`//` 与块注释,含 CSS)写了「Ported from <owner>/<repo>」→ 必须列在
  标题带「(<owner>/<repo>)」的那一节里(旧写法「原样取自 VSCode」= microsoft/vscode);字符串里的同样文字不算
- 高对比度色板:`src/styles/design-tokens.css` 的 `.hc-black` / `.hc-light`(colorRegistry hcDark / hcLight 默认)与 `src/styles/theme.css`
  的 HC 值(hc_black.json / hc_light.json 语法色、gitDecoration / debug 的 hcDark / hcLight 默认)已登记
- 「CodeMirror (codemirror/search) · MIT License」一节:`src/panels/Editor/codemirror-find.ts` 里照抄的 `announceMatch`、替换文本
  处理(`unquote` + 正则 `getReplacement`)与移植自 `prevMatchInRange` 的 `lastMatchIn`(上游均未导出),版权「Marijn Haverbeke and others」与 MIT 全文
- 打包配置把 `LICENSE-3RD-PARTY.md` 放进 `extraResources`

## 收录标准

只收录**确属移植 / 复制**的代码与数据(函数逐行移植、正则 / 数据表 / 色值照抄);注释里写「参考 / 对齐 VSCode」、只照其行为或设计
自行实现的不列(如受信域名匹配 `electron/shared/trusted-domains.ts`)。
