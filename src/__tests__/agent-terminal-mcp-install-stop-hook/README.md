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
- managed marker `_continuo_managed: true`。
- 返回 `{ installed: true }`。

## I2 codex merge with windowId

- 空 cwd。
- `install(agentLabel='codex')`。
- 写入 `.codex/config.toml`。
- TOML 含 `[[hooks.Stop]]` block。
- TOML 含 `# continuo-managed` marker。
- hook command 含 `codex_${CONTINUO_WINDOW_ID:-unknown}_$(date +%s%N).jsonl`。
- 该断言覆盖 P0-4:Codex filename 必须带 windowId。

## I3a/I3b managed skip 与 Notification negative

- cwd 既有 `.claude/settings.local.json`。
- 文件含 `_continuo_managed: true`。
- 同一 managed Stop hook command 含 `CONTINUO_HOOK_EVENTS_DIR`。
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

## I7 install spawn 前完成

- 覆盖 P0-3 / P2-3。
- mock spawn 若在 install 完成前调用则 spec fail。
- 调用顺序必须是:`cwd resolve` → `install` → `spawn`。
