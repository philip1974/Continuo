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

- fixture JSONL 文件名为 `cc_4_<cliSessionId>_<ns>.jsonl`。
- 文件写到 broker `doneDir` 后,`await_stop_hook` 返回 `status='stop'`。
- 输出字段从 payload 正确映射。
- 默认 `include_raw=false` 时 output 不含 `raw`。
- `include_raw=true` 时 output 含 `raw`。
- 命中文件被 `unlink`。
- buffer cap 为 500 时触发 FIFO drop。
- age 超过 10 分钟时触发 cleanup。
- Codex variant:
  - fixture JSONL 文件名为 `codex_4_<ns>.jsonl`。
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

- 同 `(windowId, runner, cwd)` 已有第一个 `await_stop_hook` pending。
- 第二个并发 `await_stop_hook` 抛 `AWAIT_STOP_HOOK_ALREADY_PENDING`。

## S7 cross-runner OK

- 同 cwd、同 windowId,但 runner 不同。
- `s1=cc` 与 `s2=codex` 两个 `await_stop_hook` 可并发等待。
- runner 是 ambiguity guard 的区分维度。
