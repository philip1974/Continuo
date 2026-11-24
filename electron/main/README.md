# `electron/main/` — Main process (IPC + services)

The Electron main-process side of Continuo. Owns the OS-level surface (file system, child processes, PTYs, native windows, MCP socket) and exposes a narrow IPC contract to the renderer + preload.

## Layout

| Path | Role |
|---|---|
| `index.ts` | Main-process entry. Creates windows, wires services, registers IPC handlers. |
| `ipc.ts` | Aggregate registration: pulls most `ipc/<area>.ipc.ts` files and calls their `register…` function (`debug-view.ipc.ts` and `plugin-mcp.ipc.ts` are wired from `index.ts`). |
| `safe-handle.ts` | The `safeHandle` / `safeHandleWithCtx` wrappers used by most IPC channels (exceptions below). |
| `persistence.ts` | `explorer.json` read / migration / merge (the schema lives in `electron/shared/explorer-persistence-schema.ts`; atomic writes in `lib/atomic-write.ts`) |
| `lib/` | Small helpers reused across services. |
| `services/` | Long-lived stateful services (PTY pool, MCP host, plugin bridge, agent-auth, window-seq, window-restore, …). |
| `ipc/` | One file per channel-namespace; most export a `register…Ipc(…)` that calls `safeHandle` per channel (exceptions below). |

`electron/shared/` (sibling) holds the channel-constant + envelope code that both main and preload import; it's the canonical IPC schema source.

## IPC contract — `IpcResult<T>`

Channels registered through `safeHandle` return this envelope (see `electron/shared/ipc-result.ts`):

```ts
type IpcResult<T> =
  | { ok: true;  data: T }
  | { ok: false; code: string; message: string };
```

The renderer (via `coApi` in `src/lib/co-api.ts`) gets the envelope back and branches on `ok`. Handlers **never throw** out the wire — `safeHandle` catches anything thrown, normalizes it to `{ ok: false, code, message }`, and surfaces it. Infrastructure codes live in `IPC_ERR` (`IPC_DENIED` / `IPC_BAD_INPUT` / `IPC_HANDLER_ERROR`); business handlers can `throw { code: 'MY_BUSINESS_CODE', message }` to attach a custom code.

## `safeHandle` — the default way to register an IPC

Exceptions:

