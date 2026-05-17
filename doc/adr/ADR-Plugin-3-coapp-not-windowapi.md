# ADR-Plugin-3 · Plugins see `CoApp`, not raw `window.api`

**Status**: Accepted (extracted from ContinuoWiki tutorial 08 §3.4, tutorial 10 §3.3).

## Context

The preload bridge (`electron/preload/index.ts`) exposes a single object on the renderer's global scope. Originally named `window.api`; renamed to `window.__lmApi` in Phase 4.B as part of the sandbox-sweep hardening (ADR-Plugin-1).

This object carries the **full** IPC surface: fs, terminal, shell, layout, popout, window-mgmt, MCP host, plugin-MCP bridge, agent-auth, notify, plugins-management. Some of those (e.g. `plugins.install`, `window.create`) are internal kernel operations that no plugin has any business calling.

Plugins also need their calls to be **gated** by the per-plugin permission decisions (ADR-Plugin-1). A handle that points straight to `window.__lmApi.fs.readFile` skips every gate.

A third concern: the plugin SDK is a candidate for re-use across other agent-substrate projects (Nous, future targets). Coupling plugin code to `window.api` (an Electron-specific shape) freezes the SDK to one host.

## Decision

Plugins receive a **`CoApp` / `CoPluginApp` facade** — never `window.api` / `window.__lmApi` directly.

- The facade exposes a curated subset: `fs`, `network`, `clipboard`, `shell` (permission-gated), plus contribution-point registries (`panels`, `commands`, `statusBar`, `ribbon`, `events`, `settingTabs`, `settingItems`, `explorerDecorators`, `editorActions`, `explorerContextMenu`, `mcp`) and host info (`version`, `dataStore`).
- **Per-plugin scoping**: each plugin gets its own `ScopedApp` (built by `createScopedApp(coApp, pluginId, permissionStore)`). The scoped wrapper carries the `pluginId` so `ensurePerm` knows whose grants to consult on every `fs.*` / `network.fetch` / `clipboard.*` / `shell.exec` call.
- **Globally**: `globalThis.co.Plugin` (the abstract class) + `React` + `PermissionError` + `z` are exposed for ergonomic destructuring; plugins don't bundle React.

## Rationale

1. **Kernel/plugin separation.** The kernel can change its IPC shape without touching plugins as long as the `CoApp` facade is stable.
2. **Permission gating is enforceable.** A plugin cannot reach `window.api.fs.*` because the entry sweep removes the original name and the curated `app.fs.*` is the only documented path. ScopedApp injects the gate.
3. **SDK portability.** A future Nous bridge can implement the same `CoApp` shape over a different transport. Plugins written today can run there without modification.
4. **Documentation surface stays small.** Plugin authors learn `app.*`, not the entire IPC namespace.

## Consequences

- The `CoApp` facade is now load-bearing API. Breaking it = breaking every plugin. Treat as semver.
- A plugin that genuinely needs a not-yet-exposed capability must petition for the facade to grow — not reach around it. This is the intended pressure.
- The `globalThis.co` namespace is part of the contract too (sample plugins use `const { Plugin } = globalThis.co`).

## See also

- ContinuoWiki tutorial 08 §3.4 ("CoApp：Plugin 能拿到什么")
- ContinuoWiki tutorial 10 §3.3 (ScopedApp scoping)
- `src/plugins/co-app.ts`, `src/plugins/scoped-app.ts`
- `src/plugins/Plugin.ts` (consumes `CoPluginApp` only)
- ADR-Plugin-1 (entry sweep makes this enforceable)
