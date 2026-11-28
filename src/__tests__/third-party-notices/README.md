# third-party-notices(第三方声明:从 VSCode 移植 / 复制的代码与数据)

Continuo 有若干代码与数据直接移植 / 复制自 Visual Studio Code(microsoft/vscode,MIT)。MIT 要求随副本保留版权与许可声明,
`LICENSE-3RD-PARTY.md` 汇总这些声明,并经 electron-builder `extraResources` 打进安装包(`resources/licenses/`)。

## 行为(`vscode-notice.spec.ts`)

- `LICENSE-3RD-PARTY.md` 有「Visual Studio Code (microsoft/vscode) · MIT License」一节:© Microsoft Corporation、仓库地址、
  涉及的文件清单、MIT 全文(VSCode `LICENSE.txt`,「Copyright (c) 2015 - present Microsoft Corporation」)
- 清单里的每个文件都存在
- 源码文件头写了「Ported from microsoft/vscode」或「原样取自 VSCode」的文件都必须列在清单里(新增移植时不会漏登记)
- 打包配置把 `LICENSE-3RD-PARTY.md` 放进 `extraResources`

## 收录标准

只收录**确属移植 / 复制**的代码与数据(函数逐行移植、正则 / 数据表 / 色值照抄);注释里写「参考 / 对齐 VSCode」、只照其行为或设计
自行实现的不列(如受信域名匹配 `electron/shared/trusted-domains.ts`)。
