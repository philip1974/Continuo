# 文件名 Unicode 归一化(filename-unicode-normalization)

行为契约:**磁盘上以 NFD 编码保存的文件 / 文件夹名(如从 HFS+ 拷来、部分工具生成的 `회의록-NFD.md`、`café.md`),
与输入法键入的 NFC 查询照样匹配**。用户看不出两种编码的区别,不归一则一个字也搜不到。

对齐 VSCode:macOS 上 `pfs.readdir` 读出的名字一律 `normalizeNFC`(`src/vs/base/node/pfs.ts` handleDirectoryChildren),
文件搜索把 ripgrep 输出也 `normalizeNFC`(`services/search/node/fileSearch.ts`)。Continuo 只在**匹配与显示**处归一,
打开 / 读文件仍用磁盘原样的绝对路径(Linux 上 NFC 与 NFD 是两个不同的文件)。

## 入口

| 入口 | 归一位置 |
|---|---|
| Quick Open(⌘P) | `walk-files.ts`:`relPath` / `relPathLower` / `name` 转 NFC,`absPath` 保持原样 |
| 各过滤框查询(Quick Open / 命令面板 / 设置 / 快捷键 / 打开最近 / 主题 / 市场) | `normalizeSearchQuery` 末尾 `.normalize('NFC')`(粘贴来的 NFD 文本) |
| Quick Open 最近项 | `orderByRecent`:原样路径未命中时按 NFC 路径再查(tab 经 NFC 路径打开同一文件) |
| 打开最近的文件夹 | `openRecentItems` 的匹配源 `lower` 转 NFC |
| 资源管理器键入跳转 | `findTypeAheadIndex`:名字与键入前缀都 NFC |
| 在文件中查找(⇧⌘F) | `compileGlobList`:包含 / 排除模式与被测路径都 NFC;引擎结果 `relPath` 与已打开编辑器的 `searchRelPath` 都 NFC(覆盖键对齐),`path` 原样 |

## 关键行为

- 工作区里有 NFD 的 `회의록-NFD.md`,⌘P 输入 `회의록` → 命中,列表显示 NFC 名,回车打开磁盘上的原文件
- ⇧⌘F「包含的文件」填 `회의록*` 只搜该文件;「排除的文件」填 `회의록*` 排除它
- 资源管理器里键入 `café`(NFC)跳到磁盘上 NFD 的 `café.md`

规范:`filename-nfc-match.spec.ts`;e2e `e2e/quick-open-nfd-filename.spec.ts`。
