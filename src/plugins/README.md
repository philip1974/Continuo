# `src/plugins/` — Plugin SDK

The Continuo plugin SDK. Plugins are external code (JavaScript / TypeScript compiled to ESM) loaded from `${userData}/plugins/<id>/` at runtime. The SDK gives them a scoped `CoApp` facade, declarative manifest permissions, and disposable-LIFO lifecycle hygiene.

> Continuo deliberately does **not** sandbox plugins in a Web Worker (an Obsidian-style decision). Plugins run in the same JavaScript realm as the app, so **the permission system is a contract for well-behaved plugins, not a security boundary — only install plugins you trust.** Manifest permissions gate the scoped `CoApp` APIs (`app.fs.*`, `app.network.fetch`, …), and in production builds `sandbox-sweep` removes `globalThis.fetch`, `navigator.clipboard`, and `window.api` before plugins load. That sweep is best-effort hardening: other web APIs (e.g. `XMLHttpRequest`, `WebSocket`) are not removed, and dev builds skip it.

## Key files

| File | Role |
|---|---|
| `Plugin.ts` | Abstract base class plugins extend. Owns disposable LIFO + lifecycle (`_activate` / `_deactivate`) and exposes the contribution-point proxies. |
| `manifest.ts` | Re-exports the manifest schema, `parseManifest` (returns `{ok, code, message}`, never throws) and the SemVer check from `electron/shared/plugin-manifest.ts`. |
| `permissions.ts` | The 5 `PermissionKey`s, `PermissionStore` interface, `ensureAuthorized()` (supports partial grants). |
| `co-app.ts` | The full `CoApp` facade (host-side view). |
| `scoped-app.ts` | Per-plugin scoped wrapper (wraps `fs` / `network` / `clipboard` / `shell` calls with permission gating). |
| `sandbox-sweep.ts` | In production builds, removes `fetch`, `navigator.clipboard` and `window.api` from the page before plugins load (best-effort; see the note above). |
| `PluginManager.ts` | Plugin lifecycle in the renderer: load manifest → ensure permissions → import main → activate (installing/cloning is done by the main process, `plugins.service.ts`). |
| `permissions/` | Permission UI: prompt modal + per-plugin editor. |
| `registries/` | One registry per contribution point (panels, commands, status-bar, ribbon, settings, editor actions, explorer decorators / context-menu, MCP tools). |
| `plugin-mcp-invoke-bridge.ts` + `plugin-mcp-upstream.ts` | The IPC bridge that lets a renderer-side plugin register an MCP tool that an agent (Claude Code, Codex CLI) running in a Continuo terminal of the same window can invoke through the main-process MCP host. |
| `command-palette/` `keybindings/` `quick-open/` `settings/` `protocol/` | Infrastructure for built-in features (the built-in plugins themselves live in `src/core-plugins/`). |

## Contribution points (11)

A `Plugin` subclass calls these from inside `onload()`. Each returns a `Disposable` (auto-collected; LIFO-disposed on `_deactivate`) — except `registerMcpTool`, which is async and returns `Promise<Disposable>`.

| Method on `Plugin` | What it contributes |
|---|---|
| `registerPanel(spec)` | A dockview panel type that the user (header "more" menu) or the plugin itself (`app.dock.openPanel(id)`) can open. |
| `addCommand(spec)` | A command + optional hotkey; surfaces in the command palette. |
| `addStatusBarItem(spec)` | A status-bar segment (left or right side, with priority). |
| `addRibbonAction(spec)` | A clickable icon in the IconSidebar ribbon. |
| `registerEvent(spec)` | Subscribe to a named event on the global event bus. |
| `addSettingTab(spec)` | A whole tab in the Settings panel. |
| `addSettingItem(spec)` | A single setting row (composes inside an existing tab). |
| `registerExplorerDecorator(fn)` | Override file icon / badge / tooltip in the Explorer tree. |
| `registerEditorAction(spec)` | An action that appears in the editor toolbar when its `when` predicate matches. |
| `registerExplorerContextMenuItem(spec)` | An item in the Explorer right-click menu. `ctx.target.size` / `mtime` / `ctime` are a snapshot from when the directory was listed and may be stale (content-only changes do not re-list); call `app.fs.stat(path)` for current values. |
| `registerMcpTool(spec)` | Expose a tool via MCP to agents running in a Continuo terminal of the same window (requires the `mcp-tools` permission). Async — `await` it. |

