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

---

## 15. 实装收尾(2026-05-05)

§1-§14 是初版规划。下面是**实际做完的范围**,以及与计划的偏差。

### 15.1 完成度

| 范围 | 状态 | commit |
|---|---|---|
| 计划书 | ✓ | `8c821c1` |
| P1 — sessions 真相源搬 main + MCP host(HTTP) | ✓ | `e61c424` |
| P2 模块层 — auth store + create_session tool | ✓ | `e49db4b` |
| P2 接线 — 反向 IPC + 弹窗 + tool 注册 | ✓ | `6dc467f` |
| P2 美化 — 状态栏 agent 计数 + 撤销 | ✓ | `9789bf6` |
| P3 模块层 — buffer + send_input/read_output + autorun | ✓ | `2abc258` |
| P3 接线 — PTY buffer hook + tool 注册 + autorun delay | ✓ | `1e7d143` |
| P4 — kill tool(SIGINT/SIGTERM/SIGKILL) | ✓ | `654ea55` |
| **超额 1**:MCP 标准协议适配(initialize/tools/list/tools/call) | ✓ | `35bf93f` |
| **超额 2**:LF/CR 容错(send_text + press_key + preparePtyData) | ✓ | `35bf93f` |
| **超额 3**:stdio transport(unix socket,一次配置永久) | ✓ | `c64aadb` |
| UI 修复(列宽 / 单 tab / + 按钮位置) | ✓ | `28775ff` |

最终统计:**1061 tests / 59 BDD topics / typecheck 干净**。

### 15.2 工具集(实际 7 个,原计划 5 个)

```
terminal.list_sessions     P1 ✓
terminal.create_session    P2 ✓ (P3 加 autorun 字段)
terminal.send_input        P3 ✓ (超额加 preparePtyData 容错)
terminal.send_text         超额 ★(c 方案:写文本不附加按键)
terminal.press_key         超额 ★(c 方案:enter/tab/escape/backspace
                                   /ctrl_c/ctrl_d/ctrl_z/arrows)
terminal.read_output       P3 ✓
terminal.kill              P4 ✓
```

新增 send_text + press_key 是因为实测 codex(raw mode TUI)不接 LF 当 Enter,
原计划 send_input 单一接口让 LLM 容易写错。拆分后语义清晰,server 替 LLM 处理
LF/CR / 按键字节映射。同时 send_input 内部加 `preparePtyData`(参考
MindAutonAgent3 设计):`\n→\r` + 字面 escape unescape,即使 LLM 错传 `\\n` 也能
正确触发 Enter(termios ICRNL 让 cooked mode 也兼容)。

### 15.3 协议 / Transport(双套并存)

原计划只 HTTP + Bearer + JSON-RPC,实际做了**两套并存**:

| transport | 配置命令 | 适用场景 |
|---|---|---|
| **HTTP** `/mcp` | `claude mcp add --transport http continuo "$CONTINUO_MCP_URL" --header "Authorization: Bearer $CONTINUO_MCP_TOKEN"` | stub 调试 / 兼容历史 |
| **stdio** unix socket | `claude mcp add --transport stdio continuo -- /path/to/scripts/continuo-mcp-stdio.mjs` | **推荐**;无 token,Continuo 重启不影响 |

stdio 是因为 HTTP 每次 Continuo 重启 token rotate → Claude Code 配置失效 → 用户得
重 add,体验差。stdio 走 unix socket(`userData/mcp.sock`,文件权限 0600),Claude
Code spawn 一个 thin proxy CLI(`scripts/continuo-mcp-stdio.mjs`),CLI 透传
stdin/stdout 字节到 socket。配置里只有 spawn 命令路径,无 token,**一次配置永久使用**。

MCP 标准协议适配:`initialize` / `tools/list` / `tools/call` / `notifications/initialized`,
让真 Claude Code(Inspector 等)能直接接入 — 旧 P1 的"method 即 tool name"形态已废弃,
通过 dispatcher 统一路由(只有 `tools/call` 能调 tool)。HTTP 路径从 `/sse` + `/message`
合并成单 `/mcp`(streamable HTTP transport)。

### 15.4 与原计划的偏差(决策更新)

- **决策 #2(权限,一次性)**:HTTP transport 仍然每次启动 rotate token(决策不变),
  但 stdio transport **无 token**,客户端配置永久有效。撤销(revoke)只 kill agent
  terminal + rotate HTTP token,不影响 stdio 客户端 — 这是有意的:撤销是终止当前
  agent 会话,不是封禁未来连接。要彻底封禁 → 关 Continuo。

