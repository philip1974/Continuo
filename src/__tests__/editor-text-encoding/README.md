# editor-text-encoding

行为契约:**编辑器能打开、编辑、保存非 UTF-8 文本文件,且保存永不破坏原文件**;状态栏显示编码与行尾并可更改。
对照 VSCode `workbench/services/textfile/common/encoding.ts`(BOM 检测、0 字节启发式、SUPPORTED_ENCODINGS)、
`textFileEditorModel.setEncoding`、`browser/parts/editor/editorStatus.ts`(状态栏编码 / 行尾项、ChangeEncodingAction、ChangeEOLAction)。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/text-encoding.ts` | 编码 id / 显示名 / 顺序(VSCode SUPPORTED_ENCODINGS 常用子集)、`encodingHasBom` |
| `electron/main/lib/text-codec.ts` | `decodeTextFile`(BOM → 0 字节启发式 → 严格 UTF-8;指定编码时可逆校验)、`encodeTextFile`(含 BOM;无损校验) |
| `electron/main/ipc/fs/read-file.ts`、`fs.ipc.ts` | `fs:read-file` 收 / 回 `encoding`;`fs:write-file` 按 `encoding` 编码后走同一原地写 |
| `src/stores/editor.store.ts` | tab `encoding` / `encodingPinned`;`createTab` / `reloadFromDisk` / `setEncoding` |
| `src/panels/Editor/editor-file-actions.ts` | 打开 / 保存 / 还原 / 保存前比对按编码;`reopenWithEncoding`;`saveFile({ encoding })` |
| `src/panels/Editor/editor-encoding.ts` | 读盘选项、行尾判定与转换 |
| `src/plugins/editor-encoding/` | 编码 / 行尾选择器与命令 `workbench.action.editor.changeEncoding` / `changeEOL` |
| `src/shell/StatusBar.tsx` | 状态栏编码 / 行尾项(点击打开选择器) |

## 关键行为

### 读取(`fs:read-file`)
- 有 BOM:`EF BB BF` → `utf8bom`,`FF FE` → `utf16le`,`FE FF` → `utf16be`;文本不含 BOM。
- 无 BOM:前 512 字节的 0 字节全在奇 / 偶数位 → 无 BOM 的 UTF-16 LE / BE;其它位置有 0 字节 → 二进制,
  `FS_NOT_UTF8`(提示不变)。
- 否则必须是合法 UTF-8(`utf8`)。像文本但不是 UTF-8(GBK / Shift JIS / Latin-1 …)→ `FS_UNKNOWN_ENCODING`
  (不像改动前那样直接拒绝:资源管理器 / ⌘P / 拖入 / 编辑器内链接打开时改为弹编码选择器,选定后按该编码打开)。
  `files.autoGuessEncoding`(VSCode 默认关)不实现:不猜编码。
- 指定编码(通过编码重新打开):按该编码解码;指定 UTF-8 而文件带 UTF-8 BOM → `utf8bom`(VSCode 同)。
  **解码须可逆**:再编码回去与原字节逐字节相同,否则 `FS_DECODE_FAILED`(不打开 —— VSCode 会带替换字符打开,保存即写坏)。

### 保存(`fs:write-file`)
- 按 tab 的磁盘编码写回;`utf16le` / `utf16be` / `utf8bom` 总带 BOM(VSCode 强制),其它不带。BOM 文件、GBK 文件保存后
  除编辑处外字节不变。
- 文本含该编码表示不了的字符(如以 GBK 保存 emoji)→ `FS_UNENCODABLE`,**不写**,原文件不变,提示(VSCode / iconv 会
  静默写成 `?`)。
- 编码后的字节仍受 64 MiB 写入上限约束;写入走原地写路径(硬链接 / 扩展属性 / 权限不变)。

### 编辑器
- tab 记住磁盘编码;用户「通过编码重新打开 / 保存」选定的编码记为 `encodingPinned`(VSCode preferredEncoding):之后外部
  同步、还原、保存前比对、冲突比较的读盘都按它解码;未选定 → 每次自动识别。会话内记住(含 ⇧⌘T 重新打开),不跨重启。
- 更改文件编码:第一步「通过编码重新打开 / 通过编码保存」,第二步选编码(重新打开不列 UTF-8 with BOM)。
  - 重新打开:脏 tab 先确认「放弃更改并重新打开」;同编码且不脏 → 无操作。
  - 保存:成功后 tab 改为该编码;失败 tab 编码不变。
- 更改行尾序列:LF / CRLF,整篇换行统一改写,tab 变脏,保存写回。
- 状态栏:活动文本 tab 显示编码(UTF-8 / UTF-8 with BOM / UTF-16 LE / GBK …)与行尾(LF / CRLF),点击分别打开对应选择器;
  图片 tab 不显示。

## 与 VSCode 的差异
- 解码不可逆 / 编码有损一律拒绝(VSCode 允许并可能写坏文件)。
- 打开非 UTF-8 文件:VSCode 按 `files.encoding`(utf8)带替换字符打开;这里弹编码选择器。
- 编码选定不跨重启持久化(VSCode 随编辑器输入序列化)。
- 在文件中搜索仍只搜 UTF-8 文件(VSCode 按 files.encoding 搜;ripgrep 还认 BOM)。

## 范围外
- 插件 `editor.openFile` 打开的 tab 仍只支持 UTF-8(主进程校验读取保持原契约)。
