# ADR-Plugin-4 · Plugins install to `userData`, not the workspace ("vault")

**Status**: Accepted (extracted from ContinuoWiki tutorial 08 §3.5).

## Context

Obsidian, the closest plugin-system inspiration, stores plugins **inside the user's vault** (`<vault>/.obsidian/plugins/<id>/`). Plugins are tied to a specific notes folder, and moving the vault moves the plugins with it.

Continuo's model is different. Continuo is not a notes app whose center of gravity is a single content folder; it's a multi-terminal agent substrate. Users may have many "workspace roots" (per-window), and may close all of them and still expect Continuo to function. Coupling plugin install location to a workspace would create awkward edge cases:

* No workspace open → no plugins available?

* Switching workspace → all plugins re-install / re-prompt for permissions?

* Two windows on two workspaces → one window has plugin X, the other doesn't?

## Decision

Plugin install root is the **app-level** `userData` directory, namespaced by app name:

* macOS: `~/Library/Application Support/Continuo/plugins/<id>/`

* Linux: `${XDG_CONFIG_HOME:-~/.config}/Continuo/plugins/<id>/`

* Windows: `%APPDATA%/Continuo/plugins/<id>/`

Resolved via `app.getPath('userData')` in main.

Per-plugin directory contents (Obsidian-compatible shape):

```
<id>/
  manifest.json       required (zod-validated)
  main.js             required (ESM entry, default name; overridable via manifest.main)
  styles.css          optional (auto-injected into renderer <head>)
  data.json           optional (loadData / saveData persistence)
  README.md           optional (rendered in Settings → Plugins)
```

Separately, `${userData}/plugins/_enabled.json` tracks which plugins are turned on. The leading underscore is significant: the plugin-directory scanner (`electron/main/services/plugins.service.ts › listPluginDirs`) explicitly skips entries whose name starts with `.` or `_`, which keeps this control file from being mistaken for a plugin install. Permission decisions are persisted per plugin (also under `userData`).

## Rationale

* **Plugins are user-installed tools, not workspace assets.** They belong to the user / machine, not the project.

* **Single source of truth for "what's installed."** No vault-switching confusion.

* **Workspace-portable**: opening the same workspace on another machine doesn't carry plugins. Users explicitly install on each machine — same as VSCode extensions, IDE settings, terminal shells.

* **Symmetry with Continuo's other app-level state** (window layouts live under `userData/explorer.json` per ADR-012; MCP socket lives under `userData/Continuo[/Dev]/mcp.sock`).

## Consequences

* Sharing a plugin "with a project" requires `git clone <plugin-repo>` and dropping into `userData/plugins/` — there is no per-workspace shortcut.

* A future "workspace-pinned plugin set" feature (project asks for plugins X, Y, Z) would need a separate manifest file at the workspace root and a UI flow — not a structural change to install location.

* Backups: users backing up Continuo state should back up `userData/Continuo/`, not their workspace folder.

## See also

* ContinuoWiki tutorial 08 §3.5 ("插件文件夹长什么样")

* `src/plugins/PluginManager.ts` (scans the `userData` plugins dir)

* ADR-012 (`explorer.json` is in the same `userData` neighborhood — same locality principle)

* ADR-Plugin-1 (`sandbox-sweep` runs against plugin code loaded from `userData`)

