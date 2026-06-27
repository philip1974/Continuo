# Continuo 跨平台(Windows / Linux)适配审计

> 现状:Continuo 至今**只在 macOS(Apple Silicon)上运行和测试过**,从未在 Windows / Linux 跑过或打包过。
> 本文穷举出所有需要做 Windows/Linux 适配的代码点。
>
> **审计方法**:Claude 5 个子系统并行审计(electron 主进程核心 / services+ipc / 构建脚本 / renderer / `../ContinuoTerminal` 子仓)+ codex(gpt-5.5,独立全量 pass)交叉验证。两个独立审计者收敛。
> 日期:2026-06-23。涉及主仓 `Continuo` 与 file: 依赖子仓 `../ContinuoTerminal`。
>
> 严重度:**P0** = 目标平台上功能完全不可用/崩溃/无法打包;**P1** = 行为不一致/降级/部分失效;**P2** = 边角/体验/隐患。

---

## P0 — 阻断级(目标平台核心功能不可用 / 无法打包)

> **修复状态(2026-06-23,分支 `feat/cross-platform-p0`)**:以下 6 项 P0 全部已修并通过测试
> (Continuo 3300 tests + typecheck + lint 绿;ContinuoTerminal 336 tests + contract 45 + typecheck 绿)。
> 修复点见下方各条 ✅ 标注。P1/P2 留待后续。

### 构建与打包
- **`electron-builder.yml:19-49`** — win+linux — 只有 `mac` target,完全没有 win/linux 配置,无法产出 `.exe`/`.AppImage`/`.deb`。文件末尾仅注释「留空,以后再补」。
- **`package.json:30`** — win+linux — `build:app` 写死 `electron-builder --mac`,且用 POSIX 内联 env 前缀 `BUILD_TARGET=pack ...`(Windows cmd 不识别 `VAR=value cmd` 语法 → 落到 `out/` 而非 `electron-builder.yml` 期望的 `out-pack/`,打包内容缺失)。需拆 `build:app:{mac,win,linux}` + 引入 `cross-env`。
- **`build/` 缺 `icon.ico`** — win — 现有 `icon.icns`(mac)/`icon.png`/`icon.svg`,无 Windows 多尺寸 `.ico`,NSIS/portable 无品牌图标。

### 终端(核心功能)
- **`electron/main/services/terminal.service.ts:361`** — win — `args.length === 0 ? ['-l', '-i'] : args`:用户没传 args 时**无条件**加 zsh 的 `-l -i`。Windows 默认 shell `powershell.exe`/`cmd.exe` 不识别这两个 flag → **开终端直接失败**。这是 Continuo 主终端创建路径。应按 shell family 分支(仅 zsh/bash/fish 加 `-l -i`)。
- **`../ContinuoTerminal/packages/server-node/src/session-manager.ts:165`** — win — `input.shell ?? process.env.SHELL ?? '/bin/zsh'`:Windows 无 `$SHELL` 会 fallback 到字面量 `/bin/zsh` → node-pty spawn ENOENT 崩溃。**现成的 `getDefaultShell()`(已有 win32→powershell.exe 分支)从未被 SessionManager 调用** — 纯接线遗漏,一行可修。

### 路径(插件打开文件)
- **`src/panels/Editor/editor-path-utils.ts:5`** — win — `isAbsolutePath` 只判 `path.startsWith('/')`。Windows `C:\...` / UNC `\\server\...` 都不以 `/` 开头 → 被 `co-app.ts` 用作 `editor.openFile` 守卫时,插件打开任何真实绝对路径都返 `INVALID_PATH`。插件打开本地文件功能在 Windows 完全失效。

---

## P1 修复进度(codex 逐方向找 → 复查 → 修)

> 分支 `feat/cross-platform-p0`。每方向 codex 独立审计 → Claude 对照代码复查 → TDD 修复 → 双仓测试绿。

### 方向① 路径处理 — DONE(12 项全修)
link-resolve(盘符/UNC/normalize)、quick-open walk-files、Explorer FolderTree×2 / drop-handlers、scoped-app、fs.ipc watcher(`path.join`)、osc7-cwd(Windows drive)、terminal.store(大小写折叠)、initial-workspace(不 trim)。抽共享 helper `src/lib/path-cross.ts`(joinPath / stripRootPrefix / pathEquals,非 Windows 字节等价零回归)。

### 方向② shell/进程 — 3 修 + 4 DEFER(原 shell:true 修复经 codex diff 复查回退)
**修**:buildClaudeAddCommand(Windows `node "<path>"`,mac byte-exact 不变)、host-shell-policy(Linux 回退 `/bin/sh`)、integration(detectShell 去 `.exe` 识别 git-bash)。
**回退→DEFER**:shell.service / plugin-shell-stream 的 `shell:true`(原想让 Windows 跑 `.cmd/.bat`)经 codex 单条 diff 复查发现是**回归**——`shell:true` 把 args[] 重拼进 cmd.exe,破坏参数原子性 + 命令注入面,比原「.cmd 跑不了」更糟。已回退为 `shell:false`(无回归无注入);正确解法(PATHEXT 检测 + 仅 .cmd/.bat 走 `cmd.exe /d /s /c` + 每个 arg Windows quoting)需 Windows 实测 → DEFER。
**DEFER(带理由,需 Windows 实测 / 更大改动)**:
- `mcp-tools-hook-bridge.ts:516` Stop hook POSIX 命令 → 需 node-helper 重写(安全敏感写用户 Claude 配置 + Windows hook 执行不可测)。
- `terminal.store.ts:108` getShellFamily 平台猜测 → 需 main 在创建时 stamp 真实 shell family 进 snapshot(跨进程铺设;Windows 默认 powershell 猜测已正确,仅显式 cmd.exe 边角;quoting 不可测)。
- `host/transports/stdio-child.ts` 暴露 bin.mjs 路径 → host **库** API 契约改动(MCP_BIN_PATH→command+args),影响外部消费者非 Continuo 运行时,宜单独立项。

