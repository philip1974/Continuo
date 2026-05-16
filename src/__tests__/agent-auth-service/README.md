# agent-auth-service

This BDD topic pins `electron/main/services/agent-auth.service.ts`, the main-process reverse IPC transport for agent authorization prompts and the revoke path that terminates agent-owned terminal sessions.

It closes the P0 main IPC/service guard series together with topic-12 `window-workspace-roots-map` (`NotifyRoot` + lifecycle clear) and topic-13 `window-ipc-create` (`CREATE` handler). This topic is BDD-only: no source files are modified.

Behavior contract checklist T1-T15:

T1 `requestAgentAuth` sends `AGENT_AUTH_CHANNELS.REQUEST` to the selected main window with `requestId`, `method`, and optional `agentLabel`, then resolves with the renderer decision;
T2 with no windows, `requestAgentAuth` resolves `'denied'` immediately;
T2b with only destroyed windows, `requestAgentAuth` resolves `'denied'` and sends no IPC;
T3 unanswered auth requests time out after five minutes and resolve `'denied'`;
T4 popout windows are skipped when a normal window is available;
T4b if all live windows are popouts, the first live popout is used as the current fallback contract;
T5 destroyed windows are skipped while selecting the main window;
T6 `resolveAgentAuthRequest` resolves a pending request with `'once'`;
T7 resolving an unknown `requestId` is a no-op and does not disturb later resolutions;
T8 resolving the same `requestId` twice is idempotent: the first decision wins;
T9 resolving a request clears the timeout path, so advancing five minutes does not change the settled decision;
T10 `_resetPendingForTest` denies every pending request and clears pending state;
T11 `revokeAndKillAgentSessions` rotates the MCP token, removes/kills/destroys only `originHint:'agent'` sessions, and never touches user sessions;
T12 revoke iterates over a snapshot, so mutating the backing session array during `remove` does not skip later agent sessions;
T13 with `mcpHostRef=null`, revoke still removes/kills/destroys agent sessions but returns `rotated:false`;
T13b when `terminal.service.has(id)` is false, revoke skips PTY kill but still removes metadata and destroys the buffer;
T14 `setMcpHostRef` is covered indirectly by T11 and T13;
T15 `INDEX.md` contains `agent-auth-service` after `pnpm bdd:index`.

The spec uses local-only `vi.hoisted` mocks for Electron windows, terminal session metadata, terminal service, and terminal buffer. It uses fake timers with `advanceTimersByTimeAsync` for the five-minute timeout contract. Helpers such as `makeSession`, `makeMcpHost`, and `makeWin` are intentionally local to the spec and are not exported or shared with other topics.
