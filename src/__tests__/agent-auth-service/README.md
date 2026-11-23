# agent-auth-service

This BDD topic pins `electron/main/services/agent-auth.service.ts`, the main-process reverse IPC transport for agent authorization prompts and the revoke path that terminates agent-owned terminal sessions.

It closes the P0 main IPC/service guard series together with topic-12 `window-workspace-roots-map` (`NotifyRoot` + lifecycle clear) and topic-13 `window-ipc-create` (`CREATE` handler). This topic is BDD-only: no source files are modified.

Behavior contract checklist T1-T15:

T1 `requestAgentAuth` sends `AGENT_AUTH_CHANNELS.REQUEST` to the selected main window with `requestId`, `method`, and optional `agentLabel`, then resolves with the renderer decision;
T2 with no windows, `requestAgentAuth` resolves `'denied'` immediately;
T2b with only destroyed windows, `requestAgentAuth` resolves `'denied'` and sends no IPC;
T3 unanswered auth requests time out after five minutes and resolve `'denied'`;
T4/T4b/T5 (removed 2026-11-18) the "no `ownerWindowId` → pick a main window" fallback no longer exists, see T-routing-4;
T-routing-1 an explicit `ownerWindowId` routes the prompt to that alive non-popout window only;
T-routing-2/3 (security, fail-closed) an explicit `ownerWindowId` that is unknown, destroyed, or a popout resolves `'denied'` and sends no IPC to any other window — previously it fell back to the first main window, so a session's prompt could land in (or be silently granted by) a different window. Popouts have no reliable owner-main-window mapping (`window.open` child, no `parent`) and do not mount the prompt;
T-routing-4 (security, fail-closed) omitting `ownerWindowId` resolves `'denied'` and sends no IPC — `McpCallCtx.ownerWindowId` is required so the old pickMainWindow fallback was dead code, and a caller without window context must not get a prompt in whatever window the user happens to be using;
T6 `resolveAgentAuthRequest` resolves a pending request with `'once'`;
T7 resolving an unknown `requestId` is a no-op and does not disturb later resolutions;
T8 resolving the same `requestId` twice is idempotent: the first decision wins;
T9 resolving a request clears the timeout path, so advancing five minutes does not change the settled decision;
T10 `_resetPendingForTest` denies every pending request and clears pending state;
T11 `revokeAndKillAgentSessions` rotates the MCP token, removes/kills/destroys only `originHint:'agent'` sessions, and never touches user sessions (the rotation also invalidates stdio connections already bound via `_continuo/hello`, not only HTTP — see `src/__tests__/stdio-revoked-token-binding/`);
T12 revoke iterates over a snapshot, so mutating the backing session array during `remove` does not skip later agent sessions;
T13 with `mcpHostRef=null`, revoke still removes/kills/destroys agent sessions but returns `rotated:false`;
T13b when `terminal.service.has(id)` is false, revoke skips PTY kill but still removes metadata and destroys the buffer;
T14 `setMcpHostRef` is covered indirectly by T11 and T13;
T15 `INDEX.md` contains `agent-auth-service` after `pnpm bdd:index`.

The spec uses local-only `vi.hoisted` mocks for Electron windows, terminal session metadata, terminal service, and terminal buffer. It uses fake timers with `advanceTimersByTimeAsync` for the five-minute timeout contract. Helpers such as `makeSession`, `makeMcpHost`, and `makeWin` are intentionally local to the spec and are not exported or shared with other topics.

T7b `answerAgentAuthRequest`(ipc respond 入口)对已不在等待的 `requestId`(撤销 / 超时 / 窗口关闭已结算并删除)抛 `AGENT_AUTH_REQUEST_NOT_PENDING`(renderer 收到 ok:false,据此不记 session 授权);
T7c 对仍在等待的 `requestId` 正常结算、不抛。
T7d 应答方窗口(IPC sender 所在窗口)必须是该请求的目标窗口;否则(别的窗口 / 无窗口)抛 `AGENT_AUTH_REQUEST_NOT_PENDING` 且不结算,
目标窗口之后仍可正常应答 —— 防止拿到 raw IPC 的其它窗口替目标窗口放行授权。
T7e ipc respond 接线用 `BrowserWindow.fromWebContents(event.sender)` 推断应答方窗口(源码钉)。

T17 `cancelAllAgentAuth`(退出清理)把所有窗口的未决请求立即结算为 `'denied'` 并返回取消数;不发任何 IPC、不轮换 token
(不是「撤销」语义)。before-quit 窗口已隐藏无人应答,否则挂在授权上的 MCP 调用会把 `mcpHost.close()` 拖到无应答超时(2 分钟)。

T16 撤销(`revokeAndKillAgentSessions`)完成后向所有存活窗口广播 `AGENT_AUTH_CHANNELS.REVOKED`(payload `{}`):
main 已先清空全部「本次启动期间允许」(权威在 main);广播让各窗口 renderer 重置授权位的界面副本(状态栏撤销入口)
并取消残留弹窗(否则残留弹窗被点「本次启动期间允许」会再记一次授权)。各 renderer 收到后执行与本地撤销相同的重置(见 `agent-auth-prompt` / `agent-terminal-mcp-auth`)。

Prompt throttling (2026-11-18, security): `requestAgentAuth` now runs every request for a domain that is not yet "allowed for this launch" through the shared prompt throttle (deny cooldown / backoff / rate cap / one pending prompt per caller) and rejects with `AGENT_NOT_AUTHORIZED` when throttled — see `src/__tests__/agent-auth-prompt-throttle/`. The E229 pending caps are therefore only reachable for a domain the user already allowed for this launch (those requests are forwarded unthrottled), which is how the E229 cases now set up.
