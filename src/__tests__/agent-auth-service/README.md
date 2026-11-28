# agent-auth-service

This BDD topic pins `electron/main/services/agent-auth.service.ts`, the main-process reverse IPC transport for agent authorization prompts and the revoke path that terminates agent-owned terminal sessions.

It closes the P0 main IPC/service guard series together with topic-12 `window-workspace-roots-map` (`NotifyRoot` + lifecycle clear) and topic-13 `window-ipc-create` (`CREATE` handler). This topic is BDD-only: no source files are modified.

Behavior contract checklist T1-T15:

T1 `requestAgentAuth` sends `AGENT_AUTH_CHANNELS.REQUEST` to the selected main window with `requestId` (generated in main), `method`, and optional `external`, then resolves with the renderer decision;
T2 with no windows, `requestAgentAuth` resolves `'denied'` immediately;
T2b with only destroyed windows, `requestAgentAuth` resolves `'denied'` and sends no IPC;
T3 unanswered auth requests time out after `AGENT_AUTH_PROMPT_TIMEOUT_MS` (2 minutes, counted from when the prompt is displayed) and resolve `'denied'`;
T4/T4b/T5 (removed 2026-11-18) the "no `ownerWindowId` → pick a main window" fallback no longer exists, see T-routing-4;
T-routing-1 an explicit `ownerWindowId` routes the prompt to that alive non-popout window only;
T-routing-2/3 (security, fail-closed) an explicit `ownerWindowId` that is unknown, destroyed, or a popout resolves `'denied'` and sends no IPC to any other window — previously it fell back to the first main window, so a session's prompt could land in (or be silently granted by) a different window. Popouts have no reliable owner-main-window mapping (`window.open` child, no `parent`) and do not mount the prompt;
T-routing-4 (security, fail-closed) omitting `ownerWindowId` resolves `'denied'` and sends no IPC — `McpCallCtx.ownerWindowId` is required so the old pickMainWindow fallback was dead code, and a caller without window context must not get a prompt in whatever window the user happens to be using;
T6 `resolveAgentAuthRequest` resolves a pending request with `'once'`;
T7 resolving an unknown `requestId` is a no-op and does not disturb later resolutions;
T8 resolving the same `requestId` twice is idempotent: the first decision wins;
T9 resolving a request clears the timeout path, so advancing past the prompt timeout does not change the settled decision;
T10 `_resetPendingForTest` denies every pending request and clears pending state;
T11 `revokeAndKillAgentSessions` rotates the MCP token, removes and force-kills only `originHint:'agent'` sessions, and never touches user sessions (the rotation also invalidates stdio connections already bound via `_continuo/hello`, not only HTTP — see `src/__tests__/stdio-revoked-token-binding/`);
T12 revoke iterates over a snapshot, so mutating the backing session array during `remove` does not skip later agent sessions;
T13 with `mcpHostRef=null`, revoke still removes and kills agent sessions but returns `rotated:false`;
T13b when `terminal.service.has(id)` is false, revoke skips PTY kill but still removes metadata;
T14 `setMcpHostRef` is covered indirectly by T11 and T13;
T15 `INDEX.md` contains `agent-auth-service` after `pnpm bdd:index`.

The spec uses local-only `vi.hoisted` mocks for Electron windows, terminal session metadata, and terminal service. It uses fake timers with `advanceTimersByTimeAsync` for the prompt-timeout contract. Helpers such as `makeSession`, `makeMcpHost`, and `makeWin` are intentionally local to the spec and are not exported or shared with other topics.

T7b `answerAgentAuthRequest`(ipc respond 入口)对已不在等待的 `requestId`(撤销 / 超时 / 窗口关闭已结算并删除)抛 `AGENT_AUTH_REQUEST_NOT_PENDING`(renderer 收到 ok:false,据此不记 session 授权);
T7c 对仍在等待的 `requestId` 正常结算、不抛。
T7d 应答方窗口(IPC sender 所在窗口)必须是该请求的目标窗口;否则(别的窗口 / 无窗口)抛 `AGENT_AUTH_REQUEST_NOT_PENDING` 且不结算,
目标窗口之后仍可正常应答 —— 防止拿到 raw IPC 的其它窗口替目标窗口放行授权。
T7e ipc respond 接线用 `BrowserWindow.fromWebContents(event.sender)` 推断应答方窗口(源码钉)。

T17 `cancelAllAgentAuth`(退出清理)把所有窗口的未决请求立即结算为 `'denied'` 并返回取消数;不发任何 IPC、不轮换 token
(不是「撤销」语义)。before-quit 窗口已隐藏无人应答,否则挂在授权上的 MCP 调用会把 `mcpHost.close()` 拖到无应答超时(2 分钟)。

T16 撤销(`revokeAndKillAgentSessions`)完成后向所有存活窗口广播 `AGENT_AUTH_CHANNELS.REVOKED`(payload `{}`):
main 已先清空全部「本次启动期间允许」(权威在 main);广播让各窗口 renderer 重置授权位的界面副本(状态栏撤销入口)
并取消残留弹窗(main 已结算这些请求,不撤掉的话用户点了只会得到 NOT_PENDING)。各 renderer 收到后执行与本地撤销相同的重置(见 `agent-auth-prompt` / `agent-terminal-mcp-auth`)。

Prompt throttling (2026-11-18, security): `requestAgentAuth` now runs every request for a domain that is not yet "allowed for this launch" through the shared prompt throttle (deny cooldown / backoff / rate cap / one pending prompt per caller) and rejects with `AGENT_NOT_AUTHORIZED` when throttled — see `src/__tests__/agent-auth-prompt-throttle/`. Requests for a domain the user already allowed for this launch are approved in main directly (no pending entry, no IPC), and unallowed requests are single-flight per caller class, so the E229 pending caps are a backstop: the E229 case reaches the global cap by accumulating one pending prompt per caller class across many windows.

T18 弹窗说明(`AgentAuthInfo.details` / `callerToken`,第五十八轮):工具门控把请求的关键参数(create_session 的 autorun / cwd /
agentLabel、debug.launch 的 program / cwd)与调用方绑定的 MCP token(`McpCallCtx.callerToken`:HTTP bearer / stdio hello 所用 token;
外部客户端没有)交给 `requestAgentAuth`。main 按 token 反查持有它的终端会话(`terminal.service.sessionIdForMcpToken`,
`caller-terminal.spec.ts`)填 `details.callerSessionId`(调用方自报的同名字段被覆盖;external 不查),每字段截到
`AGENT_AUTH_DETAIL_MAX`、空串去掉后随 payload 下发;token 本身不下发。**只作显示**:不进授权键、不影响节流 / 放行
(已「本次启动期间允许」的域,不论说明如何都直接放行)。ingress 守卫 `isAgentAuthRequestPayload` 只收已知字段的不超长字符串。

T19 撤销计数(`countAgentTerminalSessions`)与撤销终止的集合只含**仍在运行**的 agent 终端;已退出的不终止、不删除。
