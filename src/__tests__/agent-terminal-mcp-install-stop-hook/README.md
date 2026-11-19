# agent-terminal-mcp-install-stop-hook

行为契约:**agent terminal session spawn 前自动安装 stop hook**。
安装逻辑按 runner 写入 Claude Code / Codex 的本地配置,确保后续
`terminal.await_stop_hook` 可以从 hook events doneDir 读取 stop 事件。

本主题是 TDD 入口:先固定 merge / skip / parse guard / path drift / spawn
ordering 语义,后续 Op 再补 broker 与 tool wiring 实装。

## I1 cc merge

- 空 cwd。
- `install(agentLabel='claude' or 'cc')`。
- 写入 `.claude/settings.local.json`。
- hook command 含 `mkdir -p`。
- hook command 含 `cat >` 目标路径。
- hook command 含 `${CONTINUO_WINDOW_ID:-unknown}`。
- hook command 含 `${CLAUDE_CODE_SESSION_ID:-unknown}`。
- 文件名为 `cc_${CONTINUO_WINDOW_ID:-unknown}_${CONTINUO_TERMINAL_SESSION_ID:-unknown}_${CLAUDE_CODE_SESSION_ID:-unknown}_<ns>.jsonl`(会话绑定)。
- managed marker `_continuo_managed: true`。
- 返回 `{ installed: true }`。

## I2 codex merge with windowId

- 空 cwd。
- `install(agentLabel='codex')`。
- 写入 `.codex/config.toml`。
- TOML 含 `[[hooks.Stop]]` block。
- TOML 含 `# continuo-managed` marker。
- hook command 含 `codex_${CONTINUO_WINDOW_ID:-unknown}_${CONTINUO_TERMINAL_SESSION_ID:-unknown}_$(date +%s%N).jsonl`。
- 该断言覆盖 P0-4:Codex filename 必须带 windowId。

## I3a/I3b managed skip 与 Notification negative

- cwd 既有 `.claude/settings.local.json`。
- 文件含 `_continuo_managed: true`。
- 同一 managed Stop hook command 含 `CONTINUO_HOOK_EVENTS_DIR` 与 `CONTINUO_TERMINAL_SESSION_ID`。
- install 返回 `{ installed: false, reason: 'already-installed' }`。
- 不创建新的 backup 文件。
- cwd 既有 `.codex/config.toml`。
- `[[hooks.Notification]]` block command 含 `CONTINUO_HOOK_EVENTS_DIR`。
- `[[hooks.Stop]]` 不存在。
- install 必须继续安装 Stop hook。
- 该断言覆盖 P1-2:substring skip 必须严格限定 Stop hook。

## I3c TOML 多行字符串不识别 skip

- cwd 既有 `.codex/config.toml`。
- 文件含 `[[hooks.Stop]]` block。
- command 是 `command = '''mkdir -p ...'''` 多行字符串。
- install 返回 `{ installed: false, reason: 'unrecognized-existing-stop-hook' }`。
- 不冒进 append 新 Stop hook。
- 该断言记录 P1-3 limitation。

## I4 unknown runner skip

- `install(agentLabel='aider')`。
- 返回 `{ installed: false, reason: 'unknown-runner' }`。
- 不创建或修改任何 config 文件。

## I5 parse-fail skip

- cwd 既有 `.claude/settings.local.json`。
- 内容为 `{not-valid-json`。
- install 返回 `{ installed: false, reason: 'parse-error' }`。
- 不动原文件内容。

## I6 path drift replace 仅 marker entry

- cwd 含 managed entry。
- managed entry 引用旧 `hookEventsDir`,与当前入参不一致。
- install 创建 backup `.continuo-bak.<ts>`。
- install 只改写 `_continuo_managed` marker 紧跟的 entry。
- 不跨多个 `[[hooks.Stop]]` 误替用户自有 Stop hook。

## I8 旧版 managed hook 原地升级(会话绑定)

- 旧版 managed Stop hook 命令不含 `CONTINUO_TERMINAL_SESSION_ID`:其事件无会话 id,broker 不交给任何等待者。
- Claude:install 备份后只替换该 managed hook 的 `command`,不追加第二条,用户自有 Stop 原样保留。
- Codex:同 hookEventsDir 但 managed command 无会话 id → 与路径漂移同路径原地替换。
- 升级后再 install → `already-installed`(幂等)。

## I9 项目内符号链接 fail-closed(安全)

- agent 所在仓库可能不可信:可预置 `.codex/config.toml -> ~/.ssh/config`、
  `.claude/settings.local.json -> ~/.claude/settings.json`,或 `.claude` / `.codex` 目录本身是链接。
- 配置目录或配置文件任何一环是符号链接(或类型不对),或目录 realpath 后不在 cwd 内 →
  返回 `{ installed: false, reason: 'unsafe-config-path' }`。
- 拒绝时:链接目标不被修改,仓库内外都不产生 `.continuo-bak.<ts>` 备份副本(机密不进工作树)。
- 备份名已存在(含被预置成链接)→ 同样拒绝,不经链接写出备份。
- 写入用不跟随链接的 rename 原子替换,检查后被换成链接也不会写穿。
- 有意行为:用户把 `.claude` / `.codex` 软链到 dotfiles 仓库也会被拒(main 日志写明「拒绝符号链接的配置目录/文件」)。

## I11 检查之后被并发换成链接(TOCTOU,安全)

- 并发进程(如只能写工作区的沙箱 agent)可在 I9 检查之后把配置文件 / `.codex` 目录换成(或新建为)链接。
- 读取不跟随文件链接、只读普通文件(`O_NOFOLLOW`;不可用的平台退化为 lstat → open → fstat 同 inode),
  否则 `unsafe-config-path`,仓库外内容不经备份进工作树。
