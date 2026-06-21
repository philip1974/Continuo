# `electron/main/` — Main process (IPC + services)

The Electron main-process side of Continuo. Owns the OS-level surface (file system, child processes, PTYs, native windows, MCP socket) and exposes a narrow IPC contract to the renderer + preload.

## Layout

| Path | Role |
|---|---|
| `index.ts` | Main-process entry. Creates windows, wires services, registers IPC handlers. |
| `ipc.ts` | Aggregate registration: pulls each `ipc/<area>.ipc.ts` and calls its `register…` function. |
| `safe-handle.ts` | The `safeHandle` / `safeHandleWithCtx` wrappers — every IPC channel goes through these. |
| `persistence.ts` | Atomic write helpers (path → temp → write → fsync → rename) — see ADR-009. |
| `lib/` | Pure helpers reused across services (no Electron deps). |
| `services/` | Long-lived stateful services (PTY pool, MCP host, plugin bridge, agent-auth, window-seq, window-restore, …). |
| `ipc/` | One file per channel-namespace; each exports a `register…Ipc(…)` that calls `safeHandle` per channel. |

`electron/shared/` (sibling) holds the channel-constant + envelope code that both main and preload import; it's the canonical IPC schema source.

## IPC contract — `IpcResult<T>`

Every `ipcMain.handle` channel returns this envelope (see `electron/shared/ipc-result.ts`, ADR-010):

```ts
type IpcResult<T> =
  | { ok: true;  data: T }
  | { ok: false; code: string; message: string };
```

The renderer (via `coApi` in `src/lib/co-api.ts`) gets the envelope back and branches on `ok`. Handlers **never throw** out the wire — `safeHandle` catches anything thrown, normalizes it to `{ ok: false, code, message }`, and surfaces it. Infrastructure codes live in `IPC_ERR` (`IPC_DENIED` / `IPC_BAD_INPUT` / `IPC_HANDLER_ERROR`); business handlers can `throw { code: 'MY_BUSINESS_CODE', message }` to attach a custom code.

## `safeHandle` — the only way to register an IPC

```ts
safeHandle(channel, zodSchema, handler, isTrustedFrame);
```

Does three things every channel must do:

1. **Trust check** — `defaultIsTrustedFrame` accepts only the **真实 renderer 入口 index.html** `file://` URL (prod，精确 pathname，由 index.ts 启动 `setTrustedRendererFile` 注册) or the `ELECTRON_RENDERER_URL` origin (dev). Anything else — 任意其它 `file://`(攻击者写的 evil.html / 插件目录 html)、injected iframe、外站 — is refused with `IPC_DENIED`。这同时是 windowOpenHandler 注入 preload 的放行条件(安全 S1:防恶意 `file://` 弹窗拿全量 IPC)。
2. **Zod validation** — invalid input → `IPC_BAD_INPUT`, never reaches the handler body.
3. **Error envelope** — handler exceptions get caught and shaped into `IpcFail`.

Use `safeHandleWithCtx` when the handler needs the raw `IpcMainInvokeEvent` (typically to look up the sender window via `BrowserWindow.fromWebContents(event.sender)`).

## Channel namespaces

Each lives in `electron/shared/*-channels.ts` and is registered by `electron/main/ipc/<area>.ipc.ts`:

| Namespace | File | Purpose |
|---|---|---|
| `FS_CHANNELS` | `fs-channels.ts` / `fs.ipc.ts` | File system: list/read/write/rename/remove/move/copy + atomic write |
| `TERMINAL_CHANNELS` | `terminal-channels.ts` / `terminal.ipc.ts` | Interactive PTY sessions (xterm renderer ↔ node-pty) |
| `SHELL_CHANNELS` | `shell-channels.ts` / `shell.ipc.ts` | One-shot, non-interactive shell exec (buffered output) |
| `WINDOW_CHANNELS` | `window-channels.ts` / `window.ipc.ts` | Window create / popout / focus / workspace-root binding |
| `MCP_CHANNELS` | `mcp-channels.ts` | MCP host lifecycle (used by `mcp-stdio-server.service.ts`) |
| `PLUGINS_CHANNELS` | `plugins-channels.ts` / `plugins.ipc.ts` | Plugin manager: list / install / enable / disable / permissions |
| `PLUGIN_MCP_CHANNELS` | `plugin-mcp-channels.ts` | Renderer plugin ↔ main MCP host bridge (plugin registers tool, agent invokes it) |
| `NOTIFY_CHANNELS` | `notify-channels.ts` / `notify.ipc.ts` | Main → renderer push (toasts etc.) |
| `AGENT_AUTH_CHANNELS` | `agent-auth-channels.ts` | Reverse IPC: main asks renderer to authorize an agent MCP request |

## Services worth knowing

- `terminal-sessions.service.ts` — single source of truth for PTYs. Broadcasts `sessions_changed` to all renderer windows; per-window filtering is done by `window-workspace-roots.service.ts` + the renderer-side reconciler.
- `mcp-host.service.ts` + `mcp-stdio-server.service.ts` + `mcp-tools-terminal.ts` + `mcp-terminal-host.ts` — the MCP server. Exposes the 7 `terminal.*` tools (`list_sessions` / `create_session` / `send_input` / `send_text` / `press_key` / `read_output` / `kill`); per-window scoping via the `_continuo/hello` handshake from `scripts/continuo-mcp-stdio.mjs`.
- `plugin-mcp-bridge.service.ts` — lets renderer plugins register MCP tools the MCP host then exposes upstream.
- `agent-auth.service.ts` — reverse-IPC channel for "the agent is asking to do X, do you allow?". Routes to the *owner* window only (issue #32 fix), with destroyed-window fallback.
- `window-seq.service.ts` + `window-restore.service.ts` + `window-workspace-roots.service.ts` — per-window identity / layout restoration / cwd resolution.

## Adding a new IPC channel (recipe)

1. Add the channel constant in `electron/shared/<area>-channels.ts`.
2. Define a Zod schema for the input (export it from the same file so preload + renderer can re-derive types).
3. Write the handler as a pure function — input → output (throw for failure, attach `.code` for non-default error codes).
4. In `electron/main/ipc/<area>.ipc.ts`, call `safeHandle(CHANNEL, schema, handler, defaultIsTrustedFrame)` from the register function.
5. Add the renderer-side surface to `src/lib/co-api.ts` (the `Proxy`-based facade).
6. Write a BDD spec (`src/__tests__/<topic>/`) and / or a TDD unit test.

## See also

- `electron/shared/ipc-result.ts` — envelope source
- `safe-handle.ts` — `processIpcCall` is the pure / testable version, easy to unit-test without `ipcMain`
- ADRs: `doc/adr/ADR-009-atomic-write.md`, `ADR-010-ipc-result-envelope.md`
- ContinuoWiki tutorial 01 (three-rooms model) + tutorial 06 (IPC envelope) — design rationale
