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
| `output/` | Output channels (`app.output`, the Output panel's data) and routing plugin errors into them. |
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
| `registerPanel(spec)` | A dockview panel type that the user (header "more" menu) or the plugin itself (`app.dock.openPanel(id)`) can open. Singleton by default (panel id = type, the menu focuses an existing one); set `multiInstance: true` to let the menu open several. |
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

## Packaging: one ESM file

The entry (`main`, default `main.js`) is loaded as a **single ES module** from memory, so it cannot `import` other files or packages: `import './util.js'` / `import 'lodash'` fail with an "imports … must be bundled into a single ESM file" error. Bundle the plugin and its dependencies into one file, and keep the runtime from `globalThis.co` external (don't bundle React — use `co.React`):

```sh
# esbuild
esbuild src/main.ts --bundle --format=esm --platform=browser --target=es2022 --sourcemap --outfile=dist/main.js
```

```js
// vite.config.js (library mode)
export default {
  build: {
    lib: { entry: 'src/main.ts', formats: ['es'], fileName: () => 'main.js' },
    sourcemap: true,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
};
```

Then point `"main": "dist/main.js"` at the output. A `//# sourceMappingURL=main.js.map` comment next to the bundle is supported (the map must live inside the plugin folder, ≤ 16 MiB; embed `sourcesContent`, which both tools do by default).

Calling a capability whose permission is not in `manifest.json` `permissions` throws a `PermissionError` with `code: 'PERMISSION_NOT_DECLARED'` (the message says what to add); a declared permission the user denied throws `code: 'PERMISSION_DENIED'`.

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

Drop both into `<userData>/plugins/com.example.hello/` (the folder name must equal the manifest `id`) and enable it in Settings → Plugins — no restart needed: Continuo watches the plugins folder and picks up new plugins, fixed manifests and edited entry files while it runs. A plugin that cannot be loaded (invalid `manifest.json`, `minLMVersion` too high, folder name ≠ `id`, missing entry file) shows up in Settings → Plugins as an **invalid** row with the field-level reason, plus a one-time notification. `<userData>` is `continuo` (installed app; lowercase — it is the package name) or `Continuo Dev` (`pnpm dev`) under the OS app-data folder — e.g. `~/Library/Application Support/continuo/` / `~/Library/Application Support/Continuo Dev/` on macOS, `%APPDATA%\continuo\` on Windows, `~/.config/continuo/` on Linux.

## Debugging

- **Plugin output.** Every plugin has an output channel named after the plugin. Continuo writes the plugin's activation failures, why it was not loaded (invalid manifest, missing entry, …) and its uncaught errors / unhandled rejections there; the plugin writes its own log with `this.app.output.appendLine('…')` (`append`, `clear`, `show()` to reveal it; `this.app.output.createOutputChannel(name)` for extra channels, removed when the plugin is disabled). Open it with the **Show Output** command (⇧⌘U / Ctrl+Shift+U) and pick the channel from the dropdown; the panel keeps the last 10,000 lines per channel, has **Clear Output** and an auto-scroll lock (scrolling up locks it, scrolling back to the bottom unlocks). `console.log` is not mirrored into the channel — plugins run in the window's renderer, so it goes straight to the DevTools console.
- **DevTools.** **View › Toggle Developer Tools** opens Chromium DevTools for the window. The entry appears in the Sources tree as `continuo-plugin://<id>/<main>` (a stable name: stack traces show it, and breakpoints set there survive reloads). A `debugger;` statement pauses there while DevTools is open.
- **Source maps.** Ship `//# sourceMappingURL=main.js.map` (a file next to the bundle, inside the plugin folder) or an inline `data:` map; Continuo inlines the file map when it loads the entry, so DevTools shows your original sources (embed `sourcesContent`).
- **Errors with locations.** Load and activation errors in Settings → Plugins and in the notification carry `file:line:column` (syntax errors are located without running the code).
- **Hot reload.** Saving the entry file (or `manifest.json`) reloads the plugin in every window: `onunload` runs, then the new code's `onload`. **Reload** on the plugin row does the same on demand. New plugin folders and fixed manifests are picked up without restarting.

## See also

- [continuo-git-changes-viewer-plugin](https://github.com/philip1974/continuo-git-changes-viewer-plugin) / [continuo-skills-manager-plugin](https://github.com/philip1974/continuo-skills-manager-plugin) — published plugins built on this SDK
- `src/marketplace/README.md` — how plugins get listed & installed
