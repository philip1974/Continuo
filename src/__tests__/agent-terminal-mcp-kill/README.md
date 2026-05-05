# agent-terminal-mcp-kill (Agent Terminal MCP Phase 4)

行为契约:**`terminal.kill` MCP tool**:agent 给 PTY 发信号(SIGINT/SIGTERM/SIGKILL)。
**不删 metadata + 不删 buffer** — onExit 自动 setExited,tab 显示 closed;
buffer 留着让 agent 仍可 read_output 看退出前的输出。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §5.5

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/mcp-terminal-schemas.ts` | killInput / killOutput zod |
| `electron/main/services/mcp-tools-terminal.ts` | `makeKillTool` 工厂 |
| `electron/main/services/terminal.service.ts` | +`forceKill(id)` 直接 SIGKILL |

## 输入 / 输出

```ts
input: {
  session_id: string,
  signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL',  // 默认 SIGTERM
}
output: {}
```

## 关键行为

### Schema

- `killInputSchema`:
  - `{session_id}` → ok(signal 缺省)
  - 全字段(三种 signal)→ ok
  - 其它 signal('SIGHUP'/任意 string)→ fail
  - 缺 session_id → fail
  - 未知字段 → fail(strict)
- `killOutputSchema`:
  - `{}` → ok
  - 含字段 → fail(strict)

### `makeKillTool(deps)` 行为

deps:
```ts
{
  has: (id) => boolean;
  interrupt: (id) => void;     // 包 termService.interrupt(写 \x03)
  kill: (id) => void;          // 包 termService.kill(SIGINT + 3s grace + force)
  forceKill: (id) => void;     // 包 termService.forceKill(直接 SIGKILL)
}
```

- `tool.name === 'terminal.kill'`
- `tool.inputSchema === killInputSchema`
- `tool.run({session_id, signal?})`:
  1. `has(session_id) === false` → 抛 `TERMINAL_SESSION_NOT_FOUND`
  2. signal 缺省 / `'SIGTERM'` → 调 `kill(id)`
  3. signal `'SIGINT'` → 调 `interrupt(id)`
  4. signal `'SIGKILL'` → 调 `forceKill(id)`
  5. 返回 `{}`
- 不调 ensureAuthorized(与 send_input/read_output 同型,不弹窗)

### `forceKill(id)` 行为(在 terminal.service)

- 不存在 id → no-op
- 存在 id → `inst.pty.kill('SIGKILL')`
- 清 inst.killTimer(如果同时调过 kill)避免重复
- onExit 由 PTY 自然触发 → 走 setExited + cleanup 现有流程
- 抛错(罕见,PTY 已死)→ console.warn,不传播

## 不在本主题验证

- 真 PTY 收到信号后退出 — 留 E2E
- onExit 链路 setExited / cleanup — 在 `terminal-service`
- agent 端再 read_output 看退出前内容 — 留 E2E
