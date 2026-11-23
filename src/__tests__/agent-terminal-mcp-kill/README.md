# agent-terminal-mcp-kill (Agent Terminal MCP Phase 4)

行为契约:**`terminal.kill` MCP tool**:agent 给 PTY 发信号(SIGINT/SIGTERM/SIGKILL)。
**不删 metadata** — kill 时同步本地清理(setExited(-1)),tab 显示 closed;不依赖 PTY 的 onExit。
输出 buffer 随 PTY 退出释放:需要退出前的输出须先 read_output。

> 配套:`doc/17-agent-terminal-mcp.md`(维护者本地文档,未公开) §5.5

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
  interrupt: (id) => Promise<boolean>; // 包 termService.interrupt(写 \x03);false = 未送达
  kill: (id) => void;          // 包 termService.kill(SIGINT + 3s grace + force)
  forceKill: (id) => void;     // 包 termService.forceKill(直接 SIGKILL)
}
```

- `tool.name === 'terminal.kill'`
- `tool.inputSchema` 是 Continuo 本地收窄后的 schema(基于协议 `killInputSchema`,见 E202/E203/E205/E220),不是协议原 schema
- `tool.run({session_id, signal?})`:
  1. `has(session_id) === false` → 抛 `TERMINAL_SESSION_NOT_FOUND`
  2. signal 缺省 / `'SIGTERM'` → 调 `kill(id)`
  3. signal `'SIGINT'` → 调 `interrupt(id)` 并等待结果;返回 `false`(Ctrl-C 未送达:检查后 PTY 退出 / 写被拒)
     → 抛 `TERMINAL_SESSION_NOT_FOUND`(与 send_input 写失败同码),不回报成功
  4. signal `'SIGKILL'` → 调 `forceKill(id)`
  5. 返回 `{}`
- 工厂本身不调 ensureAuthorized(授权(S2)与 capability(S3)门控由 mcp-terminal-host 统一包装,见 `mcp-tool-gates/`)

### `forceKill(id)` 行为(在 terminal.service)

- 不存在 id → no-op
- 存在 id → `inst.pty.kill('SIGKILL')`
- 清 inst.killTimer(如果同时调过 kill)避免重复
- 先同步 `cleanupSessionLocal(id, -1)` 再 `sm.kill`(sm.kill 会卸掉 exit 监听,等不到自然 onExit,退出码记 -1)
- 抛错(罕见,PTY 已死)→ console.warn,不传播

## 不在本主题验证

- 真 PTY 收到信号后退出 — 留 E2E
- onExit 链路 setExited / cleanup — 在 `terminal-service`
- agent 端再 read_output 看退出前内容 — 留 E2E
