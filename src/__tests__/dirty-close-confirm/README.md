# dirty-close-confirm

行为契约:**关闭窗口 / 退出应用时,窗口里有未保存的文件就先确认**(参考 VSCode「是否保存 N 个文件的更改?」
保存 / 不保存 / 取消)。代码文件不 autosave(ADR-015),此前关窗 / Cmd+Q 直接 flush 后关闭,脏 tab 静默丢失。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/dirty-close-confirm.ts` | 纯函数:解析 renderer 脏态上报、构造确认框(文案走 i18n catalog)、映射用户选择、解析 flush 回执 |
| `electron/main/index.ts` | `layout:dirty-state` 按窗口记账(受信 frame + sender 窗口);`wireWindowCloseFlush` / `before-quit` 在 flush 前确认;macOS `setDocumentEdited` |
| `electron/main/quit-cleanup-guard.ts` | `cancel()`:退出被中止后复位守卫,下次 Cmd+Q 重新确认 |
| `electron/preload/index.ts` | `layout.reportDirtyState` / `sendFlushAck(windowId, { saveFailed })` / flush 请求 payload `save` |
| `src/shell/dock/dirty-close.ts` | renderer 纯函数:关窗会丢的脏 tab 计数、「保存」分支批量保存 |
| `src/shell/dock/DockShell.tsx` | 脏态变化时上报;flush 请求带 `save` 时先保存,失败 toast 并回执 `saveFailed` |
| `electron/shared/i18n-locales/{en,zh,ko}.ts` | `dialog.unsaved_close.*` |

## 关键行为

### 无脏文件(与旧行为完全一致)

- 从未上报 / 脏数回到 0 → 点关闭不弹框,立即 hide + flush(请求 payload 仍是 `{ windowId }`)。
- 不受信 frame / 别的窗口发来的脏态上报被忽略。

### 关窗有脏文件

- 确认框挂在该窗口上(`dialog.showMessageBox(win, …)`),回答前不 hide、不 flush;框打开期间重复关闭不叠框。
- **取消** → 窗口保持打开;再次关闭会再次确认。
- **不保存** → 照旧 hide + flush 后关闭。
- **保存** → flush 请求带 `save: true`,renderer 先保存所有有路径的脏 tab 再 flush;
  回执 `saveFailed: true` 或超时无回执 → 中止关闭、窗口重新显示(renderer 已 toast)。

### 退出应用(before-quit)

- 逐个有脏文件的主窗确认(一次一个框);任一**取消** → 中止整个退出,不 flush,守卫复位,再次 Cmd+Q 正常重新确认。
- 按各窗选择 flush;任一「保存」失败 → 中止退出、显示该窗口、守卫复位(不记 flushedOnQuit,之后关窗仍走确认)。
- popout 窗口不参与(与既有 flush 逻辑一致)。

### 计数口径(renderer)

- 计入:脏的代码文件 tab;untitled 草稿计入并单独计数(无路径,MVP 不支持另存为,「保存」时跳过,文案说明会被丢弃)。
- 不计入:Markdown 自动保存开启时的脏 `.md`(关窗 flush 经 `flushPendingAutoSave` 落盘);关闭该设置则计入。
- 「保存」分支保存所有有路径的脏 tab(含 `.md`,无害)。

## 规范文件

| 文件 | 覆盖 |
|---|---|
| `dirty-close-dialog.spec.ts` | main 纯函数:上报解析 / 是否弹框 / 按钮与文案 / 选择映射 / 回执解析 |
| `close-confirm-flow.spec.ts` | main 端到端握手(electron 全 mock):关窗各分支 + before-quit 取消 / 保存失败 / 成功退出 |
| `renderer-dirty-close.spec.ts` | renderer 纯函数:计数口径 / 批量保存失败计数 |
| `dockshell-save-on-close.spec.tsx` | DockShell 脏态上报 + flush「保存」分支回执 |
| `../49-polish-bugfixes/quit-cleanup-guard-reentry.spec.ts` | 守卫 `cancel()` 复位 |
