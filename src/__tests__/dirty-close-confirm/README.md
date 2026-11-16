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
| `src/panels/Editor/autosave-failures.ts` | 按 tab 记录 autosave 失败态(`useAutoSave` 写入,计数与 DockShell 订阅) |
| `src/shell/dock/DockShell.tsx` | 脏态变化时上报;flush 请求带 `save` 时先保存,失败 toast 并回执 `saveFailed` |
| `electron/shared/i18n-locales/{en,zh,ko}.ts` | `dialog.unsaved_close.*` |

## 关键行为

### 无脏文件(与旧行为完全一致)

- 从未上报 / 脏数回到 0 → 点关闭不弹框,立即 hide + flush(请求 payload 仍是 `{ windowId }`)。
- 不受信 frame / 别的窗口发来的脏态上报被忽略。

### 关窗有脏文件

- 确认框挂在该窗口上(`dialog.showMessageBox(win, …)`),回答前不 hide、不 flush;框打开期间重复关闭不叠框。
- **取消** → 窗口保持打开;再次关闭会再次确认。
- **不保存** → 照旧 hide + flush 后关闭(请求带 `discard: true`,renderer 跳过最终脏检查)。
- **保存** → flush 请求带 `save: true`,renderer 先保存所有有路径的脏 tab 再 flush;
  回执 `saveFailed: true`、超时无回执或请求被跳过(renderer 未就绪 / send 抛错)→ 中止关闭、窗口重新显示
  (renderer 已 toast)。「不保存」时跳过仍照常关闭。

### 最终脏检查(统一规则)

「是否允许关闭」不再只取决于弹框前的脏计数。renderer 在 flush 握手里**全部** flush(批量保存、layout、explorer、
markdown autosave flush)完成后、回执之前,检查此刻仍 dirty 的 tab(有路径的都算,autosave 已 flush 过,仍脏的
`.md` 也算;untitled 计入,但本轮选「保存」时只剩 untitled 不算 —— 用户已被告知会丢弃)。本轮**未**选「不保存」
且仍有 → 回执带 `remaining: { dirty, untitled }`:

- main 中止本次关闭 / 退出,窗口重新显示,`quitGuard` 复位(与保存失败路径一致),并按 `remaining` 记账 →
  用户再次关闭时看到确认框。
- 覆盖:编辑 `.md` 后 2s 防抖内关窗、flush 中 autosave 首次失败;「保存」后慢 layout / explorer flush 期间继续
  输入;多窗退出时 B 的确认框打开期间在干净的 A 里改代码(A 收到非保存 flush)。
- 选「不保存」→ 照常关闭(行为不变)。

### 关闭流程代际

- 每窗关闭流程带代际。before-quit 接管窗口时递增;在途的旧单窗关闭流程(如「不保存」)完成时发现已被取代 →
  不置 flushed、不 `win.close()`(否则在退出的「保存」完成前销毁窗口),复位守卫并重新显示窗口。

### flush 请求 / 回执配对

- 每个 flush 请求带唯一 `requestId`,renderer 回执原样带回;main 按 requestId 结算,且仍校验受信 frame 与
  sender 窗口。单窗关闭与 Cmd+Q 交叉时两次请求互不覆盖,旧请求的回执不会结算新请求。
- 兼容不带 requestId 的旧回执:仅当该窗口恰有一个在途请求时接受。

### 退出应用(before-quit)

- 逐个有脏文件的主窗确认(一次一个框);任一**取消** → 中止整个退出,不 flush,守卫复位,再次 Cmd+Q 正常重新确认。
- 按各窗选择 flush;任一「保存」失败或回执 `remaining` → 中止退出、显示该窗口、守卫复位(不记 flushedOnQuit,之后关窗仍走确认)。
- popout 窗口不参与(与既有 flush 逻辑一致)。

### 计数口径(renderer)

- 计入:脏的代码文件 tab;untitled 草稿计入并单独计数(无路径,MVP 不支持另存为,「保存」时跳过,文案说明会被丢弃)。
- 不计入:Markdown 自动保存开启时的脏 `.md`(关窗 flush 经 `flushPendingAutoSave` 落盘);关闭该设置则计入。
- 例外:最近一次 autosave 失败(ENOSPC / EACCES / EDITOR_DISK_CHANGED)的脏 `.md` 计入 —— 失败后无 pending
  timer,flush 不会重试。失败态按 tab 记录(`src/panels/Editor/autosave-failures.ts`),变化时重新上报;再次成功后恢复排除。
  tab 从 editor store 消失(关闭 / 删除 / 重命名)即清除其记录;保存开始时取 epoch,其间有 tab 消失则丢弃迟到结果
  (不写入同路径重开的新实例)。
- 「保存」分支保存所有有路径的脏 tab(含 `.md`,无害);全部完成后复查,仍脏(保存期间继续输入)同样视为失败。
- 保存失败提示里,因磁盘已被外部修改(EDITOR_DISK_CHANGED)而未写的文件单独说明(引导 Cmd+S 解决冲突
  或选「不保存」;关窗流程不弹覆盖框),文案 `dialog.unsaved_close.disk_changed_note`。

## 规范文件

| 文件 | 覆盖 |
|---|---|
| `dirty-close-dialog.spec.ts` | main 纯函数:上报解析 / 是否弹框 / 按钮与文案 / 选择映射 / 回执解析 |
| `close-confirm-flow.spec.ts` | main 端到端握手(electron 全 mock):关窗各分支 + before-quit 取消 / 保存失败 / 回执 remaining 中止 / 关闭流程代际 / 成功退出 |
| `renderer-dirty-close.spec.ts` | renderer 纯函数:计数口径 / 批量保存失败计数 / 最终脏检查 / autosave 失败记录生命周期 |
| `dockshell-save-on-close.spec.tsx` | DockShell 脏态上报 + flush「保存」分支回执 + 最终脏检查回执 `remaining` |
| `../49-polish-bugfixes/quit-cleanup-guard-reentry.spec.ts` | 守卫 `cancel()` 复位 |