- mkdir 之后、写备份与 rename 之前复查:目录链 lstat + realpath 仍在 cwd 内,且配置文件仍是读到的那个
  inode(读时不存在则仍不存在),否则 `unsafe-config-path`,仓库外配置不变、不产生备份。
- 残余窗口:Node 无 `openat`/`renameat`,复查 → rename 之间目录分量仍按路径解析;复查把窗口收窄到这几个 syscall。
- cwd 本身经链接访问(如 macOS `/tmp`)不受影响,正常安装。
- inode 身份(dev/ino)全程以 bigint 取得与比对:NTFS 文件 ID 是 64 位、常超过 2^53,Number 丢精度会让不同文件比对相等。

## I12 配置文件是硬链接 fail-closed(安全)

- 硬链接在 lstat 下是普通文件、`O_NOFOLLOW` 也挡不住,可能就是仓库外的全局配置(`~/.codex/config.toml` 等);
  读出后会经 `.continuo-bak.<ts>` 备份写进工作区。
- 读取时配置文件 `nlink > 1` → `{ installed: false, reason: 'unsafe-config-path' }`,目标不变,仓库内外都无备份。
- 有意行为:用硬链接管理 dotfiles 的用户同样被拒(main 日志写明「拒绝符号链接或硬链接的配置目录/文件」)。

## I12 安装位置限定在调用方窗口 workspace 内(安全)

- 攻击:`create_session{cwd:"$HOME", agentLabel:"codex", install_stop_hook:true}` 改写全局 `~/.codex/config.toml`;
  cwd 不存在时 `mkdir -p` 建出任意目录树。
- 安装前 cwd 与会话同一解析(`resolveTerminalCwd`:须已存在且为目录;缺省回退窗口 workspace 根)。
- realpath 后须在调用方窗口 workspace 根之内(无 workspace 根 / 经链接逃出 → `cwd-outside-workspace`)。
- cwd 为用户 home 或其祖先 → `cwd-is-home-or-ancestor`(该处配置即全局配置;workspace 就是 home 也拒)。
- 「home 或其祖先」在字符串判定之外按 (dev, ino) 再判(I12b):同一目录有 realpath 不归一的别名(macOS
  `/System/Volumes/Data/<绝对路径>`、`/.nofollow/<绝对路径>`;Linux bind mount;Windows subst),workspace 是 home
  的祖先(`/`、`/Users`)时用别名写 cwd 即绕过字符串比较。cwd 自身 stat 失败 → 拒绝(fail-closed)。
- macOS 上 cwd 第一段为内核合成前缀(`.nofollow` / `.resolve` / `.vol`)→ 一律 `cwd-outside-workspace`。
- 配置目录只建 `.claude` / `.codex` 这一层,不递归建父链(cwd 不存在 → 拒绝,不建目录)。
- 拒绝时会话照建(会话允许在 workspace 外),`stop_hook_installed:false`。

## I10 hook 事件私有权限(多用户 Linux)

- hook 事件含会话内容(`last_assistant_message` 等)。
- 两种 runner 的 hook 命令以 `umask 077;` 开头:即便调用方 umask 为 022,`mkdir -p` 建出的
  hook-events 目录为 0700、`cat >` 写出的事件文件为 0600(真实 `/bin/sh` 执行验证)。
- main 启动时 `ensureHookEventsDir` 以 0700 建目录;已存在的(旧版 0755)也收紧为 0700。
- 收紧是尽力而为:文件系统不支持 chmod(抛 EPERM 等)时只告警,不让 MCP host 启动失败;mkdir 失败仍抛出。

## I13 hook 命令对 hookEventsDir 做 shell 转义(安全)

- `hookEventsDir` 来自 `app.getPath('userData')`(HOME / XDG_CONFIG_HOME / `--user-data-dir`),是唯一被宿主拼进
  hook 命令的字符串;命令持久写进工作区 `.claude/settings.local.json` / `.codex/config.toml`,每次 Stop 都执行。
- 旧形态 `mkdir -p "<dir>" && cat > "${CONTINUO_HOOK_EVENTS_DIR:-<dir>}/…"`:路径含 `$(…)` / 反引号 → 命令执行;
  含 `}` → `${VAR:-…}` 提前闭合;含 `"` → 引号闭合。
- 新形态:`umask 077; d="${CONTINUO_HOOK_EVENTS_DIR:-}"; [ -n "$d" ] || d='<单引号转义的路径>'; mkdir -p -- "$d" && cat > "$d/…"`。
  路径做 POSIX 单引号转义(`'` → `'\''`),不嵌进 `${VAR:-…}`;环境变量非空仍优先。文件名各段不变。
- 真实 `/bin/sh` 执行:目录名含空格、`$(touch X)`、反引号、`}`、`"`、`'`、`\`、中文 → 事件文件只落在该目录内,
  不产生任何标记文件;同目录再 install → `already-installed`。
- 已装的旧形态 managed 命令(即便已带会话 id)在下次 install 时原地升级,不追加第二条(Claude 保留用户自有 Stop)。
- Codex 的已装判定为「managed command 与当前要写的逐字节相同」,否则原地替换(路径漂移 / 无会话 id / 旧形态)。
  command 以 JSON 字符串转义写成 TOML basic string(转义集是 TOML 的子集)。

## I7 install spawn 前完成

- 覆盖 P0-3 / P2-3。
- mock spawn 若在 install 完成前调用则 spec fail。
- 调用顺序必须是:`cwd resolve` → `install` → `spawn`。
