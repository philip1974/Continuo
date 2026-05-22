# migration-step2-buffer-merge (Step 2 of 7-step terminal migration)

覆盖 Continuo 删 terminal-buffer.service.ts 后的关键路径:
- replay-completeness: renderer attach byte-for-byte + 跨 chunk ANSI + truncated `\x1b[0m` prefix
- buffer-lifecycle: forceKill live session + window close graceful kill 后 buffer 释放
- exited-session-replay: pty natural exit 后 wrapper SESSION_NOT_FOUND -> empty (renderer) / TERMINAL_SESSION_NOT_FOUND throw (MCP) - NEED-INFO-1=b 决策
- ansi-strip-regression: server-node stripAnsi 与 baseline 行为一致 (P1-1, 用真 SessionManager 不 mock)
- no-dangling-import: terminal-buffer.service 引用全清 + BUFFER_SESSION_NOT_FOUND 全清

关联 commits: ContinuoTerminal fe0b529 (server-node getBufferSnapshot), Continuo <Op26 hash>.
关联 ADR: ContinuoTerminal docs/decisions/0001-cross-repo-pty-handover-manual-override.md.
