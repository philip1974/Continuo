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
- 文案(VSCode `showSaveConfirm`):1 个脏文件 → 标题「是否要保存对「a.ts」的更改?」、按钮「保存」;多个 → 标题「是否要保存对以下
  N 个文件的更改?」、按钮「全部保存」,detail 逐行列出文件名(最多 10 个,其余一行「…另有 N 个文件未列出」),空一行后是丢失提示。
  文件名由脏态 id(`${文件路径}#${代际}`)推出 basename,上报协议不加字段。
- **取消** → 窗口保持打开;再次关闭会再次确认。
- **不保存** → 照旧 hide + flush 后关闭(请求带 `discard: true`,renderer 跳过最终脏检查)。
- **保存** → flush 请求带 `save: true`,renderer 先保存所有脏 tab 再 flush;
  回执 `saveFailed: true`、超时无回执或请求被跳过(renderer 未就绪 / send 抛错)→ 中止关闭、窗口重新显示
  (renderer 已 toast)。「不保存」时跳过仍照常关闭。

### 最终脏检查(统一规则)

「是否允许关闭」不再只取决于弹框前的脏计数。renderer 在 flush 握手里**全部** flush(批量保存、layout、explorer、
markdown autosave flush)完成后、回执之前,检查此刻仍 dirty 的 tab(autosave 已 flush 过,仍脏的
`.md` 也算)。本轮**未**选「不保存」且仍有 → 回执带 `remaining: { dirty, ids }`:

- main 中止本次关闭 / 退出,窗口重新显示,`quitGuard` 复位(与保存失败路径一致),并按 `remaining` 记账 →
  用户再次关闭时看到确认框。
- 覆盖:编辑 `.md` 后 2s 防抖内关窗、flush 中 autosave 首次失败;「保存」后慢 layout / explorer flush 期间继续
  输入;多窗退出时 B 的确认框打开期间在干净的 A 里改代码(A 收到非保存 flush)。
- 选「不保存」→ 框里列出的文件照常丢弃;但确认时**未列入框**的待 autosave `.md`(main 随 flush 请求带
  `pendingAutoSave`)flush 后仍脏(首次保存失败)→ 回执 `remaining`,main 同样中止关闭 / 退出并按此记账(终审 P1:
  用户未被告知会丢)。按 tabId 匹配,忽略变脏代际。

### 未弹框关闭的 flush 超时(终审 P1)

- 计数排除的活动 tab 脏 `.md`(见「计数口径」)随脏态上报另带 `pendingAutoSave`(身份同 `ids`,非空才带;上报去重
  与受信校验沿用)。它们只能靠关窗 flush 落盘。
- 未弹框的关闭(单窗关闭 / before-quit)flush **超时**且该窗口最近上报的 `pendingAutoSave` 非空 → 中止关闭 / 退出、
  窗口重新显示(与 `remaining` 同路径)。覆盖:读盘挂起超过 10s 的网络卷(SMB / SSHFS / FUSE)上 autosave 防抖期内关窗。
- 用户在确认框选「不保存」时同样适用:「不保存」只针对框里列出的文件,待 autosave 的 `.md` 不在列表中,其 flush 超时
  且 `pendingAutoSave` 非空 → 中止关闭 / 退出(代价:renderer 卡死且恰有待落盘 `.md` 时窗口关不掉,可强制退出)。
- `pendingAutoSave` 为空 → 超时仍照常放行:renderer 卡死 / 崩溃永不回执时窗口必须能关(超时兜底的本意)。

### 关闭流程代际

- 每窗关闭流程带代际。before-quit 接管窗口时递增;在途的旧单窗关闭流程(如「不保存」)完成时发现已被取代 →
  不置 flushed、不 `win.close()`(否则在退出的「保存」完成前销毁窗口),无副作用返回。
- 退出中止(任一取消 / 保存失败 / remaining / 全局最终检查)→ **立即**显示被本轮接管的隐藏窗口并释放其关窗守卫,
  不等旧回执或 10s 超时;旧流程迟到完成时不再 show / 复位(不干扰用户之后发起的新关闭流程)。