- `plugin-data`, `plugin-fs` and `plugin-shell-stream` register `ipcMain.handle` directly behind the trusted-frame check (`withTrustedFrameGate` / `assertTrustedFrame`); they return plain values and reject on failure instead of using the envelope (exception: `PLUGIN_FS_CHANNELS.READ_FOR_EDITOR` resolves `{ ok: false, code, message }` on failure).
- `window.ipc.ts` (`NOTIFY_ROOT`) and `plugin-mcp.ipc.ts` use `safeHandleWithCtx` to reach `event.sender` (same trusted-frame check and `IpcResult` envelope); `plugin-mcp.ipc.ts` also has a one-way `ipcMain.on` for `INVOKE_REPLY` (trusted-frame checked, no envelope).
- `ipcMain.on` listeners in `index.ts` resolve the sender window through `trustedSenderWindow` (`safe-handle.ts`: trusted frame **and** the sender is that window's own main `webContents`, otherwise `null`) and use no envelope: one-way notifications (`LAYOUT_CHANNELS.DIRTY_STATE` / `FLUSH_ACK` / `FLUSH_READY`, `PLUGINS_CHANNELS.PROTOCOL_READY`, `AGENT_AUTH_CHANNELS.READY`) and the synchronous `WINDOW_ID_CHANNEL` (answers via `event.returnValue`, `0` when no trusted sender window).

New request/response channels should use `safeHandle`.

```ts
safeHandle(channel, zodSchema, handler);
```

Does three things every channel must do:

1. **Trust check** — `defaultIsTrustedFrame` accepts only the real renderer entry `index.html` as a `file://` URL (production; exact pathname, registered at startup via `setTrustedRendererFile`) or the dev-server origin (dev only: at startup `index.ts` passes the `ELECTRON_RENDERER_URL` origin to `setTrustedDevOrigin` when `isDev`, and `null` in packaged builds; `safe-handle` never reads env itself). Anything else — any other `file://` page (e.g. an attacker-written `evil.html` or an HTML file in a plugin folder), an injected iframe, a remote site — is refused with `IPC_DENIED`. The same check gates whether `windowOpenHandler` injects the preload, so a malicious `file://` popup can't obtain the full IPC surface.
2. **Zod validation** — invalid input → `IPC_BAD_INPUT`, never reaches the handler body.
3. **Error envelope** — handler exceptions get caught and shaped into `IpcFail`.

Use `safeHandleWithCtx` when the handler needs the raw `IpcMainInvokeEvent` (typically to look up the sender window via `BrowserWindow.fromWebContents(event.sender)`).

## Channel namespaces

Each lives in `electron/shared/*-channels.ts`. Most are registered by `electron/main/ipc/<area>.ipc.ts`; `MCP_CHANNELS`, `AGENT_AUTH_CHANNELS` (respond / revoke) and the `LAYOUT_CHANNELS` / `EXPLORER_CHANNELS` read/write handlers are registered directly in `ipc.ts` (`AGENT_AUTH_CHANNELS.READY` is an `ipcMain.on` listener in `index.ts`), and `PLUGIN_MCP_CHANNELS` (`ipc/plugin-mcp.ipc.ts`) is wired from `index.ts`:

| Namespace | File | Purpose |
|---|---|---|
| `FS_CHANNELS` | `fs-channels.ts` / `fs.ipc.ts` | File system: list/read/write/rename/trash/move/copy + atomic write |
| `TERMINAL_CHANNELS` | `terminal-channels.ts` / `terminal.ipc.ts` | Interactive PTY sessions (xterm renderer ↔ node-pty) |
| `SHELL_CHANNELS` | `shell-channels.ts` / `shell.ipc.ts` | One-shot, non-interactive shell exec (buffered output) |
| `WINDOW_CHANNELS` | `window-channels.ts` / `window.ipc.ts` | Window create + workspace-root binding (`NOTIFY_ROOT`); popouts go through `window.open` + `window-open-policy.ts` |
| `MCP_CHANNELS` | `mcp-channels.ts` | `GET_STDIO_CONFIG` — the stdio bridge config shown by "Copy MCP config" (served by `mcp-stdio-config.service.ts`) |
| `PLUGINS_CHANNELS` | `plugins-channels.ts` / `plugins.ipc.ts` | Plugin manager: list / install / enable / disable / permissions |
| `PLUGIN_MCP_CHANNELS` | `plugin-mcp-channels.ts` | Renderer plugin ↔ main MCP host bridge (plugin registers tool, agent invokes it) |
| `AGENT_AUTH_CHANNELS` | `agent-auth-channels.ts` | Reverse IPC: main asks renderer to authorize an agent MCP request |
| `LAYOUT_CHANNELS` / `EXPLORER_CHANNELS` | `persistence-channels.ts` | Dock layout and `explorer.json` read / write / flush handshake, window id |
| `I18N_CHANNELS` | `i18n-channels.ts` | Get / set the UI locale; broadcast locale changes to all windows |
| `MARKETPLACE_CHANNELS` | `marketplace-channels.ts` | Fetch plugin reviews in main (the GitHub token stays out of the renderer) |
| `DEBUG_VIEW_CHANNELS` | `debug-view-channels.ts` | Debug panel view events (sessions, breakpoints, stack, variables) |
| `PLUGIN_FS_CHANNELS` | `plugin-fs-channels.ts` | Plugin file-system access, gated by per-plugin path scopes |
| `PLUGIN_DATA_CHANNELS` | `plugin-data-channels.ts` | Per-plugin data store (`loadData` / `saveData`) |
| `PLUGIN_SHELL_STREAM_CHANNELS` | `plugin-shell-stream-channels.ts` | Streaming shell exec for plugins with the `shell` permission |

(`notify-channels.ts` only holds the notification text limits; it defines no channels.)

## Services worth knowing

- `terminal-sessions.service.ts` — single source of truth for terminal session metadata (the PTY processes live in `terminal.service.ts`). `sessions_changed` is pushed per window by `broadcastSessionsChanged` in `ipc/terminal.ipc.ts`, which filters by owner window in main, so each window only receives its own sessions.
- `mcp-host.service.ts` + `mcp-stdio-server.service.ts` + `mcp-tools-terminal.ts` + `mcp-terminal-host.ts` — the MCP server. Exposes the `terminal.*` tools (`list_sessions` / `create_session` / `send_input` / `send_text` / `press_key` / `read_output` / `kill`, plus `await_stop_hook` from `mcp-tools-hook-bridge.ts`; the `debug.*` tools live in `mcp-tools-debug.ts`); per-window scoping via the `_continuo/hello` handshake from `scripts/continuo-mcp-stdio.mjs`. Per-session tools additionally require the same MCP caller (one stdio connection, or an HTTP terminal token / Mcp-Session-Id session) to be the session's creator (`gateWithCapability` in `mcp-tool-gates.ts`); `list_sessions` is window-scoped only.
- `plugin-mcp-bridge.service.ts` — lets renderer plugins register MCP tools the MCP host then exposes upstream.
- `agent-auth.service.ts` — reverse-IPC channel for "the agent is asking to do X, do you allow?". Routes to the *owner* window only (issue #32 fix); calls without an owner, or whose owner is gone or a popout, are denied (fail-closed).
- `window-seq.service.ts` + `window-restore.service.ts` + `window-workspace-roots.service.ts` — per-window identity / layout restoration / cwd resolution.

## Adding a new IPC channel (recipe)

1. Add the channel constant in `electron/shared/<area>-channels.ts`.
2. Define a Zod schema for the input — usually next to the handler in `ipc/<area>.ipc.ts`, or in a shared `electron/shared/<area>.ts` module when preload / renderer also need the type.
3. Write the handler as a pure function — input → output (throw for failure, attach `.code` for non-default error codes).
4. In `electron/main/ipc/<area>.ipc.ts`, call `safeHandle(CHANNEL, schema, handler)` from the register function.
5. Expose the method on the API object in `electron/preload/index.ts`; the renderer reaches it through `coApi` (`src/lib/co-api.ts` is a generic proxy and needs no change).
6. Write a BDD spec (`src/__tests__/<topic>/`) and / or a TDD unit test.

## See also

- `electron/shared/ipc-result.ts` — envelope source
- `safe-handle.ts` — `processIpcCall` is the pure / testable version, easy to unit-test without `ipcMain`
