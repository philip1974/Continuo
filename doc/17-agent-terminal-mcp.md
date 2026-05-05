# Agent Terminal MCP 计划书

> 让 Claude Code / Codex / Gemini CLI 这类「外部 agent」在 Continuo 内置终端里跑;
> 同时通过 MCP tool 让其中一个 agent 主动**新建另一个终端 session 并启动另一个 agent CLI**,
> 实现 agent 编排 agent。

配套:
- [doc/05-Electron-集成.md](./05-Electron-集成.md) — IPC 桥
- [doc/10-插件系统方案.md](./10-插件系统方案.md) — 后续把 MCP host 内核化为 plugin 的预留
- 参考实现:`/Users/RiGang/Desktop/MindAutonAgent-Electron`(PTY 流控 / env 注入策略借鉴,但其 terminal **未**注册为 MCP tool,见下)

## 1. 一句话定位

**Terminal 既是 runtime(给 agent CLI 跑用)也是 tool(让 agent 调用建/控 session)**。
不重写 PTY 层,在现有 M-Terminal 基础上加一层 MCP server + 5 个 tool + 一次性授权,完事。

## 2. 现状盘点

| 层 | 现状 | 计划 17 改动 |
|---|---|---|
| PTY 服务 | `electron/main/services/terminal.service.ts` 已实现:节流/截断/overflow/3s grace kill | 复用,不动 |
| IPC | 6 通道(create/write/resize/interrupt/kill/destroy + data/exit/overflow event) | 复用,不动 |
| xterm 渲染 | `src/panels/Terminal/{TerminalPanel,View,Tabs,useTerminal}.tsx` | session 模型加 `originHint` / `agentLabel` 字段;tab 上加标记 |
| Session store | `src/stores/terminal.store.ts` | 加 `originHint: 'user' \| 'agent'`、可选 `agentLabel` |
| Shell 服务 | `electron/main/services/shell.service.ts`(给 plugin 的一次性 `app.shell.exec`) | 不复用,本计划走 PTY 长 session |
| MCP host | **无** | **新建** `electron/main/services/mcp-host.service.ts` |
| MCP tool 注册 | **无** | **新建** `electron/main/services/mcp-tools-terminal.ts` |
| 授权 UI | **无** | 新建 `src/shell/AgentAuthPrompt.tsx` |

## 3. 总体架构

```
                ┌──────────────────────────────────────────┐
[main process]  │  PTY service (node-pty + 多 session)     │
                │   ↑ IPC ────→ renderer xterm.js          │
                │   ↑ MCP tools ──→ HTTP SSE server         │
                └──────────────────────────────────────────┘
                                       ↑
                       env 注入: CONTINUO_MCP_URL / CONTINUO_MCP_TOKEN
                                       ↑
                      [Terminal 1 / origin=user]   claude code  ──┐
                      [Terminal 2 / origin=agent]  codex          ──┴─ 都反连同一个 MCP host
                                                                   ↑
                                       claude code 通过 terminal.create_session
                                       (autorun: 'codex') 拉起 Terminal 2
```

**关键不变量**:
- 一个 PTY = 一个 session_id = UI 上一个 tab。无后台不可见 session。
- MCP host 只在 main process 跑,绑 127.0.0.1 + 随机端口 + Bearer token,Renderer 不直连。
- Token 只通过 env 注入子进程(PTY 的 `env` 参数),不写盘、不打印日志。

## 4. MCP host 协议

### 4.1 选型

- **HTTP + Server-Sent Events**(参考 Mind 项目方案,与 MCP 官方推荐一致)
- 监听 `127.0.0.1:<random-port>`,**只听本机**
- `/sse`:agent 建立长连接,接收 server → client 推送
- `/message`:agent 发 JSON-RPC 请求,server 回 ack(实际响应走 SSE)
- 鉴权:每个请求 `Authorization: Bearer <token>`,token = UUID,启动时生成、退出时作废

### 4.2 启动时机

`app.whenReady()` 后立即启动 host(不延后到第一次开 terminal),保证用户手动启动 claude code 时 env 已注入。

### 4.3 不做的事

- 不暴露给外部 IDE / 远端 agent。Continuo 自己的 terminal 之外不应能访问。
- 不持久化 token。重启 → 新 token,旧 PTY 进程的 token 立刻无效。

## 5. Tool 集合(5 个,最小集)

所有 tool 输入用 zod schema,与 IPC handler 共享(在 `electron/shared/mcp-terminal-schemas.ts`)。