### flush 请求 / 回执配对

- 每个 flush 请求带唯一 `requestId`,renderer 回执原样带回;main 按 requestId 结算,且仍校验受信 frame 与
  sender 窗口。单窗关闭与 Cmd+Q 交叉时两次请求互不覆盖,旧请求的回执不会结算新请求。
- 不带 requestId 的回执不结算(main 与 renderer 同包发布,不存在旧版 renderer)。
- 回执**始终**携带 flush 后的最终脏态 `state`(含空集合;autosave 已 flush,仍脏的 `.md` 也计入),main 以其更新
  脏态记账。「保存」后 tab 变干净,不必等之后的 effect 上报 —— 否则 main 可能拿旧脏集合做全局最终检查而误中止退出。

### 退出应用(before-quit)

- 逐个有脏文件的主窗确认(一次一个框);任一**取消** → 中止整个退出,不 flush,守卫复位,再次 Cmd+Q 正常重新确认。
- 冻结(终审 P1):某窗回答确认框(保存 / 不保存)后**立即隐藏**,直到退出完成 —— 否则别窗确认框打开期间回到该窗
  继续编辑同一已脏文件,脏 id 身份不变,全局最终检查视为已接受 → 新增内容静默丢失。退出中止(任一路径)时恢复显示。
  单窗关闭流程不受影响(回答后本就 hide + 关闭)。
- 按各窗选择 flush;任一「保存」失败或回执 `remaining` → 中止退出、显示该窗口、守卫复位(不记 flushedOnQuit,之后关窗仍走确认)。
- 全局最终检查:全部 flush 完成后、破坏性清理(`cleanupAll` 杀 PTY / debug)之前,按 main 持续接收的脏态上报判断
  各主窗是否超出本轮已接受范围 —— **按 id 身份**:当前脏 id 须是已接受集合的子集(未弹框 / 「保存」→ 空集;
  「不保存」→ 确认时的全部脏 id)。只比数量会被同数量替换绕过(「不保存」后存了 X、改了 Y)。超出(如 A 已回执后、等待 B 保存期间在 A 里继续编辑)→ 中止退出、显示该窗口、守卫复位。
  各窗记账以回执携带的 `state` 为准,之后的脏态上报继续更新。
- 全局最终检查同样按身份检查 `pendingAutoSave`(终审 P1):A 已回执后在 A 的活动 `.md` 输入,防抖触发前该 tab 只进
  `pendingAutoSave`(`dirty` 仍 0),本轮 flush 已结束不会再落盘 → 不在已接受集合内即超出,中止退出。放过:已接受集合内
  的 id(「不保存」确认的脏 `.md` 改归 `pendingAutoSave`),以及 flush 请求前已上报的 id(已随本轮 flush 落盘;现行
  renderer 回执总带 `state`、不含 `pendingAutoSave`,只有不带 `state` 的旧回执会让其残留在记账里)。
- 最终检查通过后、进入不可逆清理前**隐藏全部窗口**(含 popout)形成退出屏障:清理(debug teardown 可能数秒)期间
  窗口已入 flushedOnQuit,继续编辑会丢失、关窗也绕过确认。最终检查失败(中止)路径不隐藏(已回答确认框而被冻结隐藏的
  窗口恢复显示)。
- 不可逆清理:先同步拒绝所有未决 agent 授权(`cancelAllAgentAuth`),再 await terminal / debug / 插件 shell 子进程
  (`cleanupAllShellExecs` / `cleanupAllShellStreams`)清理,随后 await MCP host / stdio 关闭,全部完成才 `app.quit()`。
- popout 窗口不参与(与既有 flush 逻辑一致)。

### 主窗 Reload / Force Reload(View 菜单,Cmd+R / Shift+Cmd+R)

reload 换掉 renderer 文档,未落盘编辑与关窗一样会丢。View 菜单保留 Electron 默认 viewMenu 其余项(DevTools / 缩放 /
全屏),只把 reload / forceReload 换成自定义项(role 项的 click 会被 role 动作抢先执行,无法拦截),点击时走与关窗同一的
`confirmDirtyClose` + `requestWindowFlush` + `shouldAbortClose`,不隐藏窗口:

- 有脏 tab → 先确认(挂在该窗口上),回答前不 flush、不 reload;确认框 / flush 在途期间重复触发不叠框。
- **取消** → 不 flush、不 reload;**保存** → flush(`save: true`),ack 成功后才 reload,保存失败 / 未确认 → 不 reload;
  **不保存** → flush(`discard: true`)后 reload。
- 无脏 tab → 不弹框,flush(落盘布局与待 autosave 的 `.md`)后 reload;flush 后仍有未保存改动 → 不 reload。
- popout 子窗:菜单 Reload 无效(维持屏蔽刷新)。reload 真正发生后的状态回收照旧由 `onRendererDocumentGone` 负责。

### 计数口径(renderer)

- 计入:脏的代码文件 tab(编辑 tab 都有路径,无无路径草稿)。
- 上报附带脏 tab 的身份列表 `ids`:`${tabId}#${变脏代际}`(tabId = 路径)。
  变脏代际(`EditorTab.dirtyGen`)取自进程内全局单调计数器(永不复用),在 clean→dirty 跃迁、以及保存推进了已落盘
  基线但 tab 仍脏(保存期间继续输入)时赋新值,持续输入不变 —— 「不保存」后保存再编辑同一文件、关闭重开同一路径再编辑、
  保存期间的新增量都是新身份,不在已接受范围内(复审:只比 tab id / 按 tab 实例计数会放行退出丢新改动)。main 解析时校验计数与 id
  列表一致、无重复,id 列表上限 `PATH_ARRAY_MAX`、单条上限 `PATH_STR_MAX`,不合法整体忽略。
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
- 「保存」分支保存所有脏 tab(含 `.md`,无害);全部完成后复查,仍脏(保存期间继续输入)同样视为失败。
- 保存失败提示里,因磁盘已被外部修改(EDITOR_DISK_CHANGED)而未写的文件单独说明(引导 Cmd+S 解决冲突
  或选「不保存」;关窗流程不弹覆盖框),文案 `dialog.unsaved_close.disk_changed_note`;写保护(FS_READONLY)同理单独
  说明(`dialog.unsaved_close.readonly_note`:按保存键确认覆盖或选「不保存」)。提示列出失败文件名(最多 3 个,
  超出加「等」,`saveForCloseFailureMessage`);保存键取当前生效绑定。

## 规范文件

| 文件 | 覆盖 |
|---|---|
| `dirty-close-dialog.spec.ts` | main 纯函数:上报解析 / 是否弹框 / 按钮与文案 / 选择映射 / 回执解析 |
| `close-confirm-flow.spec.ts` | main 端到端握手(electron 全 mock):关窗各分支 + before-quit 取消 / 保存失败 / 回执 remaining 中止 / pendingAutoSave + 超时中止 / ACK 后新增 pendingAutoSave 中止 / 关闭流程代际 / 成功退出 |
| `renderer-dirty-close.spec.ts` | renderer 纯函数:计数口径(活动 / 非活动 / 失败 / 旧实例)/ 批量保存失败计数 / 最终脏检查 |
| `dockshell-save-on-close.spec.tsx` | DockShell 脏态上报 + flush「保存」分支回执 + 最终脏检查回执 `remaining` |
| `../49-polish-bugfixes/quit-cleanup-guard-reentry.spec.ts` | 守卫 `cancel()` 复位 |
| `../49-polish-bugfixes/autosave-resolved-failure.spec.tsx` | `useAutoSave` 持有 / 失败 / 重新 schedule / 重命名 / 卸载 |

## 长路径文件的脏态 id(终审 P1)

- 脏态 id 为 `${tabId}#${dirtyGen}`,tabId 本身可达 `PATH_STR_MAX`(Windows 长路径);main 端单条上限为
  `PATH_STR_MAX + 32`,给代际后缀留余量。否则合法打开的长路径文件整份上报被拒 → 关窗不弹确认、静默丢修改。
