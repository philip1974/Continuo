# dirty-close-confirm

行为契约:**关闭窗口 / 退出应用时,窗口里有未保存的文件就先确认**(参考 VSCode「是否保存 N 个文件的更改?」
保存 / 不保存 / 取消)。代码文件不 autosave(ADR-015),此前关窗 / Cmd+Q 直接 flush 后关闭,脏 tab 静默丢失。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/dirty-close-confirm.ts` | 纯函数:解析 renderer 脏态上报、构造确认框(文案走 i18n catalog)、映射用户选择、解析 flush 回执 |
| `electron/main/index.ts` | `layout:dirty-state` 按窗口记账(计数 + 脏 tab id;受信 frame + sender 窗口);`wireWindowCloseFlush` / `before-quit` 在 flush 前确认;macOS `setDocumentEdited` |
| `electron/main/quit-cleanup-guard.ts` | `cancel()`:退出被中止后复位守卫,下次 Cmd+Q 重新确认 |
| `electron/preload/index.ts` | `layout.reportDirtyState` / `sendFlushAck(windowId, { saveFailed })` / flush 请求 payload `save` |
| `src/shell/dock/dirty-close.ts` | renderer 纯函数:关窗会丢的脏 tab 计数、「保存」分支批量保存 |
| `src/panels/Editor/autosave-failures.ts` | 活动 tab 的 autosave 持有者(scheduler 实例)及其最近一次是否失败(`useAutoSave` 写入,计数与 DockShell 订阅) |
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
`.md` 也算;untitled 计入,但本轮选「保存」时只放过确认框告知的 untitled **id** —— main 随 flush 请求带
`untitledIds`,确认后新建 / 同数量替换的 untitled 草稿不在其中即计入)。本轮**未**选「不保存」
且仍有 → 回执带 `remaining: { dirty, untitled, ids, untitledIds }`:

- main 中止本次关闭 / 退出,窗口重新显示,`quitGuard` 复位(与保存失败路径一致),并按 `remaining` 记账 →
  用户再次关闭时看到确认框。
- 覆盖:编辑 `.md` 后 2s 防抖内关窗、flush 中 autosave 首次失败;「保存」后慢 layout / explorer flush 期间继续
  输入;多窗退出时 B 的确认框打开期间在干净的 A 里改代码(A 收到非保存 flush)。
- 选「不保存」→ 照常关闭(行为不变)。

### 关闭流程代际

- 每窗关闭流程带代际。before-quit 接管窗口时递增;在途的旧单窗关闭流程(如「不保存」)完成时发现已被取代 →
  不置 flushed、不 `win.close()`(否则在退出的「保存」完成前销毁窗口),无副作用返回。
- 退出中止(任一取消 / 保存失败 / remaining / 全局最终检查)→ **立即**显示被本轮接管的隐藏窗口并释放其关窗守卫,
  不等旧回执或 10s 超时;旧流程迟到完成时不再 show / 复位(不干扰用户之后发起的新关闭流程)。

### flush 请求 / 回执配对

- 每个 flush 请求带唯一 `requestId`,renderer 回执原样带回;main 按 requestId 结算,且仍校验受信 frame 与
  sender 窗口。单窗关闭与 Cmd+Q 交叉时两次请求互不覆盖,旧请求的回执不会结算新请求。
- 兼容不带 requestId 的旧回执:仅当该窗口恰有一个在途请求时接受。
- 回执**始终**携带 flush 后的最终脏态 `state`(含空集合;autosave 已 flush,仍脏的 `.md` 也计入),main 以其更新
  脏态记账。「保存」后 tab 变干净,不必等之后的 effect 上报 —— 否则 main 可能拿旧脏集合做全局最终检查而误中止退出。

### 退出应用(before-quit)

- 逐个有脏文件的主窗确认(一次一个框);任一**取消** → 中止整个退出,不 flush,守卫复位,再次 Cmd+Q 正常重新确认。
- 按各窗选择 flush;任一「保存」失败或回执 `remaining` → 中止退出、显示该窗口、守卫复位(不记 flushedOnQuit,之后关窗仍走确认)。
- 全局最终检查:全部 flush 完成后、破坏性清理(`cleanupAll` 杀 PTY / debug)之前,按 main 持续接收的脏态上报判断
  各主窗是否超出本轮已接受范围 —— **按 id 身份**:当前脏 id 须是已接受集合的子集(未弹框 → 空集;「保存」→ 确认框
  告知的 untitled id;「不保存」→ 确认时的全部脏 id)。只比数量会被同数量替换绕过(「不保存」后存了 X、改了 Y;
  untitled 换成新草稿)。超出(如 A 已回执后、等待 B 保存期间在 A 里继续编辑)→ 中止退出、显示该窗口、守卫复位。
  各窗记账以回执携带的 `state` 为准,之后的脏态上报继续更新。
- 最终检查通过后、进入不可逆清理前**隐藏全部窗口**(含 popout)形成退出屏障:清理(debug teardown 可能数秒)期间
  窗口已入 flushedOnQuit,继续编辑会丢失、关窗也绕过确认。最终检查失败(中止)路径不隐藏。
- 不可逆清理:先同步拒绝所有未决 agent 授权(`cancelAllAgentAuth`),再 await terminal / debug / 插件 shell 子进程
  (`cleanupAllShellExecs` / `cleanupAllShellStreams`)清理,随后 await MCP host / stdio 关闭,全部完成才 `app.quit()`。
- popout 窗口不参与(与既有 flush 逻辑一致)。

### 计数口径(renderer)

- 计入:脏的代码文件 tab;untitled 草稿计入并单独计数(无路径,MVP 不支持另存为,「保存」时跳过,文案说明会被丢弃)。
- 上报附带脏 tab 的身份列表 `${tabId}#${变脏代际}`(tabId:file tab = 路径,untitled = 其 id;`ids` / `untitledIds`)。
  变脏代际(`EditorTab.dirtyGen`)取自进程内全局单调计数器(永不复用),在 clean→dirty 跃迁、以及保存推进了已落盘
  基线但 tab 仍脏(保存期间继续输入)时赋新值,持续输入不变 —— 「不保存」后保存再编辑同一文件、关闭重开同一路径再编辑、
  保存期间的新增量都是新身份,不在已接受范围内(复审:只比 tab id / 按 tab 实例计数会放行退出丢新改动)。main 解析时校验计数与 id
  列表一致、`untitledIds ⊆ ids`、无重复,id 列表上限 `PATH_ARRAY_MAX`、单条上限 `PATH_STR_MAX`,不合法整体忽略。
