# window-ipc-create

This BDD topic pins the main-process `createWindowHandler` (electron/main/ipc/window.ipc.ts:33-69, multi-window creation IPC entry). It is the sibling guard for topic-12 `window-workspace-roots-map`: topic-12 pins `NotifyRoot` + close listener in the same file; this topic pins `CREATE` handler. The two halves do not overlap.

Behavior contract checklist T1-T8:

T1 `createWindowHandler` rejects a relative `workspace` as `WORKSPACE_NOT_ABSOLUTE`;
T2 rejects a non-existent absolute path as `WORKSPACE_NOT_FOUND`;
T3 rejects an absolute path that is not a directory as `WORKSPACE_NOT_DIRECTORY`;
T4 with a valid absolute directory, allocates a `windowSeq`, calls `createMainWindow({windowSeq, workspace})`, and returns `{ok:true, data:{windowId}}`;
T5 without a `workspace` field, allocates a `windowSeq`, calls `createMainWindow({windowSeq})` (no `workspace` key), and returns `{ok:true, data:{windowId}}`;
T6 `CreateInput.strict()` rejects unknown fields as `IPC_BAD_INPUT` (safe-handle envelope);
T7 `workspace: ''` fails zod `.min(1)` as `IPC_BAD_INPUT` before reaching the absolute-path check;
T8 `INDEX.md` contains `window-ipc-create` after `pnpm bdd:index`.

The spec replays the mock pattern of topic-12 `notify-root-validation.spec.ts` (vi.hoisted electronMock + vi.mock chain for electron, electron/main/index, electron/main/persistence) and adds `vi.mock('node:fs')` to control `statSync`. The captured `ipcMain.handle` already wraps `createWindowHandler` through `safeHandle/processIpcCall`, so each case asserts the envelope-shaped `IpcResult` directly. The fake event passes `{sender, senderFrame: {url: 'file:///renderer/index.html'}}` so `defaultIsTrustedFrame` accepts it.

By scope, this topic does not modify any source file, does not touch topic-12 spec, and does not extract a shared helper.
