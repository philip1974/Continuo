# window-workspace-roots-map

This BDD topic pins the main-process `windowId -> workspaceRoot` lookup table. It is the ingress-side sibling guard for topic-10 `terminal-session-ownership-leak`: topic-10 pins the terminal egress filter, while this topic pins the workspace-root source and lifecycle clear behavior.

Behavior contract checklist T1-T34:
T1 `setWorkspaceRoot` writes and `getWorkspaceRoot` reads the root;
T2 `setWorkspaceRoot(null)` deletes the mapping;
T3 multiple windows keep independent workspace roots;
T4a/T4b setting the same `windowId` replaces the root, and a cleared `windowId` can be rebuilt;
T5 `clearWindow` deletes the mapping;
T6 `_reset` clears all mappings;
T7-T11 `NotifyRoot` IPC validates BAD_INPUT/BAD_ROOT layering, accepts `null`, and accepts absolute roots;
T7b rejected `NotifyRoot` calls emit `console.warn`;
T7c/T7d `{ ok: false }` includes a non-empty `message`, and the warning includes `winId`;
T16/T16b window `closed` clears the root map, and `windowId` reuse is safe;
T12-T15 `resolveTerminalCwd` direct calls throw on missing/invalid cwd, return a valid absolute directory, and propagate through `makeCreateHandler`;
T18 IPC envelope via `processIpcCall` preserves `e.code`;
T25 `makeCreateSessionTool` rejects with `.code` preserved;
T26 `dispatchRpc tools/call` returns `error.code === -32603` and `error.data.code` for coded tool failures, asserting existing dispatcher behavior without modifying `mcp-host.service.ts`;
T17 `INDEX.md` contains `window-workspace-roots-map` after `pnpm bdd:index`;
T19-T21 renderer failure feedback shows an alert for `TerminalPlugin` Cmd+T and the direct `coApi.terminal.create` path in `HeaderActions`;
T27 `normalizeWorkspaceRoot('') === null`;
T28 `normalizeWorkspaceRoot('   ') === null`;
T28b `normalizeWorkspaceRoot('  /abs  ') === '  /abs  '`;
T29 `normalizeWorkspaceRoot('/abs') === '/abs'`;
T30-T33 `hydrateStores`, `hydrateStoresForNewWindow`, and `snapshotFromStores` apply root normalization and filter empty `recentRoots`;
T34 `input.cwd === ''` fails schema parsing as BAD_INPUT.

`normalizeWorkspaceRoot` does not normalize filesystem path semantics and does not trim the returned value. It only maps empty strings, all-whitespace strings, and non-strings to `null`. Filesystems allow valid paths with leading or trailing spaces, for example `/tmp/proj `.
