# agent-terminal-mcp-await-stop-hook

行为契约:**`terminal.await_stop_hook` MCP tool** 等待 agent CLI stop hook
落盘事件,把 Claude Code / Codex 的 JSONL hook payload 映射为 MCP 输出。

本主题是 TDD 入口:先用 BDD 固定协议、过滤条件、并发保护与清理语义,
后续 Op 再补协议 schema、broker 与 tool 实装。

## S1 schema

- `tools/list` 暴露 `terminal.await_stop_hook`。
- `inputSchema`:
  - `session_id`: string, `min(1)`
  - `timeout_sec`: integer, `max(600)`, default `60`
  - `include_raw`: boolean, default `false`
- `outputSchema`:
  - `status`: `'stop' | 'timeout'`
  - `cli_session_id`: string 或 `null`
  - `elapsed_ms`: number
  - `raw`: nullable；仅 `include_raw=true` 时返回

## S2 hit cc + S2b hit codex

- fixture JSONL 文件名为 `cc_4_<terminalSessionId>_<cliSessionId>_<ns>.jsonl`
  (`terminalSessionId` = PTY 注入的 `CONTINUO_TERMINAL_SESSION_ID`,见 S8)。
- 文件写到 broker `doneDir` 后,`await_stop_hook` 返回 `status='stop'`。
- 输出字段从 payload 正确映射。
- 默认 `include_raw=false` 时 output 不含 `raw`。
- `include_raw=true` 时 output 含 `raw`。
- 命中文件被 `unlink`。
- buffer 条数超过上限(默认 500,可注入)时 FIFO drop:最旧的一条被淘汰且其文件被删除,其余按序投递。
- age 超过 10 分钟时触发 cleanup。
- Codex variant:
  - fixture JSONL 文件名为 `codex_4_<terminalSessionId>_<ns>.jsonl`。
  - Codex filename 不含 `cliSessionId`。
  - `cli_session_id` 从 JSON payload 的 `session_id` 解析。

## S3 timeout

- 无 fixture 时,`timeout_sec=2`。
- 返回 `status='timeout'`。
- `elapsed_ms` 约为 2000。
- 不抛异常。

## S4 session-not-found

- 未注册 `session_id`。
- 抛 `TERMINAL_SESSION_NOT_FOUND`。

## S5 multi-window isolation (filter only)

- windowId=4 的 terminal session 正在等待。
- prefix windowId=5 的 done 文件不能解锁 windowId=4 的 waiter。

## S6 ambiguity guard (P0-1)

- 同一终端会话(同 `(windowId, runner, session)`)已有第一个 `await_stop_hook` pending。
- 第二个并发 `await_stop_hook` 抛 `AWAIT_STOP_HOOK_ALREADY_PENDING`。
- 不同会话即使同 cwd 也可并发等待(见 S8)。

## S7 cross-runner OK

- 同 cwd、同 windowId,但 runner 不同。
- `s1=cc` 与 `s2=codex` 两个 `await_stop_hook` 可并发等待。
- runner 是 ambiguity guard 的区分维度。

## S8 会话绑定(防事件串会话的正确性约束)

- 每个 PTY 注入 `CONTINUO_TERMINAL_SESSION_ID=<会话 id>`(内部值,调用方 env 不能覆盖);managed
  Stop hook 把它写进事件文件名第二段。
- broker 只把事件交给**该会话**的等待者:同窗口、同 runner、同 cwd 的他会话等待者拿不到(否则会拿走
  本会话的事件、使本会话等待者超时),也不会占位让本会话 `ALREADY_PENDING`。实时命中与缓冲命中两条
  路径都成立(S8 / S8a)。
- 缺会话 id 的事件(旧版 hook 文件名、`unknown`、非 Continuo 会话)不当通配(S8b)。
- **不是安全边界**:同用户进程可直接读 hook-events 目录与 transcript,也能伪造带任意会话 id 的事件
  文件。本约束只保证合法并发会话之间不串事件;跨 OS 用户的隔离靠 hook-events 目录 0700 / 事件文件 0600。
- 端到端:真实安装的 hook 命令在带该变量的环境中执行,写出的事件只交给对应会话(S8c)。