Plus persistence helpers `loadData<T>()` / `saveData(data)` — JSON-serializable per-plugin storage, no permission required (it's the plugin's own data dir).

## Permission keys (5)

Declared in `manifest.json` `permissions` array; gated at runtime inside `scoped-app.ts`:

- `fs` — `app.fs.*` (`listDir`, `readFile`, `writeFile`, …). The permission alone is not enough: call `app.fs.requestScope(...)` first; paths outside a granted scope are rejected by the main process.
- `network` — `app.network.fetch(url)`
- `shell` — `app.shell.exec(cmd, args)` (one-shot, non-interactive) and `app.shell.execStream(...)` (streaming)
- `clipboard` — `app.clipboard.readText` / `writeText`
- `mcp-tools` — `app.mcp.register(spec)` (expose tool to agents)

Authorization rules live in `permissions.ts › ensureAuthorized()`. Partial grants are first-class: a plugin can be activated with some permissions granted and others denied; calls to denied capabilities throw `PermissionError` so plugin authors are expected to `try/catch` and degrade gracefully.

## Lifecycle (disposable LIFO)

```
PluginManager.enable(id)
  → p._activate()
      → p.onload()                ← plugin code; collects disposables via this.register(d)
      → onload throws?
          → LIFO-dispose collected, mark `disposed`, rethrow
PluginManager.disable(id)
  → p._deactivate()
      → LIFO-dispose all collected disposables
      → call p.onunload() if defined
```

Late `register()` calls (after deactivate) immediately dispose the passed `Disposable` so nothing leaks into a registry that would survive the plugin.

## Hello-world plugin (~20 lines)

Plugins get their runtime from `globalThis.co`: `Plugin`, `React`, `PermissionError`, and `z` — a **zod 3 API** (the app itself uses zod 4; `co.z` comes from zod's `zod/v3` entry so existing plugins keep working). Use `co.z` for MCP tool `inputSchema`s rather than bundling your own zod.

For complete real-world plugins see [continuo-git-changes-viewer-plugin](https://github.com/philip1974/continuo-git-changes-viewer-plugin) and [continuo-skills-manager-plugin](https://github.com/philip1974/continuo-skills-manager-plugin). The minimum useful plugin is much smaller:

```js
const { Plugin } = globalThis.co;

export default class HelloPlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: 'hello.world',
      title: 'Hello World',
      hotkey: 'mod+shift+h',
      fn: () => alert(`Hello from ${this.manifest.name}`),
    });
  }
}
```

With this `manifest.json`:

```json
{
  "id": "com.example.hello",
  "name": "Hello",
  "version": "0.1.0",
  "main": "main.js",
  "minLMVersion": "0.1.0"
}
```

`minLMVersion` is the minimum Continuo app version the plugin needs (the field keeps the project's old working name).

Drop both into `<userData>/plugins/com.example.hello/`, restart Continuo, and enable it in Settings → Plugins. `<userData>` is `Continuo` (installed app) or `Continuo Dev` (`pnpm dev`) under the OS app-data folder — e.g. `~/Library/Application Support/Continuo Dev/` on macOS, `%APPDATA%\Continuo Dev\` on Windows, `~/.config/Continuo Dev/` on Linux.

## See also

- [continuo-git-changes-viewer-plugin](https://github.com/philip1974/continuo-git-changes-viewer-plugin) / [continuo-skills-manager-plugin](https://github.com/philip1974/continuo-skills-manager-plugin) — published plugins built on this SDK
- `src/marketplace/README.md` — how plugins get listed & installed