### 方向③ 协议 / 窗口·OS / UI / 打开外部 — DONE(11 项全修,均 P2)
- 协议/argv:抽 `electron/main/protocol-argv.ts` `extractProtocolUrl`(大小写无关 + `new URL()`),second-instance 与冷启动共用;second-instance 新增 argv 文件夹打开(Windows/Linux「用 Continuo 打开文件夹」)。`protocols` 提顶层**对 macOS plist + Linux .desktop 生效**;⚠ 经 codex diff 复查发现 **Windows NSIS target 不消费顶层 protocols**(electron-builder 26.8.1 只读 fileAssociations)→ Windows co:// 注册需 NSIS custom 脚本,已记 DEFER,yml 注释已更正避免误导。
- 窗口:`titleBarStyle` 平台分支(darwin→hiddenInset,其它→default;窗口控件 overlay 精修留 follow-up)。
- 硬编码 ⌘:KeybindingsTabContent / EditorWelcome 用 `formatHotkeyParts`;Quick Open placeholder 三语改 `{shortcut}` 插值,渲染时 `formatHotkey('mod+shift+p', detectPlatform())`。
- hotkey matcher:useQuickOpenHotkey / useCommandPaletteHotkey 非 mac 只认 Ctrl(mac 保持 meta||ctrl 零回归),避免 Super/Win 键误触发。

测试:Continuo 3326 / typecheck / lint 全绿。

### 方向④ 收敛性总扫(前三轮未覆盖类别)— 2 修 + 1 DEFER
codex 扫行尾/权限/大小写/env/原生模块/socket 等,捞到 3 个新项:
- **修** `package.json` — node-pty 从 devDependencies 移到 dependencies(原生运行时依赖,打包须包含)。
- **修** `scripts/continuo-mcp-stdio.mjs` — CLI proxy 的 XDG_CONFIG_HOME 仅在「非空且绝对」时采用(`??` 不拦空串;空/相对值算出错误 socket 路径与 main 不一致),否则回退 `~/.config`,与 Electron `app.getPath` 对齐。
- **DEFER** `electron/main/index.ts:741` — Linux 超长 userData 路径触发 Unix socket sun_path(~108 字节)限制 → 需 main(bind)与 CLI proxy(connect)协同加长度检查+回退短目录(如 XDG_RUNTIME_DIR);半改会让两端路径不一致,Linux 不可测,留单独立项。

测试:Continuo 3326 / typecheck / lint 全绿;node-pty 重建通过。

### 方向⑤ 最终收敛确认 — 2 项 DEFER(打包级 OS 集成)
codex 复扫只剩 2 个新项,均属**打包级文件夹关联**(需真实 win/linux 机器构建验证):
- **DEFER** `electron-builder.yml`(win)— 未注册 Directory「Open With」shell handler(资源管理器右键打开文件夹)。Windows 目录关联无 electron-builder 一等支持,需自定义 NSIS 注册表脚本,不可盲改。
- **DEFER** `electron-builder.yml`(linux)— .desktop 未声明 `MimeType=inode/directory`,文件管理器不把文件夹交给 Continuo。需 .desktop mimeTypes + Exec %F,且需 deb/AppImage 实测。
- 注:文件夹打开的**运行时 argv 处理已在方向③补全**(second-instance + 冷启动 pickArgvFolders);此处仅缺「OS 把目录路径送进来」的打包关联入口,属便利功能(CLI / 拖拽图标仍可用)。

> **收敛判定(代码级)**:方向①–④穷尽了可在 macOS 上修复+测试的代码级跨平台问题;方向⑤复扫只剩需真实 Windows/Linux 机器实现验证的打包/OS 集成项。**代码级修复已收敛**。

---

### 方向⑥ shellFamily 跨进程 stamp(原 DEFER 转真修)— DONE
main 创建终端时按真实 shell 路径算引号族(`shellFamilyForPath`,shell-args.ts)写入 session snapshot(shared 类型 + AddSessionInput + add + terminal.ipc),renderer 拖拽文件读真实 family,不再按 navigator.platform 盲猜(Windows cmd.exe 不再被当 PowerShell quoting)。新增单测;Continuo 3329 全绿。

### 方向⑦ 全新 codex 独立收敛确认 — 1 修 + 1 DEFER
新开 codex session(满 context,给完整已修+已 DEFER 排除清单),深度复核 4m54s,只捞到 2 个清单外新项:
- **修** `../ContinuoTerminal/scripts/leak-check.mjs` — `new URL().pathname` 在 Windows 盘符 → `/C:/...` 畸形,改 `fileURLToPath`(运行验证通过)。
- **DEFER** `electron/main/index.ts:739` — Windows dev/prod 共用固定 named pipe,二者并存时碰撞。需 main 按 dev/prod 重命名 pipe + proxy 连接重试(proxy 无法探测 named pipe)三方协同,Windows 不可测,dev-only 边角,半改风险破坏全 Windows MCP → 同 socket-length 族延后。