### 5.1 `terminal.create_session`

```ts
input: {
  cwd?: string,           // 默认 workspace root,无则 homedir
  name?: string,          // tab 显示名,默认 "Agent N"
  autorun?: string,       // 启动后自动键入并回车的命令,如 "codex"
  agentLabel?: string,    // 在 tab 上的小标(如 "codex")便于 UI 区分
}
output: { session_id: string }
```

行为:
1. 校验权限(见 §6),首次 → 弹授权 UI;已授权 → 直接通过
2. 调 `termService.createTerminal()` spawn 默认 shell(同用户手敲 path),env 继承 MCP token
3. 通知 renderer `addSession({id, title, originHint:'agent', agentLabel})`
4. 若有 `autorun`:**delay 200ms**(等 shell prompt)→ `termService.write(id, autorun + '\n')`
5. 返回 `session_id`

**不**直接用 autorun 替换 shell 启动 — 走方案 (b) shell + 键入,保留兜底。

### 5.2 `terminal.send_input`

```ts
input: { session_id: string, data: string }
output: void
```

直接 `termService.write()`。`data` 可含 `\n`、`\x03`(Ctrl+C)、`\x04`(Ctrl+D) 等控制字符。

### 5.3 `terminal.read_output`

```ts
input: {
  session_id: string,
  since_seq?: number,     // 增量游标;首次调省略 → 从最近 N 行开始
  max_lines?: number,     // 默认 200,上限 2000
  strip_ansi?: boolean,   // 默认 true(给 agent 干净文本)
}
output: {
  lines: string[],
  next_seq: number,
  truncated: boolean,
}
```

实现要点:
- 需要在 `terminal.service.ts` 给每个 session 加 **环形 buffer**(默认 8000 行,可配)。
- buffer 持续累积 PTY raw output,read 时按行切 + 可选剥 ANSI(用 `strip-ansi` 或自写小函数,不引依赖)。
- `since_seq` 是单调递增的"行号 from session start",buffer 满后底部丢弃但 seq 不复用 — agent 看到 `truncated:true` 知道丢过。

### 5.4 `terminal.list_sessions`

```ts
input: {}
output: {
  sessions: Array<{
    session_id: string,
    title: string,
    cwd: string,
    origin: 'user' | 'agent',
    agent_label?: string,
    created_at: number,    // ms epoch
    exit_code: number | null,
  }>
}
```

任何持有 token 的 agent 都能看到所有 session(用户的 + 别的 agent 的)。这是有意为之 — 决策 #3 共享模型。

### 5.5 `terminal.kill`

```ts
input: { session_id: string, signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL' }
output: void
```

- `SIGINT` → `termService.interrupt()`(写 `\x03`)
- `SIGTERM` → `termService.kill()`(走 3s grace period 流程)
- `SIGKILL` → 直接 `inst.pty.kill('SIGKILL')`(需要给 service 加这个分支)

默认 `SIGTERM`。

## 6. 权限模型(决策 #2:一次性授权)

### 6.1 何时弹

第一次任何 agent 调 `terminal.create_session` 时,弹模态:

```
[Continuo]
某个外部 agent 想创建并控制内置终端。

允许后,持有 MCP token 的 agent 可以:
- 新建/关闭 terminal session
- 向已有 session 写入命令
- 读取 session 输出

token 只有当前会话有效,Continuo 退出即作废。

  [仅本次]   [本次启动期间允许]   [拒绝]
```

`仅本次` = 只通过这一次调用,后续每次再弹。
`本次启动期间允许` = 标记 `agentTerminalAuthorized=true` 至 app 退出。
`拒绝` = MCP tool 返回 `{error: 'PERMISSION_DENIED'}`,session 不创建。

### 6.2 不持久化

每次重启 Continuo 重新弹一次。理由:首次启用心智明确,持久化反而埋雷(token 在,但 Continuo 已重启 → 老 PTY 已死却继续注入 = 误导)。

### 6.3 撤销入口

