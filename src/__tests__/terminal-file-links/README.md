# terminal-file-links — 终端输出里的文件路径可 ⌘ + 单击打开并定位

对齐 VSCode `TerminalLocalLinkDetector` + `TerminalLinkResolver`(本地文件链接)。

## 行为契约

1. **识别**(`parseTerminalFileLinks`,纯函数):相对 / 绝对路径(`src/a.ts`、`./x`、`../x`、`/abs/x`、`~/x`、Windows
   `C:\x`)与行列后缀 `:line`、`:line:col`、`(line,col)`、`(line, col)`、`(line)`。裸文件名须带以字母开头的扩展名
   (`long.ts:300`),排除 `3.14` / `1999` 一类;冒号后的片段(`https://…` 的 `//…`、`foo:bar`)不算(URL 交给
   WebLinksAddon);无行号时去掉句末的 `.`。每行最多 10 个候选,逻辑行超过 2000 字符不扫描(同 VSCode)。
2. **解析与存在性**(main `terminal:resolve_links` → `resolveTerminalLinkPaths`):`~/` 按 home 展开;绝对路径原样;
   相对路径依次按**该终端当前 cwd**(OSC 7 跟踪,未上报时为 spawn cwd)、本窗口工作区根解析,取第一个存在的。
   **只有存在的普通文件**(`stat.isFile()`)才算链接 —— 目录 / FIFO / 设备 / 不存在 → 不显示链接(不误报,也不会把
   `/dev/zero`、命名管道交给编辑器读而阻塞)。会话只允许本窗口(同其它 terminal IPC),候选个数 ≤ 10、每个 ≤ `PATH_MAX`。
3. **范围(安全)**:与编辑器打开文件一致,不限工作区内(VSCode 同样打开任意本地文件);须用户修饰键单击才打开,
   打开 = 在编辑器标签里显示内容(与 Quick Open / 拖入文件同一路径 `coApp.editor.openFile`),不执行任何东西。
   悬停只触发 stat(本机,不外发)。
4. **交互**:xterm link provider —— 只在鼠标悬停到某行时才计算该行链接(不随输出扫描,长输出无额外开销);软换行的
   长路径按逻辑行识别,范围映射回单元格(宽字符占两格)。解析结果按 (cwd, 路径) 缓存 10s(VSCode 同),同一次悬停的候选
   合并成一次 IPC;IPC 失败不缓存、不显示链接。激活修饰键与 URL 链接一致(mac ⌘ + 单击、其它 Ctrl + 单击);悬停提示
   「⌘+单击打开文件」(三语)。打开后定位行列(`editor.openFile` 的 `line` / `column`,列超出行长落在行尾);打开失败按
   code 本地化提示(`openFileOrNotify`)。

## 规范文件

- `parse.spec.ts` — 1
- `resolve-main.spec.ts` — 2 / 3
- `provider.spec.ts` — 4(provider:范围、缓存、激活)
- `wiring.spec.ts` — 4(useTerminal 接线、修饰键、悬停提示、打开定位行列)
