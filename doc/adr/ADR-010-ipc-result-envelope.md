# ADR-010 · `IpcResult<T>` envelope for every IPC channel

**Status**: Accepted, implemented across all main↔renderer channels (extracted from ContinuoWiki tutorial 06 §3.3).

## Context

The earliest Continuo IPC channels (`layout:*`, `popout:*`) followed Node convention: success → resolve with value, failure → throw. This shape is awkward over IPC:

- Renderer can't distinguish "schema rejected my input" from "handler crashed" from "main is offline" without inspecting opaque error strings.
- Every renderer call site has to `try/catch` and string-match the error class, which doesn't survive process boundaries cleanly.
- Trusted-frame rejection (`safeHandle` security check) ends up indistinguishable from a handler bug.

When `tutorial 06` (Explorer) introduced 13+ fs.* channels, we needed a structured failure shape, not more `try/catch`.

## Decision

Every `ipcMain.handle` channel in Continuo returns:

```ts
type IpcResult<T> =
  | { ok: true;  data: T }
  | { ok: false; code: string; message: string };
```

`safeHandle` (and `safeHandleWithCtx`) is the **default** registration helper — it enforces three things on every call:

1. **Trust check** — reject non-trusted senderFrame with `{ ok: false, code: 'IPC_DENIED' }`.
2. **Zod validation** — invalid input → `{ ok: false, code: 'IPC_BAD_INPUT', message }`, handler never runs.
3. **Error envelope** — handler exceptions caught and shaped to `{ ok: false, code, message }`. The handler can attach a custom `.code` to its thrown object to surface a business-specific failure code (e.g. `'FS_NOT_FOUND'`); otherwise the fallback is `IPC_HANDLER_ERROR`.

A handful of channels need access to the raw `IpcMainInvokeEvent` (sender `BrowserWindow`, sender `webContents.id` for destroy-hook bookkeeping, etc.) and register via `ipcMain.handle` directly. These exceptions still go through `processIpcCall` (the pure-function core that `safeHandle` wraps), so the envelope contract still holds. As of 2026-05-17 the documented exceptions are:

- `electron/main/ipc/terminal.ipc.ts` — `ownerScopedHandle` factor + `TERMINAL_CHANNELS.CREATE` closure: both call `ipcMain.handle` + `processIpcCall` so the handler can close over `senderWindowOrThrow(event)`.
- `electron/main/ipc/plugin-mcp.ipc.ts` — `PLUGIN_MCP_CHANNELS.REGISTER` and adjacent channels: comment-documented "needs `event.sender.id` for wcId destroy-hook bookkeeping."
- `electron/main/ipc/window.ipc.ts` — `WINDOW_CHANNELS.NOTIFY_ROOT` hand-rolls the envelope inline (no `processIpcCall`) because it's an input-sanitation hint, not a security boundary.

The contract the renderer sees is unchanged: every channel returns `IpcResult<T>`. The mechanism is "always through `processIpcCall` or `safeHandle` (which is `processIpcCall` plus a wrapper)," not "always through `safeHandle`."

Infrastructure codes (`IPC_ERR`):

- `IPC_DENIED` — trusted-frame check failed
- `IPC_BAD_INPUT` — zod parse failed
- `IPC_HANDLER_ERROR` — handler threw without a `.code`

Business codes (handler-defined): e.g. `FS_NOT_FOUND`, `FS_DENIED`, `FS_IO`, `TERMINAL_CWD_UNRESOLVED`, `PERMISSION_DENIED`, `IPC_BAD_INPUT`. Each handler is free to define its own and document them.

## Renderer usage pattern

```ts
const r = await coApi.fs.readFile(path);
if (!r.ok) {
  switch (r.code) {
    case 'FS_NOT_FOUND': /* show empty */ break;
    case 'FS_DENIED':    /* permission UI */ break;
    default:             /* unexpected; report */
  }
  return;
}
useContent(r.data);
```

## Migration

When ADR-010 was accepted, `layout:*` and `popout:*` were migrated from throw → envelope. As of 2026-05-17 verify, every registered channel under `electron/main/ipc/` returns `IpcResult` — no throw-based channels remain. Most go through `safeHandle` / `safeHandleWithCtx`; the few that hand-roll registration (see exceptions above) still produce the envelope through `processIpcCall` or inline construction.

## Consequences

- Renderer callers must always branch on `r.ok`; TypeScript narrows accordingly.
- Handler authors can `throw { code: 'X', message }` for typed failures, or just throw — the envelope catches both.
- The same envelope is used by reverse-IPC handlers (main → renderer) and by the agent-auth bridge, keeping one mental model.

## See also

- `electron/shared/ipc-result.ts` — type + `IPC_ERR` constants
- `electron/main/safe-handle.ts` — wrapper implementation + `processIpcCall` pure-function variant for unit tests
- ContinuoWiki tutorial 06 §3.3 (origin and migration story)
- `electron/main/README.md`
