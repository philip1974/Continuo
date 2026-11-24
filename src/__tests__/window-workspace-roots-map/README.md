# window-workspace-roots-map

This BDD topic pins the main-process `windowId -> workspaceRoot` lookup table. It is the ingress-side sibling guard for topic-10 `terminal-session-ownership-leak`: topic-10 pins the terminal egress filter, while this topic pins the workspace-root source and lifecycle clear behavior.

Behavior contract checklist T1-T35:
T1 `setWorkspaceRoot` writes and `getWorkspaceRoot` reads the root;
T2 `setWorkspaceRoot(null)` deletes the mapping;
T3 multiple windows keep independent workspace roots;
T4a/T4b setting the same `windowId` replaces the root, and a cleared `windowId` can be rebuilt;
T5 `clearWindow` deletes the mapping;
T6 `_reset` clears all mappings;
T35 `isAnyWorkspaceRoot(path)` is true when `path` equals any window's current root (platform-aware via `isSameOrInsidePath`, trailing separator tolerated, Windows case-insensitive); the fs watcher pool uses it to pin roots against LRU eviction;
T7-T11 `NotifyRoot` IPC validates IPC_BAD_INPUT (shared IPC shell) / BAD_ROOT layering, accepts `null`, and accepts absolute roots;
T7b rejected `BAD_ROOT` calls emit `console.warn` (malformed input is rejected by the shared IPC shell as `IPC_BAD_INPUT` without logging);
T7c/T7d `{ ok: false }` includes a non-empty `message`, and the warning includes `winId`;
T16/T16b window `closed` clears the root map, and `windowId` reuse is safe;
T12-T15 `resolveTerminalCwd`(async, single `fs.promises.stat`, no sync fs on main) rejects on missing/invalid/non-directory cwd, resolves a valid absolute directory, and propagates through `makeCreateHandler`; T14b window destroyed during the async cwd check → `TERMINAL_CREATE_CANCELLED`, no session/token/PTY;
T18 IPC envelope via `processIpcCall` preserves `e.code`;
T25 `makeCreateSessionTool` rejects with `.code` preserved;
T26 `dispatchRpc tools/call` returns `error.code === -32603` and `error.data.code` for coded tool failures, asserting existing dispatcher behavior without modifying `mcp-host.service.ts`;
T17 `INDEX.md` contains `window-workspace-roots-map` after `pnpm bdd:index`;
T19-T21 renderer failure feedback: `TerminalPlugin` Cmd+T and `HeaderActions` both go through `createUserTerminal`, which reports failures via `notify.error`;
T27 `normalizeWorkspaceRoot('') === null`;
T28 `normalizeWorkspaceRoot('   ') === null`;
T28b `normalizeWorkspaceRoot('  /abs  ') === '  /abs  '`;
T29 `normalizeWorkspaceRoot('/abs') === '/abs'`;
T30-T33 `hydrateStores`, `hydrateStoresForNewWindow`, and `snapshotFromStores` apply root normalization and filter empty `recentRoots`;
T34 `input.cwd === ''` fails schema parsing as BAD_INPUT.

`normalizeWorkspaceRoot` maps empty strings, all-whitespace strings, and non-strings to `null`, and strips trailing path separators while keeping a root (`/home/u/proj/` → `/home/u/proj`, `/` and `C:\` unchanged) so the root matches child paths built by main's `path.join`. It does not trim whitespace: filesystems allow valid paths with leading or trailing spaces, for example `/tmp/proj `.