状态栏显眼按钮 `[终止所有 agent terminal]`(决策 #1 配套):
- 一键 SIGTERM 所有 `originHint:'agent'` 的 session
- 同时 revoke token(rotate 一次,旧 token 立刻 401)

### 6.4 非授权操作

未授权 agent 调任何 tool → 返回 `{error: 'AGENT_NOT_AUTHORIZED', message: '请在 Continuo 中允许 agent terminal'}`。
不直接拒绝连接 — 让 agent 知道是权限问题,不是网络问题。

## 7. Env 注入

`terminal.ipc.ts` 的 `makeCreateHandler` 已支持自定义 `env`。计划 17 改动:
- 在 `processIpcCall` wrapper 里、调 `termService.createTerminal` **之前**,把 MCP env 合并进去:

```ts
const mcpEnv = {
  CONTINUO_MCP_URL: `http://127.0.0.1:${mcpHost.port}/sse`,
  CONTINUO_MCP_TOKEN: mcpHost.token,
  CONTINUO_HOST: 'desktop',
};
service.createTerminal(id, win, shell, args, cwd, { ...mcpEnv, ...input.env });
```

**所有** terminal 都注入(用户手开的也注入),不区分 — 这样用户任何时候手敲 `claude` 都自动认识 MCP host。`agent_label` 只是 UI 提示,不影响 env。

## 8. UI 改动

### 8.1 TerminalTabs

每个 tab 的标题区:
- `originHint:'user'` → 现状不变(`Terminal N`)
- `originHint:'agent'` → 标题前加点状指示 + 副标 `agentLabel`,如:`● codex • Terminal 2`
- 用 design `Badge` size=xs,颜色用 `accent`

### 8.2 关闭按钮

`originHint:'agent'` 的 tab 关闭按钮 hover 提示:`关闭 agent terminal(SIGTERM)`,confirm 弹一次小气泡。

### 8.3 状态栏

新增:
- `[● 1 agent session]`(数字随实时变化)
- 点击 → 弹小菜单:列出所有 agent session + `[终止全部]` 按钮

### 8.4 不做的事

- 不在 PTY 输出里区分用户输入 vs agent 输入(技术上很难,且 agent 通过 `send_input` 写的就是普通 stdin,xterm 渲染一样)
- 不加录屏 / 审计日志(MVP 不做,Phase 3 再议)

## 9. Session 模型扩展

`src/stores/terminal.store.ts`:

```ts
export interface TerminalSession {
  readonly id: string;
  readonly title: string;
  readonly createdAt: number;
  exitCode: number | null;
  // ── 新增 ──
  readonly originHint: 'user' | 'agent';
  readonly agentLabel?: string;        // 'codex' / 'gemini' / 'claude' …
}
```

`addSession` 签名加这两个字段,`originHint` 默认 `'user'`(向后兼容现有调用点)。

## 10. 文件清单

新增:
- `electron/main/services/mcp-host.service.ts` — HTTP SSE server + token 管理
- `electron/main/services/mcp-tools-terminal.ts` — 5 个 tool 实现 + dispatcher
- `electron/shared/mcp-channels.ts` — renderer ↔ main 的授权请求通道
- `electron/shared/mcp-terminal-schemas.ts` — 5 个 tool 的 zod schema(给 main 校验 + 给 BDD 共享)
- `src/shell/AgentAuthPrompt.tsx` — 授权弹窗
- `src/stores/agent-auth.store.ts` — 授权状态(本会话内)
- `src/__tests__/agent-terminal-mcp/` — BDD 规范(见 §12)

改动:
- `electron/main/services/terminal.service.ts` — 加环形 buffer + `kill(id, signal?)` 分支
- `electron/main/ipc/terminal.ipc.ts` — env 注入 MCP token
- `electron/main/index.ts` — 启动时 init MCP host
- `src/stores/terminal.store.ts` — `originHint` / `agentLabel`
- `src/panels/Terminal/TerminalTabs.tsx` — agent 标记渲染
- `src/shell/StatusBar.tsx` — agent session 计数

## 11. Phase 阶段推进

按"垂直可演示"切片,每 Phase 跑通端到端再下一个。

### Phase 1 — MCP host + 1 个 tool (`list_sessions`)

- 启 HTTP SSE server,生成 token
- `terminal.list_sessions` 返回当前 store 快照
- 写一个 `scripts/agent-cli-stub.mjs` 在内置 terminal 里跑,验证能反连 + 调 `list_sessions`
- 状态栏不动,UI 零改动

**done 标准**:terminal 里跑 `node ../scripts/agent-cli-stub.mjs` 打印出当前 sessions JSON。

### Phase 2 — `create_session` + 授权 UI

- 实装授权弹窗 + `agent-auth.store`
- `terminal.create_session` 走完整链路(权限校验 → spawn → 通知 renderer → 返回 id)
- 还**不**支持 `autorun`(下一 Phase)

**done 标准**:agent stub 调 `create_session({name:'manual-test'})` → 弹授权 → 同意 → UI 出现新 tab,tab 标 agent 来源。

### Phase 3 — `send_input` + `read_output` + `autorun`

- 给 service 加环形 buffer + ANSI strip
- 完成 `send_input` / `read_output`
- `create_session` 支持 `autorun`(200ms delay 后键入)
- agent stub 升级:`create_session({autorun:'echo hello'})` → `read_output` 读到 "hello"

**done 标准**:agent stub 端到端跑通"建 session → autorun echo → read 到结果"。

### Phase 4 — `kill` + 状态栏 + 真 agent 联调

- `terminal.kill` 完整 signal 分支
- 状态栏 agent session 计数 + `终止全部`
- 用真 Claude Code CLI 在 terminal 1 跑,让它通过 MCP 调 `create_session({autorun:'codex'})` 起 terminal 2

**done 标准**:Claude Code 自主拉起 codex 并读到 codex 的 prompt 文本。

## 12. BDD 主题清单(`src/__tests__/<topic>/`)

每个主题一个 `README.md`(行为描述)+ 一个或多个 `*.spec.ts`。

| topic | 内容 |
|---|---|
| `agent-terminal-mcp/host` | MCP host 启动 / token rotate / 401 拒未授权 / 只听 127.0.0.1 |
| `agent-terminal-mcp/tools` | 5 个 tool 的输入校验 + 边界(unknown session_id / 越界 max_lines …) |
| `agent-terminal-mcp/auth` | 首次弹窗 / 仅本次 / 启动期间允许 / 拒绝;撤销后旧 token 立刻 401 |
| `agent-terminal-mcp/buffer` | 环形 buffer 行为(满后丢弃 / since_seq 增量 / truncated 标记 / ANSI strip 不破坏多字节) |
| `agent-terminal-mcp/origin` | `originHint:'agent'` session 在 store / UI / 状态栏的渲染差异 |

模块级 TDD:
- `terminal.service` 加的环形 buffer / `kill(signal)` 分支 → 包级单测
- `mcp-host.service` 的 token 生成 / Bearer 校验 → 包级单测

新增测试目录后 → `pnpm bdd:index` 重新生成索引。

## 13. 风险与未决

### R1 — node-pty 在 packaged app 的崩溃

历史:`rebuild:native` 脚本就是给 node-pty 用的。Phase 1 一开始就跑 `pnpm rebuild:native` + 试 `pnpm build:app` 验证打包后能起 PTY,不要拖到 Phase 4 才发现。

### R2 — MCP host 占用端口被占用 / 重启风险

随机端口 + 启动时探测,失败 retry 3 次。3 次都失败 → 标志 `mcpHostUnavailable`,不阻塞 app 启动,只在状态栏标 `agent terminal 不可用`。

### R3 — 跨平台 shell 行为差异

`autorun` 200ms delay 在 Windows powershell 上可能不够(prompt 来得慢)。Phase 3 验证时按平台分别测。退化方案:把 delay 配成参数 `autorunDelayMs`,默认 200,Windows 默认 600。

### R4 — agent 写出大量输出炸 buffer

环形 buffer 自带上限。但 `read_output` 单次 max_lines 上限 2000,超了截断 + `truncated:true`。agent 自己看到 truncated 应该 paginate。

### R5 — 与未来 Plugin 系统的关系

`doc/10` 的插件系统将来会接管很多内核功能。MCP host 暂时**不**做成 plugin —— 它是基础设施级,启动顺序在 plugin loader 之前。Phase 4 完成后再看是否抽出 plugin contribution point。

### R6 — token 泄漏

token 注入子进程 env,任何在那个 PTY 里跑的程序都能读到 `process.env.CONTINUO_MCP_TOKEN`。这是预期行为(就是要让 agent CLI 读到)。但要警告用户:**不要在 Continuo terminal 里跑不信任的程序**。文档里写一行,UI 不强提醒。

## 14. 相关决策记录

- 决策 #1 (UI 显示):agent 创建的 session 显示为 tab,tab 上有标记。不做后台隐藏 session。
- 决策 #2 (权限):一次性授权(本次启动有效),不持久化。撤销走"终止全部"按钮。
- 决策 #3 (共享):任何持 token 的 agent 都能 list / read / kill 所有 session(包括用户开的和别的 agent 开的)。
- 决策 #4 (autorun):shell 启动后键入命令(方案 b),不直接 spawn 命令替换 shell。

(决策来源:与用户的对话, 2026-05-05)
