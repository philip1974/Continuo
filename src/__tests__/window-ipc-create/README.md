# window-ipc-create

This BDD topic pins the main-process `createWindowHandler` (`createWindowHandler` in electron/main/ipc/window.ipc.ts, multi-window creation IPC entry). It is the sibling guard for topic-12 `window-workspace-roots-map`: topic-12 pins `NotifyRoot` + close listener in the same file; this topic pins `CREATE` handler. The two halves do not overlap.

Behavior contract checklist T1-T8:

T1 `createWindowHandler` rejects a relative `workspace` as `WORKSPACE_NOT_ABSOLUTE`;
T2 rejects a non-existent absolute path as `WORKSPACE_NOT_FOUND`;
T3 rejects an absolute path that is not a directory as `WORKSPACE_NOT_DIRECTORY`;
T4 with a valid absolute directory, allocates a `windowSeq`, calls `createMainWindow({windowSeq, workspace})`, and returns `{ok:true}` (no data);
T5 without a `workspace` field, allocates a `windowSeq`, calls `createMainWindow({windowSeq})` (no `workspace` key), and returns `{ok:true}` (no data);
T6 `CreateInput.strict()` rejects unknown fields as `IPC_BAD_INPUT` (safe-handle envelope);
T7 `workspace: ''` fails zod `.min(1)` as `IPC_BAD_INPUT` before reaching the absolute-path check;
T8 `INDEX.md` contains `window-ipc-create` after `pnpm bdd:index`;
T9 the workspace directory check uses async `fs.promises.stat`, never sync `statSync` (a slow / disconnected mount must not freeze the whole main process).

The spec replays the mock pattern of topic-12 `notify-root-validation.spec.ts` (vi.hoisted electronMock + vi.mock chain for electron, electron/main/index, electron/main/persistence) and adds `vi.mock('node:fs')` to control `promises.stat` (sync `statSync` is mocked to throw). The captured `ipcMain.handle` already wraps `createWindowHandler` through `safeHandle/processIpcCall`, so each case asserts the envelope-shaped `IpcResult` directly. The fake event passes `{sender, senderFrame: {url: 'file:///renderer/index.html'}}` so `defaultIsTrustedFrame` accepts it.

By scope, this topic does not modify any source file, does not touch topic-12 spec, and does not extract a shared helper.

## Window count cap (audit F4)

`window:create` (renderer-initiated: "New Window" / "Open Folder in New Window") had no upper bound; a third-party plugin
looping `app.commands.execute('window.new')` reloads itself in every new window → exponential window growth. The handler
now rejects with `TOO_MANY_WINDOWS` once main windows (registered windowSeqs, plus creations in flight) reach
`MAX_APP_WINDOWS` (32). Startup restore (opt-in, ≤16) and OS-level "open folder" paths do not go through this handler.

`window-count-cap.spec.ts` (source-changing, separate from the BDD-only spec above): 100 concurrent creates → exactly 32
main windows (101 before the fix), the rest `TOO_MANY_WINDOWS`; closing a window frees a slot.