- **决策 #4(autorun delay)**:实装与计划一致(Unix 200ms / Windows 600ms),
  但 autorun 通过 setTimeout 在 main 进程里实现,不依赖 PTY shell prompt 检测。

- **R6 (token 泄漏)更新**:P1 token 注入 PTY env 风险维持。stdio transport 加了一份
  风险面:unix socket 文件 `userData/mcp.sock` 权限 0600,只 owner 可读写;同用户其他
  进程仍可访问 — 与 PTY env 等级。**警告范围扩大**:不要让不信任的同用户进程访问
  Continuo userData。

### 15.5 BDD topics(原计划 5 个,实装 12 个)

`src/__tests__/<topic>/`:

| topic | 测什么 | tests |
|---|---|---|
| `agent-terminal-mcp-host` | token / Bearer / RPC 编解码 / bind 校验 | 48 |
| `agent-terminal-mcp-list-sessions` | tool 输入输出 + 字段映射 | 18 |
| `agent-terminal-mcp-auth` | auth store 状态机 / Promise 时序 | 17 |
| `agent-terminal-mcp-create-session` | tool 行为 + autorun 透传 | 25 |
| `agent-terminal-mcp-buffer` | 环形 buffer + ANSI strip(CSI/OSC/keypad/charset)| 35 |
| `agent-terminal-mcp-send-input` | tool 行为 + preparePtyData 纯函数 | 32 |
| `agent-terminal-mcp-read-output` | tool 字段映射 + 错误转换 | 20 |
| `agent-terminal-mcp-kill` | signal 路由(SIGINT/SIGTERM/SIGKILL)| 22 |
| `agent-terminal-mcp-dispatcher` | initialize/tools/list/tools/call 路由 | 17 |
| `agent-terminal-mcp-send-text` | 写纯文本 verbatim | 18 |
| `agent-terminal-mcp-press-key` | KEY_BYTES 映射 + 11 个键 | 31 |
| `agent-terminal-mcp-stdio-framing` | NDJSON splitLines 纯函数 | 14 |

外加 `terminal-sessions-service`(25)、扩展的 `terminal-store`(19)、`terminal-ipc`(32)
等 main 端搬迁配套 BDD。socket server 真行为 / HTTP server 真行为留 E2E。

### 15.6 端到端验证流程(stdio,推荐)

```bash
# 1. 启 Continuo
pnpm dev

# 2. 配置 Claude Code(任何 shell 里,一次永久)
claude mcp add --transport stdio continuo -- /path/to/Continuo/scripts/continuo-mcp-stdio.mjs

# 3. 启 Claude Code 任意 session
claude
> what tools do you have from continuo?
# Claude Code 会列出 7 个 terminal.* tool

# 4. 让 Claude 在内置 terminal 跑 codex 并交互:
> open codex in continuo and ask it "你好"
# Claude 应自主:
#   1. terminal.create_session({autorun:'codex', name:'codex-test'})
#   2. terminal.send_text({session_id:..., text:'你好'})
#   3. terminal.press_key({session_id:..., key:'enter'})
#   4. terminal.read_output({session_id:...}) — 看 codex 响应
```

stub 调试(同一套协议):
```bash
node scripts/agent-cli-stub.mjs                          # tools/list
node scripts/agent-cli-stub.mjs terminal.list_sessions
node scripts/agent-cli-stub.mjs terminal.create_session '{"autorun":"echo hi"}'
```

### 15.7 仍未做(留后续)

| 项 | 状态 | 备注 |
|---|---|---|
| Windows named pipe 支持 | ✓ done(`df602c8` 后续 commit)| `\\.\pipe\continuo-mcp`,net 模块 API 跨平台一致 |
| CLI binary 打包到 app bundle | ✓ done(`ba1c535`)| extraResources 拷到 Resources/,packaged 用 process.resourcesPath |
| 状态栏"复制 MCP 配置"按钮 | ✓ done(`df602c8`)| 点击复制 claude mcp add 命令到剪贴板 |
| HTTP token 持久化(方案 A)| 不做 | stdio 已解决体验,HTTP 保留作 stub 调试 |
| Inspector / Cursor 等其它 MCP client 联调 | 留后续 | 协议已标准化,理论上 work,需手验 |
