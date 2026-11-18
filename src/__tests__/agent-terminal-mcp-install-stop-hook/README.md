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

## I10 hook 事件私有权限(多用户 Linux)

- hook 事件含会话内容(`last_assistant_message` 等)。
- 两种 runner 的 hook 命令以 `umask 077;` 开头:即便调用方 umask 为 022,`mkdir -p` 建出的
  hook-events 目录为 0700、`cat >` 写出的事件文件为 0600(真实 `/bin/sh` 执行验证)。
- main 启动时 `ensureHookEventsDir` 以 0700 建目录;已存在的(旧版 0755)也收紧为 0700。

## I7 install spawn 前完成

- 覆盖 P0-3 / P2-3。
- mock spawn 若在 install 完成前调用则 spec fail。
- 调用顺序必须是:`cwd resolve` → `install` → `spawn`。