### 方向⑧ codex 逐条复查「本次未提交 diff」的正确性(一次一个,直到找不到)— 3 修
新协议:codex 一次只报一个 → 复查+修 → next。对本次跨平台 diff 自查,共抓出 **3 个 diff 引入的真问题**(全部已修)+ 1 文档漂移顺修 + 1 既有 follow-up(见 DEFER #12),最后 codex 输出「未发现问题」收敛:
- **修**(回归)`shell.service.ts` / `plugin-shell-stream.service.ts` 的 `shell:true` → 回退 `shell:false`(见方向②;破坏参数原子性 + 注入)。
- **修**(误判)`electron-builder.yml` Windows NSIS 不消费顶层 protocols → 改正注释 + DEFER。
- **修**(缺陷)`osc7-cwd.ts` 无条件 strip `/C:/` 破坏 POSIX 合法路径 → 平台门控 `windowsDrivePaths`。
- 顺修 `schemas.ts` `/bin/zsh→/bin/sh` 文档漂移。
- 既有 follow-up:OSC7 snippet host(见 DEFER #12)。

测试:Continuo 3327 + ContinuoTerminal 339 + 双 typecheck + lint 全绿。**codex 末轮「未发现问题」→ diff 自查收敛。**

---

## 待办:需真实 Windows/Linux 机器(DEFER 汇总)

以下项已识别但需目标平台构建+实测,不宜在 macOS 盲改:
1. `mcp-tools-hook-bridge.ts:516` — Stop hook 改 node-helper(跨平台 hook 命令)。
2. `terminal.store.ts:108` getShellFamily — main 在创建时 stamp 真实 shell family 进 snapshot。
3. `host/transports/stdio-child.ts` — 暴露 `{command,args}` 替代裸 bin.mjs 路径(host 库 API)。
4. `electron/main/index.ts:741` — Linux Unix socket 路径长度限制 + 回退短目录(main+proxy 协同)。
5. `electron-builder.yml`(win)— NSIS 注册 Directory「Open With」shell handler。
6. `electron-builder.yml`(linux)— .desktop `inode/directory` MIME 关联。
7. `titleBarStyle` win/linux 窗口控件 overlay 精修(当前已降级为原生标题栏)。
8. node-pty Windows/Linux 无预编译时 `electron-rebuild` 需 build-essential/VS Build Tools(文档化)。
9. `electron/main/index.ts:739` — Windows dev/prod named pipe 命名隔离(main 重命名 + proxy 连接重试)。
10. `shell.service.ts` / `plugin-shell-stream.service.ts` — Windows `.cmd/.bat` 启动:PATHEXT 检测 + 仅 .cmd/.bat 走 `cmd.exe /d /s /c` + 每个 arg Windows quoting(共享 launcher;**不可用裸 shell:true,会破坏参数原子性 + 注入**)。
11. `electron-builder.yml` — Windows `co://` 协议注册:NSIS target 不消费顶层 `protocols`(electron-builder 26.8.1 只读 fileAssociations),需 NSIS custom include 脚本在 install 写 `HKCU\Software\Classes\co` / uninstall 清除(或改 AppX)。
12. **(既有,非本次 diff 引入)** `ContinuoTerminal integration.ts` BASH/FISH OSC7 snippet 发 `file://$HOSTNAME/...`,而 `parseOsc7Cwd` 默认只收空 host/localhost → HOSTNAME 非空时 cwd 跟踪被丢(影响所有 bash/fish,非仅 git-bash)。修法:snippet 改发 `file://localhost$PWD` 或空 host `file://$PWD`,或 consumer 传 acceptedHosts;需 real-PTY 测试(当前 skip)验证 + 更新 byte-pinned snippet 测试。codex 在 diff 复查中由 #7(启用 git-bash 集成)顺带发现。

---

## P1 — 行为不一致 / 降级 / 部分失效(原始审计清单,方向①②已覆盖大部分)

### 协议注册
- **`electron-builder.yml:29-32`** — win+linux — `protocols:`(`co://` scheme)被埋在 `mac:` 块内。打 win/linux 包时不会写注册表 / `.desktop` 的 `MimeType=x-scheme-handler/co` → 外部 `co://` 链接系统找不到 handler。应提到顶层(顶层 protocols 对三平台统一生效)或在新增 win/linux 块各自声明。运行时 `setAsDefaultProtocolClient('co')`(`index.ts`)仍跑,但缺安装器声明在 win/linux 不稳。
- **`electron/main/index.ts` second-instance/冷启动 argv 协议解析** — win — 用 `startsWith('co://')` 前缀匹配 argv 元素;含空格/复杂 query 的 `co://` URL 被 shell 拆成多个 argv → query 截断。应 join 后正则提取完整 URL。

### Shell / 进程
- **`electron/main/services/shell.service.ts:53`** — win — 插件 `app.shell.exec` 用 `spawn(input.cmd, args)` 无 `shell:true`。Windows CreateProcess 不解析 `.cmd`/`.bat`(`npm`/`pnpm`/`yarn` 等 Node 工具链均为 `.cmd`)→ 插件 exec 这些命令失败。需 Windows 下 `shell:true` 或 `cmd.exe /d /s /c` 包装。
- **`electron/main/services/plugin-shell-stream.service.ts:82`** — win — 流式 shell API 同款 `spawn(cmd, args)` 问题。应与 `shell.service` 共用跨平台 launcher。
- **`electron/main/services/mcp-tools-hook-bridge.ts:516-519`** — win — 写入 agent 的 Stop hook 命令是纯 POSIX:`mkdir -p` / `cat >` / `${VAR:-default}` / `$(date +%s%N)`。Windows 下 agent 的 shell(cmd/powershell)执行 hook 失败 → hook 事件文件不生成,`terminal.await_stop_hook` 在 Windows 失效。需按平台写命令或改调 Node helper。
- **`electron/main/services/mcp-stdio-config.service.ts:36`** — win — 生成 `claude mcp add ... -- ${cliPath}` 直接用 `.mjs` 路径,无 `node` 前缀也未 quote。Windows 不能直接执行 `.mjs`,含空格路径被拆词。应生成 `node "<script>"`。(README:75 同源问题。)

### 终端默认 shell(子仓 Linux)
- **`../ContinuoTerminal/packages/server-node/src/shell-env/host-shell-policy.ts:50`** — linux — `$SHELL` 缺失/不在 allowlist 时硬回退 `/bin/zsh`,多数 Linux 无 zsh → 终端创建失败。应回退 `/bin/sh` 或读 `/etc/passwd`。
- **`../ContinuoTerminal/packages/server-node/src/shell-env/host-shell-policy.ts:9-25`** — win+linux — allowlist 过窄:Unix 仅 `/bin`、`/usr/bin`、`/usr/local/bin`、`/opt/homebrew/bin`(NixOS/Snap/Flatpak/容器合法 shell 被拒);Windows `SHELL_NAMES` 缺 git-bash 的 `bash.exe`/`sh.exe`(Windows 开发者常用)。应改可执行检测 + 允许用户配置。

### 路径处理(renderer)
- **`src/panels/Editor/link-resolve.ts:20`** — win — `ANY_SCHEME` 把 `C:\x.md` 的盘符识别成 scheme `c:` → Windows 绝对路径 Markdown 链接被拒。应在 scheme 判断前识别 drive/UNC。
- **`src/panels/Editor/link-resolve.ts:29-42`** — win — 相对链接 `normalize()` 纯 POSIX(`split('/')` + `${dir}/${pathPart}`),Windows 反斜杠路径 `..` 无法回弹 → 解析错。应用 `path.win32` 语义或 drive-aware normalize。
- **`src/plugins/quick-open/walk-files.ts:87,92`** — win — Quick Open 相对路径前缀剥离写死 `${rootPath}/`,Windows `C:\repo\x` 不匹配 `C:\repo/` → 列表显示全路径 + fuzzy 匹配源退化为绝对路径。
- **`electron/main/ipc/fs.ipc.ts:173-177`** — win — recursive watcher 回调把 filename 归一为 `/` 后用 `${rootPath}/${subdir}` 拼回,但 Windows tree item id 多为 `\` → 深层变更广播路径不匹配,Explorer/外部同步刷新失效。应 `path.join`。

### 文件监听(Linux)
- **`electron/main/ipc/fs.ipc.ts:160`** — linux — `RECURSIVE_SUPPORTED = darwin || win32`,Linux fallback 非递归(`fs.watch` 不支持 recursive)→ 深层子目录文件变化不自动刷新(已有意识降级)。如需补齐用 chokidar/@parcel/watcher 或递归注册子目录。

### 终端 OSC7 / 传输(子仓)
- **`../ContinuoTerminal/packages/react-terminal/src/osc7-cwd.ts:31`** — win — OSC 7 cwd 解析只取 URL pathname,`file:///C:/Users/me` → `/C:/Users/me`(错)。终端 cwd 跟踪 / split 继承 cwd 出错。需 Windows 下转 `C:\...` + 处理 UNC host。
- **`../ContinuoTerminal/packages/server-node/src/transports/local-socket.ts:128-131`** — win — Windows 直接 `throw 'not supported'`,**无 named pipe 实现**(此前误以为已有)。standalone local-socket transport 在 Windows 完全不可用(注:Continuo 自身经 in-process host adapter,不一定走此 transport;但该 package 的独立用法受影响)。需实现 `\\.\pipe\` named pipe 或在 host 层强制 Windows 用 HTTP transport。

### 键盘快捷键显示
- **`src/plugins/settings/KeybindingsTabContent.tsx:147-149`** — win+linux — 顶部摘要写死 `⌘⇧P`(下方逐命令列表已正确按平台用 `formatHotkeyParts`)。win/linux 看到 mac 符号,与列表不一致。应用 `formatHotkeyParts('mod+shift+p', PLATFORM)`。

### 终端 autorun 延时(子仓文档漂移)
- **`../ContinuoTerminal/packages/server-node/src/session-manager.ts:218`** — win — autorun 延时硬编码 200ms,但 `protocol/src/schemas.ts:106` 文档承诺 Windows 600ms,无平台分支。Windows ConPTY 启动慢,200ms 内 shell 未就绪 → autorun 命令被吞。

### dev 脚本
- **`scripts/relaunch.sh` + `package.json:31`** — win+linux — relaunch 全 mac-only:`bash`/`osascript`/`pgrep`/`pkill`/`open` + 硬编码 `dist-electron/mac-arm64/Continuo.app`。`pnpm relaunch` 在 win/linux 失败。属 dev 便利脚本,可降级标注 macOS-only 或用 Node 跨平台重写(按 `process.platform` 选产物路径)。

---

## P2 — 边角 / 体验 / 隐患

- **`electron/main/index.ts` `titleBarStyle: 'hiddenInset'`** — win+linux — 无平台分支。`hiddenInset` 主要是 macOS 语义,win/linux 自定义 chrome 可能显示不一致。
- **`src/panels/Editor/EditorWelcome.tsx:35`** — win+linux — 欢迎页提示写死 `⌘ S`(功能正常,`metaKey||ctrlKey` 两平台可用;仅文案误导)。
- **`src/panels/Explorer/FolderTree.tsx:79,313`** — win — rename/move 目标路径 `${destDir}/${candidate}` + Copy Relative Path 剥离写死 `/`(混合分隔符;fs API 容忍故非崩溃,UI 一致性问题)。
- **`src/panels/Explorer/drop-handlers.ts:100`** — win — 外部文件 drop 目标 `${targetDir}/${file.name}` 写死 `/`(Node fs 接受,UI 状态混合分隔符)。
- **`src/plugins/scoped-app.ts:85`** — win — 插件 `listDir` 返回路径写死 `${parent}/${entry.name}`。
- **`src/plugins/permissions/usePluginFsScopeRequests.ts:17-24`** — win — `~` 展开生成混合分隔符(仅作用域路径显示)。
- **`electron/main/services/pty-lang.ts:14-15`** — win — 注入 `LANG`/`LC_ALL=*.UTF-8` 在 Windows 无意义(powershell/cmd 用代码页;无害,但 CJK 修复在 Windows 不生效)。
- **`electron/main/services/plugins.service.ts:492` / `plugin-fs.service.ts:58`** — win — `spawn('git', ...)`:Windows 上 `git.exe` 由 CreateProcess 补 `.exe` 通常可用,但仅有 `git.cmd` shim / PATH 异常时失败。
- **`../ContinuoTerminal/packages/server-node/src/shell-env/integration.ts:37`** — win — shell integration 仅识别 zsh/bash/fish(已安全降级 null);Windows 无 OSC 7 cwd 跟踪 / prompt hook(特性缺失,非崩溃)。
- **`../ContinuoTerminal/packages/server-node/src/session-manager.ts:305`** — win — kill 的 SIGTERM→grace→SIGKILL 软杀语义在 Windows ConPTY 退化为直接强杀(行为不一致,不崩)。
- **`../ContinuoTerminal/packages/react-terminal/src/search-keymap.ts:3`** — both — 用已废弃 `navigator.platform` 判 Mac(对 win/linux 实际无害,API 脆弱)。
- **`node-pty` 原生模块** — linux — 无 Linux 预编译二进制,Linux `pnpm install` 触发 `electron-rebuild` 需 `build-essential`/`python3`;Windows 需 VS Build Tools。属平台依赖,需文档明示否则首次 install 即崩。
- **`README.md:75`** — win — `claude mcp add -- /path/to/continuo-mcp-stdio.mjs` 在 Windows 需 `node` 前缀(同 `mcp-stdio-config.service.ts` 源)。

---

## 已正确做平台分支(不报,供确认)

- `scripts/continuo-mcp-stdio.mjs:30-69` — appSupport/socket 路径 darwin/win32/linux 三分支完整;win32 named pipe `\\.\pipe\continuo-mcp` 与 `index.ts` 常量逐字一致;existsSync 对 win named pipe 已跳过。
- `electron/main/services/mcp-stdio-server.service.ts:300-353` — Unix socket 的 mkdir/unlink/chmod 已 `if (!isWin)` 门控,named pipe 不做文件系统副作用。
- `electron/main/services/path-resolve.helper.ts` — `expandHome` 处理 `USERPROFILE` vs `HOME` + `~/` + `~\`;`validateLeaf` 覆盖 Windows 保留名/NTFS 8.3/ADS/尾点尾空格;用 `path.sep`。**模范实现**。
- `electron/main/index.ts` 菜单 — accelerator 用 `CmdOrCtrl`,mac-only role(about/services/hide)在 `isMac` 块内,`setDockMenu` 有 `darwin||!app.dock` 守卫,`window-all-closed` 有 darwin 分支。
- `src/plugins/command-palette/useCommandHotkeys.ts` — 中央 `detectPlatform` + `compileCombo` 精确区分 meta/ctrl;各 hotkey 用 `metaKey || ctrlKey` 两平台可用。
- renderer 路径**比较**(`editor.store.ts`/`path-utils.ts`/`tree-config.ts`/`clipboard-store.ts`)均同时吃 `/` 与 `\`;拖拽用 `getPathForFile`(webUtils)取真实路径 + `quotePaths(paths, shellFamily)` 按 shell family 引用。
- `electron/main/ipc/fs.ipc.ts:160` recursive watch 已对 darwin/win32 native + Linux fallback 有意识分支(Linux 降级见 P1)。
- `../ContinuoTerminal/packages/shell-quote` — cmd/powershell/posix 三族 family-aware 引号实现完整(family 由调用方按平台传入)。
- `terminal` 字体 fallback 链以 `monospace` 收尾;WebGL + Unicode11 已接(CJK 宽度此前已修)。

---

## 建议修复顺序

1. **能打出包**(P0 构建):`electron-builder.yml` 补 win/linux target + protocols 提顶层 + 生成 `icon.ico`;`package.json` 拆 `build:app:*` + `cross-env`。
2. **终端能开**(P0 终端):`terminal.service.ts:361` 按 shell family 给 args;`session-manager.ts:165` 接 `getDefaultShell()`。
3. **核心交互**(P0/P1 路径+shell):`editor-path-utils.isAbsolutePath`、`link-resolve`、`walk-files`、`fs.ipc` watcher 统一一个跨平台 path normalize/join helper;`shell.service`/`plugin-shell-stream` Windows `.cmd/.bat` launcher;`mcp-tools-hook-bridge` 平台化 hook 命令。
4. **协议与深链**(P1):`co://` 注册 + argv 解析。
5. **打磨**(P2):硬编码 `⌘` 文案、`titleBarStyle` 分支、renderer 路径构造统一、文档化 native 编译依赖。

---

## 逐项修复日志(第十四 session 续,codex 协作,/goal 一次一个)

> 规则:本仓 macOS-only tested,**只修能在 macOS/POSIX 单测验证或属纯逻辑错误的项**;需 Windows/Linux 真机实测才能验证的项(含命令注入敏感面)维持 DEFER。

- **X1 DEFER(不修)**:`shell.service.ts:58` / `plugin-shell-stream.service.ts:84` Windows `.cmd/.bat` 不能直接 spawn。该处已有详细注释 + 先前 codex diff 复查的明确 DEFER:正确解(PATHEXT 检测 + `cmd.exe /d /s /c` + Windows argv quoting)是**命令注入敏感面**且**需 Windows 实测**;盲发未验证 quoting 比 bug 更危险;当前 param-array 原子性 + Windows 干净 spawn error 是有意的更安全态。维持 DEFER。
- **X2 修**:`src/panels/Explorer/path-utils.ts:14` `dirname('C:\foo')` 返回 drive-relative `C:` 而非盘根 `C:\`。Windows workspace 为盘根时,直接子项父目录算错 → `tree-config.ts:72` cache miss `listDir('C:')`、`mutate-actions.ts` rename/delete 后 `invalidateChildrenIds('C:')` 读错目录/UI 不刷新。POSIX `/a → /` 已处理,Windows 盘根缺同等逻辑(同 path-scope `isWithinScope`/`closeTabsOutsideRoot` 路径前缀族)。→ dirname 检测父段 `^[A-Za-z]:$` 返回 `${drive}\`。纯函数,+TDD(`dirname('C:\foo')==='C:\'` / 大小写盘符 / 尾分隔符 / `C:\`→`''`)。
- **X3 修**:`src/stores/editor.store.ts` `getStateAfterClosingTabsOutsideRoot` 路径包含判定大小写敏感。Windows FS 大小写不敏感,`root='c:\repo'` 与 tab `C:\Repo\a.md`(drive letter/目录大小写常因来源不同而异)是同一 workspace,但大小写敏感 `startsWith` 判 root 外 → 切/恢复 root 时误关 clean tab → 持久化丢编辑会话。→ 抽 `isPathWithinRoot(root, filePath)`:Windows 形态(盘符/UNC)case-fold 比较,POSIX 保持大小写敏感;合并 X2 的分隔符结尾处理。纯函数,+TDD(`c:\repo` 含 `C:\Repo\a.md` 保留 / POSIX `/repo` 不含 `/Repo/a.md` 关闭)。
- **X4 修(含同族兄弟)**:`editor.store.ts` `getStateAfterRemovingPath`(删除匹配)+ `getStateAfterRenamingPath`(rename 匹配)对 Windows 路径大小写敏感。`removedPath='C:\Repo\dir'` 与 tab `c:\repo\dir\a.md` 同目录树但大小写敏感 startsWith 不匹配 → 删除不关 clean tab(用户基于旧路径保存复活文件)/ rename 不跟改(tab 指向失效旧路径)。→ 删除复用 `isSameOrInsidePath`(X3 的 helper 由 `isPathWithinRoot` 改名通用化);rename 保留原 slice 语义加 case-fold(后缀大小写按原 filePath,长度不变)。POSIX 全保持大小写敏感。+TDD(remove:`C:\Repo\dir` 关 `c:\repo\dir\a.md`、POSIX `/repo/Dir`≠`/repo/dir` 不关;rename:`C:\Repo\dir`→新名 改 `c:\repo\dir\a.md`、POSIX 大小写敏感不改)。**路径包含族(close/remove/rename × 分隔符+大小写)在 editor.store 已全收口**。
- **X5 修(单一来源收口)**:`FolderTree.tsx` `isWithinRoot` + editor.store 三处路径包含判定 → 统一到 `src/lib/path-cross.ts` 新增 `isSameOrInsidePath(base, filePath)`。FolderTree 展开路径 root 归属此前手写 case-sensitive startsWith → Windows 上 expandedPaths(`C:\Repo\src`)与 root(`c:\repo`)仅大小写不同被判 out-of-root → 树恢复展开错乱/旧展开项滞留。`isSameOrInsidePath` 用与 `pathEquals` 一致的**运行时**大小写策略(isWindowsRuntime;mac/Linux 严格=零行为变化,Windows 不敏感),并处理尾分隔符/文件系统根。editor.store 的 close/remove/rename 三处改为 import 复用(删本地 isWindowsStylePath/isSameOrInsidePath,从 path-shape 切到与模块一致的 runtime 策略)。+TDD:path-cross.spec 加 isSameOrInsidePath(精确/子/兄弟前缀/尾分隔符/POSIX 大小写敏感/Win32 mock 不敏感+盘根);editor-store.spec 的 Windows 用例改 mock navigator.platform='Win32'(与 pathEquals 测试同 pattern),POSIX 用例显式 MacIntel 防平台泄漏。**跨平台路径包含族(editor close/remove/rename + Explorer 展开 × 分隔符+大小写)全部收口到 path-cross 单一来源**。
- **X6 修**:`path-cross.ts` `stripRootPrefix` 裸 `startsWith(root)` 剥前缀 → 两缺陷:(a)**路径边界**:`/root` 错剥同前缀 `/rooted/a` 成 `ed/a`(POSIX 也存在);(b)**Windows 大小写敏感**:`c:\repo` 剥 `C:\Repo\src\a.ts` 失配 → Copy Relative Path 出绝对路径。→ 改用 `isSameOrInsidePath` 做归属判定(边界 + 运行时大小写),确认在 root 内后按原 root.length 切片(大小写折叠不改长度)。+TDD(同前缀非子目录原样返回 / Win32 mock 大小写折叠仍剥相对)。**path-cross 三 helper(joinPath/stripRootPrefix/isSameOrInsidePath+pathEquals)跨平台正确性全收口**。
- **X7 修**:`clipboard-store.ts` `prune` 手写大小写敏感前缀(`p===r || startsWith(r+sep)`)→ Windows 上剪贴板源与删除/改名旧路径仅大小写不同时不剪除 → 保留失效源 → Paste 报不存在/同路径新建文件误灰显待粘贴。→ 复用 `isSameOrInsidePath(r, p)`(运行时大小写,语义同 editor.store remove/rename)。+TDD(Win32 mock:`c:\WS\Dir` 剪除 `C:\ws\dir\a.ts`)。**至此路径包含/前缀族在 editor(close/remove/rename)、Explorer(FolderTree 展开 / clipboard prune)、path-cross(stripRootPrefix)全部收口到 path-cross.isSameOrInsidePath 单一来源。**
- **X8 修**:`link-resolve.ts` `normalize` UNC 根处理错误。UNC `\\server\share` 是不可越过的卷根(host+share),但旧实现 root 仅取 `\\`、把 server/share 当可弹 segs → Markdown 相对链接 `..\..\a.md` 从 `\\server\share\dir\cur.md` 越过 share 错解析成 `\\server\a.md`(应停在 `\\server\share\a.md`)。drive/POSIX 的 root 已正确不可弹,UNC 漏。→ UNC 分支用 `/^(\\\\[^\\/]+[\\/]+[^\\/]+)(?:[\\/]+|$)/` 把 `\\server\share\` 纳入 root,`..` 不弹根。+TDD(UNC `..\..` 停在 share 根 / 同层相对正确解析 / 原 UNC 绝对路径用例仍绿)。
- **X9 修**:`tree-config.ts` `canDrop` 自身/子树防护用大小写敏感 `===`/`startsWith(srcId+sep)` → Windows 源/目标仅大小写不同时误判可 drop → 放行 move-into-self/descendant → 底层 move 报错/UI 错乱。→ 复用 `isSameOrInsidePath(srcId, destDir)`。+TDD(Win32 mock:`C:\work\dir` drop 到 `c:\WORK\Dir\sub` 被拦)。**路径包含/前缀族至此覆盖 editor(close/remove/rename)+Explorer(FolderTree 展开 / clipboard prune / tree-config canDrop)+path-cross(stripRootPrefix)+link-resolve(UNC 根),全部走单一来源或等价 root-不可弹语义。**
- **X10 修(P1 数据丢失)**:`editor-file-actions.ts` `openFileByPath` 用 `t.id === path` 判文件已打开,未走平台感知 `pathEquals` → Windows 上同一文件以 `C:\Repo\a.md`/`c:\repo\a.md` 不同大小写打开会开**两个 editor tab** → 分别编辑保存同一文件 → 后保存者覆盖前者**丢改**。→ 用 `pathEquals(t.filePath ?? t.id, path)` 查已开 tab,`switchTab(existing.id)`(已开 tab 真实大小写 id)。POSIX 大小写敏感不变(pathEquals 非 Windows 即 `===`)。+TDD(Win32 mock:不同大小写不开新 tab 只切已开 + 不重读;POSIX:不同大小写视为不同文件开新 tab)。这是路径**相等**族(pathEquals),与包含族(isSameOrInsidePath)互补,两个 helper 均在 path-cross 单一来源。
- **X11 修(P1 数据丢失,含修有问题的 dirname 副本)**:`useExternalFileSync.ts` 用本地 `dirname(tab.filePath) !== changedDir` 字节级比较判外部变更归属。本地 dirname 是 Explorer path-utils dirname 的**有问题副本**:对 `C:\a.md` 返回 `C:`(应盘根 `C:\`,同 X2)、对 POSIX 根 `/a.md` 返回 ''(应 `/`,连 mac 根 workspace 也漏 sync);加字节级比较 → Windows 盘根/大小写不同目录 clean tab 收不到外部 reload → 旧内容覆盖磁盘新内容。→ 删本地副本,复用已修正的共享 `@/panels/Explorer/path-utils` dirname + 平台感知 `pathEquals` 比较(watcher 广播路径规范化属另议平台 DEFER,本修不依赖其精确格式)。+TDD(Win32:大小写不同目录仍匹配重读 / 盘根文件匹配 `C:\` 重读)。
- **X12 修(第三份 dirname 副本)**:`ContextMenu.tsx` `createParent()` 又有一份手写 dirname(inline slice)→ 文件系统根下直接子文件父目录算错(`/a.md`→'',`C:\a.md`→`C:`)→ 根 workspace 右键「新建文件/文件夹」传错 parentDir(相对 cwd / drive-current-dir 下创建或失败)。→ 复用 `./path-utils` 的 dirname(`dirname(target.path) || rootPath`,裸文件名兜底 rootPath)。逻辑由 path-utils.spec 的 dirname 测试(X2:`/a.md`→`/`、`C:\foo`→`C:\`)覆盖。**dirname 副本累计 3 份**(path-utils=canonical / useExternalFileSync X11 / ContextMenu X12)—— 「有问题的路径 helper 副本」是本族隐藏复发源,修 canonical 必 grep 所有副本。
- **X13 修**:`walk-files.ts`(Quick Open)手写 `e.path.startsWith(rootPath) ? slice+replace : e.path` 剥 root 前缀,未复用 `stripRootPrefix` → 仍大小写敏感 + 无边界 → Windows rootPath/FileEntry.path 大小写不同 / canonical 形式时 relPath 退化绝对路径 → Quick Open 路径显示 + 相对片段搜索失真。→ 复用 `path-cross.stripRootPrefix`(X6:边界 + 平台感知大小写)。+TDD(Win32 大小写不同仍剥相对 / 同前缀非子目录 `/root` 不错剥 `/rooted/a`)。
- **X14 修**:`co-app.ts` `editor.openFile(path,{line})` 后续用 `state.tabs.find(t => t.id === path)` + `waitForViewRef(path)` 查 tab,漏走 pathEquals(X10 的 SDK 兄弟入口)→ Windows 上插件传的 path 与既有 tab id 仅大小写不同时,openFileByPath(X10)已切到既有 tab 但此处找不到 activeTab / viewRef 用错 key → 插件传 line 时**行号跳转失败**。→ `pathEquals(t.filePath ?? t.id, path)` 找 tab + 用 `activeTab.id` 查 viewRef。+TDD(Win32:不同大小写 path → waitForViewRef 用真实 tab id 并跳行)。**pathEquals 相等族覆盖 openFileByPath(X10)+ co-app line-jump(X14)两入口。**
- **X15 修(pathEquals 相等族,持久化恢复入口)**:`src/lib/persist/explorer-persist.ts:261` `hydrateEditorTabs` 的迟到-恢复守卫用 `useWorkspaceStore.getState().root !== expectedRoot` 字节级比较。`expectedRoot`/`currentRoot` 均经 `normalizeWorkspaceRoot`(可为 null)。Windows 文件系统大小写不敏感,恢复异步窗口期(`await Promise.allSettled(readFile)`)内若同一文件夹以不同大小写被(重新)设为 root(recent/CLI/drag 传入不同 case),字节比较误判「已切到别 workspace」→ 整轮跳过 editor tab 恢复 → 后续持久化把该窗 `openFilePaths` 写空(丢整个编辑会话)。→ 改用平台感知相等:`expectedRoot === null ? currentRoot !== null : currentRoot === null || !pathEquals(currentRoot, expectedRoot)`。POSIX 仍大小写敏感(零行为变化)。+TDD(Win32:同路径不同大小写仍恢复 / POSIX:仅大小写不同视为不同 root 仍丢弃)。**pathEquals 相等族覆盖 openFileByPath(X10)+ co-app line-jump(X14)+ hydrateEditorTabs root 守卫(X15)三入口,全走 path-cross 单一来源。**

---

## 收敛结论(第十四 session,2026-06-23,codex 协作 /goal「一次一个直到找不到」)

codex(gpt-5.5 high,只读)第 16 轮经完整 grep 复审 explorer-persist / workspace.store / pinned.store / window-restore.service / window-workspace-roots.service 全部持久化/快照/recentRoots/pinned/window-restore 入口后,输出「未发现问题」+ `###CODEX-DONE###`。跨平台路径方向收敛。

**累计:X2–X15 共 14 项修复 + X1 DEFER**(本仓 macOS-only tested,需 Windows/Linux 真机实测的命令注入敏感面如 `.cmd/.bat` spawn 维持 DEFER)。

**最高价值族 = 跨平台路径处理,统一收口到 `src/lib/path-cross.ts` 两个单一来源 helper**:
- **包含族 `isSameOrInsidePath(base, filePath)`**(运行时 isWindowsRuntime 大小写策略 + 尾分隔符/文件系统根边界):editor.store close/remove/rename(X3/X4)+ Explorer FolderTree 展开(X5)/ clipboard prune(X7)/ tree-config canDrop(X9)+ stripRootPrefix(X6)。
- **相等族 `pathEquals(a, b)`**:openFileByPath(X10,P1 防同文件不同大小写开两 tab 互相覆盖丢改)+ co-app line-jump(X14)+ hydrateEditorTabs root 守卫(X15)。
- **canonical `dirname`**(`src/panels/Explorer/path-utils.ts`,Windows 盘根 `C:\foo`→`C:\` + POSIX `/a`→`/`):X2;并清掉 2 份有问题的 inline 副本(useExternalFileSync X11 / ContextMenu X12)。
- **UNC 卷根不可弹**:link-resolve normalize(X8)。

**沉淀**:(1)「有问题的路径 helper 副本」(dirname 共 3 份)是本族隐藏复发源 —— 修 canonical 必 grep 全仓所有副本一并收口;(2)运行时大小写检测(navigator.platform)优于路径形态检测 —— 与 pathEquals 一致,mac/Linux 严格 === 零行为变化,仅真 Windows 上分叉;(3)相等族(pathEquals)与包含族(isSameOrInsidePath)互补,凡用 `=== path`/`startsWith(root+sep)` 字节比较文件系统路径的去重/查找/守卫入口都须改用对应 helper;(4)Windows 用例在 macOS 用 `Object.defineProperty(navigator,'platform','Win32')` mock 验证,POSIX 用例显式 mock MacIntel 防平台泄漏到后续测试。
