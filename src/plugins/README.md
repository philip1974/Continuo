# `src/plugins/` — Plugin SDK

The Continuo plugin SDK. Plugins are external code (JavaScript / TypeScript compiled to ESM) loaded from `${userData}/plugins/<id>/` at runtime. The SDK gives them a scoped `CoApp` facade, declarative manifest permissions, and disposable-LIFO lifecycle hygiene.

> Continuo deliberately does **not** sandbox plugins in a Web Worker (Obsidian-style decision — see `doc/adr/ADR-Plugin-1-no-sandbox.md`). Trust comes from manifest permissions + the `sandbox-sweep` hardening (`globalThis.fetch` / `XMLHttpRequest` / `node:fs` etc. are removed from plugin scope so they have to go through `app.fs.*`, `app.network.fetch`, …).

## Key files

| File | Role |
|---|---|
| `Plugin.ts` | Abstract base class plugins extend. Owns disposable LIFO + lifecycle (`_activate` / `_deactivate`) and exposes the contribution-point proxies. |
| `manifest.ts` | Zod schema for `manifest.json` + SemVer compatibility check. Returns `{ok, code, message}` (never throws). |
| `permissions.ts` | The 5 `PermissionKey`s, `PermissionStore` interface, `ensureAuthorized()` (supports partial grants). |
| `co-app.ts` | The full `CoApp` facade (host-side view). |
| `scoped-app.ts` | Per-plugin scoped wrapper (wraps `fs` / `network` / `clipboard` / `shell` calls with permission gating). |
| `sandbox-sweep.ts` | Removes ambient browser/node APIs from plugin globals so plugins must use the scoped facade. |
| `PluginManager.ts` | Plugin lifecycle: install → load manifest → ensure permissions → import main → activate. |
| `permissions/` | Permission UI: prompt modal + per-plugin editor. |
| `registries/` | One registry per contribution point (panels, commands, status-bar, ribbon, settings, editor actions, explorer decorators / context-menu, MCP tools). |
| `plugin-mcp-invoke-bridge.ts` + `plugin-mcp-upstream.ts` | The IPC bridge that lets a renderer-side plugin register an MCP tool that an external agent (Claude Code, Codex CLI) can invoke through the main-process MCP host. |
| `command-palette/` `keybindings/` `quick-open/` `settings/` `protocol/` | Bundled first-party plugins / infrastructure. |

## Contribution points (11)

A `Plugin` subclass calls these from inside `onload()`. Each returns a `Disposable` (auto-collected; LIFO-disposed on `_deactivate`).

| Method on `Plugin` | What it contributes |
|---|---|
| `registerPanel(spec)` | A dockview panel component the user / agent can open. |
| `addCommand(spec)` | A command + optional hotkey; surfaces in the command palette. |
| `addStatusBarItem(spec)` | A status-bar segment (left or right side, with priority). |
| `addRibbonAction(spec)` | A clickable icon in the IconSidebar ribbon. |
| `registerEvent(spec)` | Subscribe to a named event on the global event bus. |
| `addSettingTab(spec)` | A whole tab in the Settings modal. |
| `addSettingItem(spec)` | A single setting row (composes inside an existing tab). |
| `registerExplorerDecorator(fn)` | Override file icon / badge / tooltip in the Explorer tree. |
| `registerEditorAction(spec)` | An action that appears in the editor toolbar when its `when` predicate matches. |
| `registerExplorerContextMenuItem(spec)` | An item in the Explorer right-click menu. |
| `registerMcpTool(spec)` | Expose a tool to external agents via MCP (requires the `mcp-tools` permission). |

Plus persistence helpers `loadData<T>()` / `saveData(data)` — JSON-serializable per-plugin storage, no permission required (it's the plugin's own data dir).

## Permission keys (5)

Declared in `manifest.json` `permissions` array; gated at runtime inside `scoped-app.ts`:

- `fs` — `app.fs.*` (`listDir`, `readFile`, `writeFile`, …)
- `network` — `app.network.fetch(url)`
- `shell` — `app.shell.exec(cmd, args)` (one-shot, non-interactive)
- `clipboard` — `app.clipboard.readText` / `writeText`
- `mcp-tools` — `app.mcp.register(spec)` (expose tool to agents)

Authorization rules live in `permissions.ts › ensureAuthorized()`. Partial grants are first-class: a plugin can be activated with some permissions granted and others denied; calls to denied capabilities throw `PermissionError` so plugin authors are expected to `try/catch` and degrade gracefully.

## Lifecycle (disposable LIFO)

```
PluginManager.activate(p)
  → p._activate()
      → p.onload()                ← plugin code; collects disposables via this.register(d)
      → onload throws?
          → LIFO-dispose collected, mark `disposed`, rethrow
PluginManager.deactivate(p)
  → p._deactivate()
      → LIFO-dispose all collected disposables
      → call p.onunload() if defined
```

Late `register()` calls (after deactivate) immediately dispose the passed `Disposable` so nothing leaks into a registry that would survive the plugin.

## Hello-world plugin (~20 lines)

`examples/sample-plugin/main.js` is the canonical demo (lots of contribution points). The minimum useful plugin is much smaller:

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

Drop both into `${userData}/plugins/com.example.hello/`, restart Continuo, enable in Settings → Plugins.

## See also

- `examples/sample-plugin/` — most contribution points exercised in one file
- `examples/mcp-demo-plugin/` — plugin that registers MCP tools for agents
- `src/marketplace/README.md` — how plugins get listed & installed
- ADRs: `doc/adr/ADR-Plugin-1-no-sandbox.md`, `ADR-Plugin-2-esm-not-cjs.md`, `ADR-Plugin-3-coapp-not-windowapi.md`, `ADR-Plugin-4-plugins-userdata.md`
- ContinuoWiki tutorial 08 (plugin contributions) + tutorial 10 (plugin permissions) — deeper rationale & history