- 代际变化即重新上报:上报 effect 只订阅 `chromeVersion`,保存期间继续输入时 dirty 不翻转但代际换新,`markSaved`
  也递增 `chromeVersion`,否则新代际不上报、main 仍按旧代际放行退出(终审 P1)。
- 不计入:Markdown 自动保存开启时,**活动** tab(持有 autosave scheduler)且其最近一次 autosave 未失败的脏 `.md`
  (关窗 flush 经 `flushPendingAutoSave` 落盘);关闭该设置则计入。
- **非活动**的脏 `.md` 一律计入:切走时 `useAutoSave` 已 flush,仍脏即失败或在途;关窗 flush 只持有活动 tab 的
  scheduler,不会重试它(复审:此前按 tab 记失败记录,重命名非活动失败 tab 后记录被清 → 无确认丢失)。
- 活动 tab 最近一次 autosave 失败(ENOSPC / EACCES / EDITOR_DISK_CHANGED)→ 计入:失败后无 pending timer,flush
  不会重试。状态绑定 scheduler 实例(`src/panels/Editor/autosave-failures.ts`):切 tab / 重命名 / 关闭重开都换实例,
  新实例从「未失败」开始且 tab 仍脏时立即重新 schedule(关窗 flush 会重试);旧实例迟到结果丢弃;再次 schedule
  (继续编辑 / 显式保存后再编辑)即清除失败态。编辑器未挂载(无持有者)→ 计入。变化时重新上报。
- 「保存」分支保存所有有路径的脏 tab(含 `.md`,无害);全部完成后复查,仍脏(保存期间继续输入)同样视为失败。
- 保存失败提示里,因磁盘已被外部修改(EDITOR_DISK_CHANGED)而未写的文件单独说明(引导 Cmd+S 解决冲突
  或选「不保存」;关窗流程不弹覆盖框),文案 `dialog.unsaved_close.disk_changed_note`。

## 规范文件

| 文件 | 覆盖 |
|---|---|
| `dirty-close-dialog.spec.ts` | main 纯函数:上报解析 / 是否弹框 / 按钮与文案 / 选择映射 / 回执解析 |
| `close-confirm-flow.spec.ts` | main 端到端握手(electron 全 mock):关窗各分支 + before-quit 取消 / 保存失败 / 回执 remaining 中止 / 关闭流程代际 / 成功退出 |
| `renderer-dirty-close.spec.ts` | renderer 纯函数:计数口径(活动 / 非活动 / 失败 / 旧实例)/ 批量保存失败计数 / 最终脏检查(untitled 按 id 放行) |
| `dockshell-save-on-close.spec.tsx` | DockShell 脏态上报 + flush「保存」分支回执 + 最终脏检查回执 `remaining` |
| `../49-polish-bugfixes/quit-cleanup-guard-reentry.spec.ts` | 守卫 `cancel()` 复位 |
| `../49-polish-bugfixes/autosave-resolved-failure.spec.tsx` | `useAutoSave` 持有 / 失败 / 重新 schedule / 重命名 / 卸载 |
