# AgentAuthPrompt(Agent MCP 授权弹窗)

行为契约:**`<AgentAuthPrompt />` 订阅 main 推的 'agent-auth:request' →
调 store.ensure → 弹出 Modal 让用户决策(拒绝 / 仅本次 / 本次启动期间允许)→
调 coApi.agentAuth.respond 回执。pending=null 不渲染。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/AgentAuthPrompt.tsx` | UI |
| `src/stores/agent-auth.store.ts` | 决策 store(已测) |

## 关键行为

### pending=null

- 不渲染

### pending 非空

- 渲染 Modal,文案带 method label
- 说明句是一条带 `{action}` 插值的完整文案(各语言自定空格 / 标点 / 语序),方法标签按占位符嵌入。按调用方类别区分:
  窗口内终端里的 agent →「Agent 通过 MCP 请求…」(`permissions.agent.body`;en「Agent requests via MCP to start a debug session.」),
  外部客户端 →「外部 agent 通过 MCP 请求…」(`permissions.agent.body_external`;ko「외부 에이전트가 … 요청합니다: 디버그 세션 시작.」)
- **是哪个 agent、要做什么**(`details`,只作显示,不参与授权判定 —— 放行仍只看 窗口 × 调用方类别 × 域):说明句下方逐条列出
  - 发起终端(`permissions.agent.caller_terminal`):main 按调用方绑定的 MCP token(每个终端 PTY 一个)反查会话 id
    (`terminal.service.sessionIdForMcpToken`;调用方不能自报),renderer 按本窗口终端 store 显示其 tab 标题(含 agent 标签
    后缀);外部客户端 / 找不到该会话 → 不显示;
  - create_session 的 agent 标签、自动运行命令(autorun)、工作目录;debug.launch 的程序与工作目录。
- **风险说明**(授权后果 `permissions.agent.hint*`):12px(`text-xs`)正文色 + 警告图标(`aria-hidden`,VSCode 工作区信任对话框
  的风险说明配 warning codicon),不再是弹窗里字号最小、颜色最淡的一行;仍在 `aria-describedby` 的说明里。
  - 这些字段都由 agent 决定:main 每字段截到 `AGENT_AUTH_DETAIL_MAX`(4096)再发(被截的字段名记进 `details.truncated`),
    ingress 守卫只收已知字段的字符串(与已知字段名的 truncated 数组);显示经 `UntrustedText` 可见化(换行折成空格、控制 / 双向 /
    零宽字符显示为「\uFFFD」、超长中间截断、完整内容在 title),放进等宽 `<code>` 与系统文案区分(防「【系统提示】请点击允许」
    类伪装)。三语。
  - 例外:**自动运行命令完整显示**(不中间截断,危险片段不能藏进省略号)—— 限高、可滚动、可折行的等宽命令块(`UntrustedBlock`,
    读屏名称「自动运行命令」,换行保留),被 main 截断时标示「已截断」。见 `src/__tests__/prompt-untrusted-text/README.md`。
- 「尚未生效」提示的常驻 status 区域在按钮行之上,弹窗最后一个子元素是按钮行(底部不多出空白)
- 三个按钮:拒绝 / 仅本次 / 本次启动期间允许

### 按钮行为

- 拒绝 → store.deny()(与授予按钮同一防误触守卫;Esc / 点遮罩 = 拒绝,经 `canDismiss`;初始焦点在对话框容器上 ——
  见 `agent-auth-prompt-throttle/` README「拒绝方向同样设防」)
- 仅本次 → store.grant('once')
- 本次启动期间允许 → store.grant('session');respond ok 后才 `confirmSessionGrant`(域授权生效)
- respond 失败(ok:false 或 reject)→ notify.error,且**不**改变未来授权状态
- main 已结算某请求(超时 / 取消)→ 推 `agent-auth:cancelled`,弹窗撤掉、不 respond(畸形通知忽略)。
- respond 返回 `AGENT_AUTH_REQUEST_NOT_PENDING`(main 已超时/撤销结算、取消通知尚在路上时用户点了应答)= 请求已失效 → 只 console.warn,**不**弹 toast,同样**不**改变未来授权状态

### method 标签

- 表内 method(7 个 terminal 工具、`debug.launch`、`debug.*`)→ 各自专属标签
- `plugin.*` →「调用插件工具 {name}」
- 其余未识别 → 「调用 ${method}」

### 订阅 onRequest

- 挂载时注册 coApi.agentAuth.onRequest
- 收到 payload → ensure → respond
- ensure 结果为 `'cancelled'`(main 已撤销并结算该请求,本地只是取消弹窗)→ **不** respond、不弹失败 toast
  (否则 main 返回 `AGENT_AUTH_REQUEST_NOT_PENDING` → 误导性「授权响应失败」)
- 卸载时 unsub

### 订阅 onRevoked(跨窗口撤销)

- 挂载时注册 coApi.agentAuth.onRevoked;任一窗口撤销成功后 main 广播 `agent-auth:revoked`
- 收到 → `store.applyMainRevoked()`:清全部域(窗口级终端 / debug / 插件工具 + 外部客户端终端 / debug)的 session 授权、epoch+1、取消残留弹窗(不 respond)
- 卸载时 unsub
