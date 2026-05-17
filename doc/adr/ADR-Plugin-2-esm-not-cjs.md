# ADR-Plugin-2 · Plugin modules are ESM, not CommonJS

**Status**: Accepted (extracted from ContinuoWiki tutorial 08 §3.1).

## Context

The plugin runtime needs to pick a module format for the JS file plugins ship (`manifest.main`, default `main.js`). The choice is essentially CommonJS (`require` / `module.exports`) vs ESM (`import` / `export`).

CommonJS has the legacy advantage that older Node tooling produces it by default. ESM has:

- `import.meta` (URL of the loaded module, environment introspection).
- Top-level `await`.
- A 1:1 mapping to what the rest of Continuo's source already uses (`"type": "module"` in `package.json`, electron-vite bundles ESM, the rest of `src/` is ESM).
- A cleaner story for tree-shaking and bundle analysis.

## Decision

**Plugin entrypoints are ESM.** Loading happens in two steps because plugin code must execute in the renderer realm (where the `CoApp` facade lives), not the main process:

1. **Main process** (`electron/main/services/plugins.service.ts › listPluginDirs`) reads `${pluginDir}/manifest.json` + the file named by `manifest.main` (default `main.js`) + optional `styles.css` from disk and ships the file *contents* over IPC to the renderer.
2. **Renderer** (`src/lib/plugins-host.ts` / `src/plugins/PluginManager.ts › activateEntry`) wraps the main source text in a `Blob` of MIME type `application/javascript`, calls `URL.createObjectURL(blob)` to mint a `blob:` URL, then `await import(/* @vite-ignore */ blobUrl)` to evaluate it. `mod.default` is the `Plugin` subclass; `new PluginClass(scopedApp, manifest)` then `await instance._activate()`.

The actual JS evaluation is `import(url)` — a real ESM dynamic import — just with `url` being a renderer-side `blob:` URL constructed from main-process file reads, not a filesystem path the renderer could read directly.

Plugin authors write:

```js
const { Plugin } = globalThis.co;
export default class MyPlugin extends Plugin { … }
```

Or in TypeScript (compiled to ESM):

```ts
import type { CoPluginApp, PluginManifest } from '@continuo/plugin-sdk';
export default class MyPlugin extends Plugin { … }
```

## Rationale

- **Symmetry with Continuo proper.** The host app is ESM-first; a CJS plugin layer would be the only CJS code in the renderer.
- **`import.meta` and top-level await** are useful enough for nontrivial plugins (dynamic dependency loading, async init) that giving them up has real cost.
- **No build-system requirement.** A trivial plugin can hand-author `main.js` as plain ESM without a bundler. Plugins with dependencies will use a bundler regardless of format — esbuild / Vite produce ESM by default.
- **`globalThis.co` namespace.** The plugin SDK exposes `Plugin`, `React`, `PermissionError`, and `z` (zod) on `globalThis.co` so plugins don't need to bundle these. Authors can `const { Plugin } = globalThis.co;` and avoid pulling React into the plugin bundle.

## Consequences

- Plugins compiled from CJS sources (older TypeScript / babel output) need a bundler that outputs ESM. Documented in the plugin author guide.
- The loader uses dynamic `import` rather than `require`; main thread doesn't need any CommonJS interop shim.
- File extension: prefer `.js` (or `.mjs` if the author insists). `manifest.main` defaults to `"main.js"`.
- Renderer-realm execution via Blob URL means the plugin cannot use Node-only ESM features (`node:fs`, etc.) — and shouldn't, since the sandbox-sweep (ADR-Plugin-1) is built on that boundary. Plugins reach back into Node only via the curated `CoApp` facade (ADR-Plugin-3).
- Source maps tied to a real file path don't survive the Blob URL round-trip; debugging plugin code in DevTools shows the blob URL, not the original `main.js` path. Acceptable for now (plugin authors generally have their own dev loop with their own source maps before they install the built bundle into Continuo).

## See also

- ContinuoWiki tutorial 08 §3.1 ("选型表" — language / isolation choice row)
- `src/plugins/PluginManager.ts` (dynamic import call site)
- `examples/sample-plugin/main.js` and `examples/mcp-demo-plugin/main.js` — both ESM
- ADR-Plugin-3 (`CoApp` facade reachable via `globalThis.co`)
