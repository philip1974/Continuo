# perf-audit(性能优化审计)

逐项性能优化:每项都要求**行为保持**,并有基准或回归测试验证。

本目录放各轮性能修复的行为契约 spec(关注外部可观测的性能不变量,如「O(1) 分发、不 fan-out」),实现细节的纯函数单测与之并列。

## P1 — 终端输出窗口级单订阅分发(去 O(N) fan-out)

**位置**:`electron/preload/index.ts` `coApi.terminal.onData` + 新模块 `electron/preload/terminal-data-demux.ts`;消费者 `src/panels/Terminal/useTerminal.ts`。

**问题**:旧 `onData(cb)` 每次调用注册独立 `ipcRenderer.on('terminal:data')` listener,回调内 `if (id !== termId) return` 自行过滤。main 已按 session 路由到 owning window,但窗口内 N 个 terminal panel = N 个 listener;任一高输出 session 的每个 chunk 触发全部 N 个回调,N-1 个只做无效过滤。终端输出是高频热路径(build log / agent CLI / tail -f),开销随终端数线性增长。

**修复**:整窗对 `terminal:data` 只挂一个 listener,按 sessionId 路由到 `Map<id, Set<handler>>`。签名 `onData(cb)` → `onData(id, cb)`(cb 只收已过滤的 `data`)。每 chunk 回调开销 O(N) → O(该 id handler 数)≈ O(1)。

**契约不变量**(`terminal-data-demux.spec.ts`):分发只调 id 匹配的 handler,绝不 fan-out 到别 session;unsubscribe 后不再收到;同 id 多 handler 都收到;分发中 unsubscribe 不影响本轮。

## P2 — Quick Open 文件扫描把 maxFiles 下推到 main(去 late limit)

**位置**:`electron/main/ipc/fs/list-dir.ts`(walker)+ `src/plugins/quick-open/walk-files.ts`(消费者);IPC schema `electron/main/ipc/fs.ipc.ts`、preload 类型 `electron/preload/index.ts`。

**问题**:Quick Open 每次 ⌘P 调 `listDir(root, { maxDepth: 8 })` 全量递归,`maxFiles=5000` 只在 renderer 拿到完整结果后才 `break`。即 5k 上限只限 UI 结果数,**不限** main 实际遍历、`lstat`、每层排序、IPC 全量传输。大 monorepo 即使只需前 5000 个,仍扫深度 8 内所有未排除文件 → 每次 ⌘P 数万次 lstat + 大 IPC payload(无缓存,每次重扫)。

**修复**:给 `listDir` 加可选 `maxFiles`(默认无限,只有 QuickOpen 传;Explorer/App 用浅层 listDir 不受影响),walker 收集够 `maxFiles` 个**文件**即停止遍历/递归(目录不计入)。walk-files 把 maxFiles 下推。**行为保持**:`maxFiles=Infinity`(默认)时守卫永不触发,输出与历史逐字节一致;仅文件数真超 5000 的大仓库改变候选集成员(5000 本是启发式上限,且 fuzzy 搜索对非空 query 重排,空 query 顺序变为 top-down 遍历序,方向更优)。

**契约不变量**(`fs-adapter.spec.ts` maxFiles 早停 + 未达上限逐字节一致;`quick-open/walk-files.spec.ts` maxFiles 下推透传)。

## P3 — listDir 同层 lstat 分块并发(去串行 IO)

**位置**:`electron/main/ipc/fs/list-dir.ts` `walk()`。

**问题**:walk 在 `for` 循环里逐项 `await lstat(full)` 串行,1000 文件目录 ≈ 1000 次 stat 延迟累加。listDir 是 Explorer 展开 + Quick Open 扫描共同热路径;P2 把 QuickOpen 限到 5000 后,这里仍可能 5000 次串行 IO。网络盘/外接盘延迟更放大。

**修复**:同一层 dirent **按块并发** lstat(`LSTAT_CHUNK=32`,`Promise.all` 保留块内顺序),块间检查 maxFiles cap。组装/计数/递归仍按 candidates 顺序逐项进行 —— **输出与历史串行版逐字节一致**(30+ 现有 listDir 测试全过即证);**递归保持串行**避免共享 `state.fileCount` 的并发竞态(maxFiles 语义确定)。块大小同时是 maxFiles over-scan 上界(cap 命中的块最多多 lstat 31 项),避免「整层一次性并发」反而劣化 P2。等待从 O(N 连续 round-trip) 降到 O(N/32 批)。

**契约不变量**(`fs-adapter.spec.ts` P3 跨块:70 文件 >2 块不乱序/不漏项/不重复 + 所有既有 listDir 输出测试不变)。

## P4 — Markdown 编辑 milkdownUnsafe 派生缓存(去每按键全文重扫)

**位置**:`src/stores/editor.store.ts` `getEffectiveMode()` / `computeMilkdownUnsafe()`;消费者 `EditorPanel.tsx`、`EditorHeader.tsx`(Zustand selector)、`co-app.ts`。

**问题**:Markdown active tab 每次 `updateContent`(每按键)替换 tab 对象 → EditorPanel 重渲调 `getEffectiveMode(activeTab)`,EditorHeader selector 每次 store update 也调 `getEffectiveMode(found)`,co-app SDK gate 再调一次。`getEffectiveMode` → `isMilkdownUnsafe(content)` 跑 **未锚定** wiki-link 正则 `/\[\[[^\]]+\]\]/`(无 wiki-link 时全文扫描)→ 长 Markdown 每按键约 3 次 O(file) 扫描。

**修复**:`milkdownUnsafe` 作为 tab 派生字段(`isMarkdownFilePath(filePath) && isMilkdownUnsafe(content)`),在 **content/filePath 任一变更**的 4 个入口算一次:createTab / updateContent / reloadFromDisk / getStateAfterRenamingPath(markSaved 不改 content 用 `...cur` 保留)。`getEffectiveMode` 改读缓存字段,**缺省回退现场计算**(行为逐字节等价,不破坏旧构造)。非 markdown 文件短路为 false 不扫描(保持原 0 扫描)。每按键全文扫描 3 → 1(updateContent 内一次)。

**契约不变量**(`editor-store.spec.ts`:createTab 派生值正确 / updateContent 重算不 stale;neutralize:去 updateContent 重算 → freshness 测试 FAIL)。

## P5 — EditorPanel 复用 milkdownUnsafe 缓存(去 P4 残留重扫)

**位置**:`src/panels/Editor/EditorPanel.tsx` `unsafeMarkdown`;新 accessor `editor.store.ts` `isTabMilkdownUnsafe()`。

**问题**:P4 缓存了 `EditorTab.milkdownUnsafe` 且 `getEffectiveMode` 读缓存,但 `EditorPanel` 仍直接 `isMilkdownUnsafe(activeTab.content)` 算 `unsafeMarkdown` → Markdown 每按键仍 = updateContent 1 次 + render 1 次 = **2 次** O(file) 扫描,而非预期 1 次。

**修复**:抽统一读取口径 `isTabMilkdownUnsafe(tab)`(cache-or-compute,getEffectiveMode 与 EditorPanel 共用单一来源);`unsafeMarkdown = isTabMilkdownUnsafe(activeTab)`(与旧 `activeIsMarkdown && isMilkdownUnsafe(content)` 逐字节等价,因 computeMilkdownUnsafe 同公式)。删 EditorPanel 内 `activeIsMarkdown` + `isMilkdownUnsafe` import。每按键扫描 2 → 1。

**契约不变量**(`editor-store.spec.ts`:isTabMilkdownUnsafe 优先读缓存 / 缺省回退现场计算 / null→false)。

## P6 — CodeEditor 受控回声免全文 toString

**位置**:`src/panels/Editor/CodeEditor.tsx` 的 `EditorView.updateListener` 扩展 + value-sync `useEffect([value])`(`lastSyncedValueRef`)。

**问题**:CodeMirror 每按键 updateListener `doc.toString()` emit 给 `updateContent`(必要),store 更新后父把同一字符串作为 `value` 回传 → value-sync `useEffect([value])` 又 `view.state.doc.toString()` 仅为比较相等(受控回声)→ 长文件每按键 ≥2 次 O(file) 全文拷贝 + GC 压力。

**修复**:`lastSyncedValueRef` 记录 editor doc 当前反映的字符串(emit 时 / 外部 dispatch 后 / 初始 = 首个 value 都更新),value-sync effect 开头 `value === lastSyncedValueRef.current` 直接 return —— 本地回声连 `doc.toString()` 都省。真正外部新值(≠ lastSynced)仍正常 toString + 带 selection-clamp 的 dispatch 同步(P2-AQ 光标保持不破)。每按键 2 → 1 次全文拷贝。

**契约不变量**(`perf-audit/code-editor-echo-skip.spec.tsx`:回声 value → effect 不调 doc.toString + doc 不被多余 dispatch;外部新值 → 调 toString + dispatch 同步;`49-polish-bugfixes/code-editor-external-reload-keeps-cursor.spec.tsx` 外部 reload 光标保持仍过)。

## P7 — StatusBar 文本统计单遍零分配

**位置**:`src/lib/text-stats.ts`、`src/shell/StatusBar.tsx` `stats` useMemo。

**问题**:`lineCount` 用 `s.match(/\n/g)`(分配全部换行的匹配数组)、`wordCount` 用 `trim().split(/\s+/)`(分配全部单词的子串数组)。active editor 每按键 `activeContent` 变 → StatusBar memo 失效重算 → 2 次全文扫描 + 2 个大临时数组(长文件 GC 压力)。memo 已挡无关重渲(R1),但内容编辑必重算。

**修复**:`computeTextStats(s)` 用 `charCodeAt` **单遍、零数组分配**同时算 lines/words/chars(`isWhitespaceCode` 复刻 JS 正则 `\s` 码点集 → 单词切分逐字节等价);`lineCount`/`wordCount` 也重写为无分配循环(后续:这三个单项导出已删,只留 `computeTextStats`)。StatusBar 改用 `computeTextStats` 一遍拿三项。每按键 2 次全文扫 + 2 大数组 → 1 遍 0 分配。

**契约不变量**(`text-stats.spec.ts`:computeTextStats 的 lines/words/chars 与旧 `match(/\n/g)`/`split(/\s+/)` 正则口径逐字节等价,覆盖空/全空白/CRLF/中文/尾换行;`statusbar-stats-memoized.spec.tsx`:memo 命中/失效契约不变,改 spy computeTextStats)。

## P8 — CodeEditor content-as-source-of-truth 大重构(DEFER)

**位置**:`CodeEditor.tsx` 每按键 `doc.toString()` → `updateContent` 写全文进 store(O(file) 而非 O(change))。

**判定:DEFER(不在本打磨轮实施)。** 特征属实,但建议的修法(编辑器持有正文、store 只存 dirty/version、autosave 从 viewRefs 拉)是结构性大重构:`store.content` 是深度承载的单一真源(useAutoSave/save/StatusBar + **CodeEditor↔MilkdownEditor 双编辑器经它互换**),改它需为双编辑器/autosave/save/持久化重建同步机制 → 与「极简/行为保持」冲突,且风险落在大量已修的数据丢失类路径(save-race/markSaved/reloadFromDisk epoch)。P6+P7 已去掉回声第二次拷贝 + 统计额外分配,现每按键仅 1 次 O(n) toString,现实文件尺寸亚毫秒级。独立复审亦认同此 DEFER。记为专门 ADR/重构任务候选。

## P9 — 终端 resize IPC 网格变化门控(去无效 resize)

**位置**:`src/panels/Terminal/useTerminal.ts` `fitAndResize()`。

**问题**:`fitAndResize` 每次 `fitAddon.fit()` 后**无条件** `coApi.terminal.resize(termId, cols, rows)`。终端容器 resize、侧栏拖拽宽度变化高频回调,多为像素级变化**不改变** cols/rows 格子数,但仍触发 fit + IPC→main→PTY resize(还多发 SIGWINCH);N 个 terminal panel 放大为 N 路重复。

**修复**:per-terminal `lastSentSizeRef` 缓存上次发往 PTY 的网格(= PTY 当前尺寸),fit 后仅当 cols/rows 真变化才发 IPC。`fit()` 仍每次跑(xterm DOM 布局),返回值语义不变(网格是否有效,供 RAF 重试)。侧栏拖拽/窗口 resize 的无效 IPC 降到接近实际网格变化次数。

**契约不变量**(`perf-audit/terminal-resize-gating.spec.ts`:首发→同网格不再发→网格变化才再发→无效网格 cols/rows=0 返 false 供重试;neutralize:去门控 → 测试 FAIL)。

## P12 — EditorHeader chrome selector 由 O(N) 序列化降为 O(1) 版本号

**位置**:`src/panels/Editor/EditorHeader.tsx` 的 chrome 订阅(原 `chromeSig` selector,现订阅 `chromeVersion`)+ `src/stores/editor.store.ts`。

**问题**:`updateContent` 每按键替换 `tabs` 数组 → Zustand 重跑所有订阅 selector。EditorHeader 旧 selector 每次 `s.tabs.map(...id/filePath/dirty...) + JSON.stringify(...)`(O(tab 数) 数组分配 + 序列化)。虽阻止 React 重渲,但每按键的 O(N) 计算照跑;打开几十个 tab + 持续输入时把 header chrome 签名计算拉进编辑热路径。

**修复**:store 维护 `chromeVersion: number`,仅在 chrome 真变化时递增——openTab 必 bump,closeTab/removePaths/renamePath/closeTabsOutsideRoot 经 `applyTabStateChange`(tabs 引用变才 bump),updateContent / markSaved 仅 **dirty 翻转** 才 bump;reloadFromDisk / switchTab 不 bump。EditorHeader 改订阅 `chromeVersion`(O(1) number 比较),useMemo 仅 version 变才从 getState() 重建 chrome 数组。持续在已脏 tab 输入(dirty 恒 true)→ 不 bump → selector O(1) 跳过。生产中 tab 仅经 action 增删(无 raw setState),故 version 不会 stale。

**契约不变量**(`editor-store.spec.ts` perf P12:已脏输入不 bump / dirty 翻转 bump / openTab 新增 bump·已存在不 bump / renamePath·真删 bump·no-op 不 bump / markSaved-dirty bump·reloadFromDisk·switchTab 不 bump;neutralize:updateContent 总是 bump → 测试 FAIL;`editor-header-narrow-subscription.spec.tsx` content-only 不重渲 / 经 openTab 新增重渲)。

## P13 — TitleBar activeSig selector 复用 chromeVersion(P12 同族残留)

**位置**:`src/shell/TitleBar.tsx` 的标题订阅(原 `activeSig` selector,现订阅 `chromeVersion`)。

**问题**:P12 修了 EditorHeader,但 TitleBar 仍每按键 `s.tabs.find(...) + JSON.stringify([exists, filePath, dirty])`(O(tab 数) find + 小分配/序列化)。持续输入已脏 tab 时标题的 filePath/dirty 没变,但 selector 照扫一遍。

**修复**:复用 P12 的 `chromeVersion`——TitleBar 改订阅 `activeTabId` + `chromeVersion`(均 O(1) number 比较),`useMemo([activeTabId, chromeVersion])` 仅在 active 切换或 chrome 真变化时从 getState() 读 active tab 的 [exists, filePath, dirty]。逐字节等价(同一派生),常规输入 O(N)+分配 → O(1) 比较。

**契约不变量**(`titlebar-narrow-subscription.spec.tsx`:content-only(已脏 tab updateContent)不重渲 / clean→dirty 翻转重渲 + 标题加 ●,均经真实 action;active basename + workspace 名显示)。

## P14 — EditorHeader activeActionSig 复用 chromeVersion(扩展含 milkdownUnsafe)

**位置**:`src/panels/Editor/EditorHeader.tsx` 的 action 区订阅(原 `activeActionSig` selector,现订阅 `chromeVersion`)+ `editor.store.ts`。

**问题**:P12/P13 清掉了 chrome 条与 TitleBar,但 EditorHeader 右侧 action 区仍每按键 `s.tabs.find(...) + JSON.stringify([filePath, dirty, getEffectiveMode(found)])`(O(tab 数) find + 小分配/序列化)。getEffectiveMode 经 P4/P5 已 O(1),但 find + 序列化照跑。

**修复**:复用并扩展 `chromeVersion` —— activeActionSig 的 effectiveMode 还依赖 active tab 的 `milkdownUnsafe`(可不翻 dirty 而翻转,如输入 `[[`)+ store.mode,故让 chromeVersion 也在 **milkdownUnsafe 翻转** 时 bump(updateContent / reloadFromDisk,`!!` 归一化避免 undefined→false 误判)。EditorHeader 改订阅 `activeTabId` + `chromeVersion` + `mode`(均 O(1)),`useMemo` 仅这三者变时从 getState() 读 active tab 派生 [filePath, dirty, effectiveMode]。逐字节等价,常规输入 O(N)+序列化 → O(1)。

**契约不变量**(`editor-store.spec.ts` perf P14:已脏 tab 输入 `[[` 使 milkdownUnsafe false→true(dirty 恒 true)仍 bump、再输入仍 unsafe 不 bump;neutralize:去 updateContent 的 milkdownUnsafe bump → FAIL;`editor-header-narrow-subscription.spec.tsx` 改用真实 action 验 content-only 不重渲 / dirty 翻转重渲)。

## P15 — 外部文件同步 fs 事件 in-flight 合并(去 burst 重复 IO)

**位置**:`src/panels/Editor/useExternalFileSync.ts`。

**问题**:同一文件短时间多次 `fs:dir-changed`(原子写 = 临时文件+rename 多事件 / 格式化工具/生成器连续重写)→ 旧实现对每个事件都并发发起 `readFile` + `reloadFromDisk`,只有最后一次有用,前面的 IPC + 磁盘读纯浪费。旧有 `seqByPath` 只做 latest-wins 丢弃,不防并发。

**修复**:按 path 做 **in-flight 合并**——某 path 的 read 在途时,新事件只标记 pending(不并发发起);在途 read 完成后若 pending 则尾随重读一次(读 burst 后的最终内容),跳过被取代的中间结果。首个事件立即读(不加延迟),仅在途期间事件被合并。每 path 读严格串行 → 并发乱序回写场景**根本不会发生**(比 seqByPath 更强,直接取代之)。dirty tab 在事件与应用两处都跳过。tab.id===filePath 不变量保证同文件不开成两个 tab,按 path 合并安全。

**契约不变量**(`external-file-sync-out-of-order.spec.tsx`:3 事件 burst 在途只 1 并发读 / 中间陈旧结果不落地 / 尾随读最终内容落地 / 单事件立即读不延迟 / dirty 保护;neutralize:还原每事件并发读 → 合并测试 FAIL;`use-external-file-sync.spec.tsx` 单事件路径不变)。

## P16 — Quick Open fuzzy 预计算 relPathLower(去每按键重复 lowercasing)

**位置**:`src/plugins/command-palette/fuzzy.ts` `fuzzyScoreLower`、`src/plugins/quick-open/QuickOpenModal.tsx`、`walk-files.ts`、`store.ts`。

**问题**:Quick Open 候选已限 5000,query 已整批 lower 一次(R51),但 `fuzzyScoreLower` 每次对 target 跑 `target.toLowerCase()`。relPath 在一次 scan 内稳定,用户连续输入 `s`→`sr`→`src` 时对最多 5000 条路径反复分配 lowercase 字符串(每按键 O(候选路径总长度))。

**修复**:`fuzzy.ts` 抽 `fuzzyScoreBothLower`(q 与 t 均已 lower)+ `fuzzyFilter` 加可选 `getStrLower`(返回预 lower 的 target)。`QuickOpenFile` 加 `relPathLower` 字段(walk-files scan 时算一次),QuickOpenModal 传 `getStrLower=(f)=>f.relPathLower`。query 仍每批 lower 一次,打分/排序逐字节一致(`relPath.toLowerCase()` 与 `target.toLowerCase()` 同操作)。每按键 O(候选总长) lowercasing → 0(scan 时一次)。

**后续**:生产两个调用点都传预小写 target,未预小写的 `getStr` 路径(及 `fuzzyScoreLower`)已删,`getStrLower` 成为唯一入参。

## E1 — co-app 跳行处动态 import scrollToLine(CodeMirror 不进 main-app 启动包)

**位置**:`src/plugins/co-app.ts` `editor.openFile`。

**问题**:co-app 在 main-app 启动路径上,静态 import `scrollToLine`(运行时依赖 `@codemirror/view`)把整套 CodeMirror 拖进启动包,破坏 Editor 懒加载边界。

**修复**:跳行时 `await import('@/panels/Editor/scrollToLine')`。复审修正:与 `preloadCodeEditorEngine()`(Editor 面板 + CodeEditor chunk,与 lazy 共用 `editor-engine-loaders` 的同一 promise)并行加载,模块就绪后才开始 500ms 有界挂载等待,并按 `viewRefs` 复核 view 未被替换;加载失败映射为 `EXCEPTION`。

**契约不变量**(`editor-lazy-boundary.spec.ts`:co-app 不静态 import scrollToLine / `@codemirror/*`;`sdk-editor-namespace/*` 行号跳转契约不变,`openFile-cold-load.spec.ts` 覆盖冷加载/并发/加载失败)。

## E2 — EditorPanel 内两套编辑引擎各自 lazy

**位置**:`src/panels/Editor/EditorPanel.tsx`。

**问题**:EditorPanel 静态 import CodeEditor(CodeMirror + 语言包)与 MilkdownEditor(Crepe/ProseMirror/katex),Editor chunk 同时含两套引擎;Welcome / 只开代码文件也要下载解析 Milkdown。

**修复**:两引擎各 `React.lazy`,body 外包 `<Suspense key={engine} fallback={null}>`(engine = welcome/code/milkdown)—— 切换引擎时边界整体重挂,旧编辑器完整卸载,与原 key 重挂语义一致。viewRefs 仍由 CodeEditor 挂载 effect 注册,`waitForViewRef` 不变。语言包按扩展名动态加载**未做**(pickLanguage 同步导出且被测试,改异步需 Compartment 重配,收益/风险不匹配)。

复审修正:import 工厂抽到 `editor-engine-loaders.ts`(成功 promise 共享、失败不缓存),EditorPlugin / EditorPanel / co-app 预加载共用;引擎 Suspense 外包局部 `EditorEngineErrorBoundary`,chunk 加载失败只在引擎区显示错误 + 重试(i18n),重试新建该引擎的 lazy 实例并换 key 重挂边界。

**契约不变量**(`editor-engine-lazy.spec.tsx`:Welcome 不加载引擎;代码文件只加载 CodeEditor;Markdown edit 再加载 Milkdown;引擎已加载后切换同步渲染;加载器共享 promise、失败可重试。`editor-engine-error-boundary.spec.tsx`:加载失败面板不崩、显示错误与重试,重试后加载成功)。

**首开预热**:首次打开文件时引擎 chunk 原要等 readFile 返回、openTab 提交、EditorPanel 渲染后才开始加载(两段串行)。
`openFileByPath`(Explorer 单击 / Quick Open 回车 / SDK openFile)在 `await readFile` 之前 fire-and-forget 预热
Editor 面板 + 对应引擎(Markdown 且 `getEffectiveMode(null)` 非 source → Milkdown,否则 CodeEditor);已打开的 tab
只切换不预热;Quick Open 面板挂载即 `preloadCodeEditorEngine()`。共享 loader 去重、失败不缓存,预热失败吞掉不影响
打开结果(`editor-engine-prewarm.spec.tsx`)。

## E3 — EditorHeader memo

**位置**:`src/panels/Editor/EditorHeader.tsx`。

**问题**:EditorPanel 每按键重渲,非 memo 的 EditorHeader 被连带调用,每键重建全部 TabNavItem 与闭包(O(tab 数))。

**修复**:`memo` 包裹。唯一 prop `onCloseRequest` 为父级稳定 useCallback,所需 store 状态全走自身窄订阅。

**契约不变量**(`editor-header-memo.spec.tsx`:父级重渲 props 不变 → 不重渲;自身订阅的 chrome 变化 → 仍更新)。

## E4 — debug 装饰同步按相关切片门控

**位置**:`src/panels/Editor/decorations/debug-decoration-sync.ts`。

**问题**:宽订阅 editor store + debug store,每按键 / 变量加载都对每个 view 线性找 tab + 扫全部断点做路径比较(O(T²+T·B)),签名缓存只省掉最后的 dispatch。

**修复**:订阅回调比较前后状态 —— editor 侧仅 `viewRefs` / `chromeVersion`(tab 增删/改名/改路径都经 action bump),debug 侧仅 `activeSessionId` 或某 session 的 `breakpoints` / `stopped` 引用变化时同步。正文变化后的装饰由 StateField 在 `docChanged` 时按行号重建,不依赖 store 通知。

**契约不变量**(`debug-decoration-sync-gating.spec.tsx`:按键 / 无关 debug 更新零扫描;停点移动、断点变更、新开 view、改路径、关闭 tab 仍同步;`51-debug-breakpoint-ui/sync.spec.tsx` 全部保持)。

## E5 — debug 装饰同步不静态引入 CodeMirror

**位置**:`src/panels/Editor/decorations/debug-decoration-sync.ts`、`debug-decorations.ts`。

**问题**:EditorPanel 静态 import 同步模块,后者静态 import `./debug-decorations`(运行时依赖 `@codemirror/view` + `state`),EditorPanel chunk 因此静态依赖 ~245KB CodeMirror 公共 chunk,Welcome / 未开代码 tab 冷启动也要下载解析,违背 `editor-engine-loaders.ts`「不得静态 import CodeMirror」约束。

**修复**:同步模块对装饰实现只做 type import;`debug-decorations` 模块求值时调用 `provideDebugDecorationsApplier(setDebugDecorations)` 注册。view 只由静态 import 了它的 CodeEditor 注册,有 view 时实现必已就绪,同步语义不变。兜底:有 view 而实现未就绪时 `import('./debug-decorations')`,加载完成且同步仍在运行时补做一次(失败不缓存)。

**契约不变量**(`editor-lazy-boundary.spec.ts`:sync 模块与 EditorPanel 不静态 import `@codemirror/*` / debug-decorations;`debug-decoration-sync-lazy.spec.tsx`:实现未加载时动态加载后对已注册 view 补做同步;`51-debug-breakpoint-ui/sync.spec.tsx`、`debug-decoration-sync-gating.spec.tsx` 全部保持)。

## E6 — @milkdown 的 katex 导入换空壳(公式改由懒加载 katex 渲染)

**位置**:`electron.vite.config.ts` renderer 插件 `scripts/vite-milkdown-katex-stub.ts` + 空壳 `scripts/milkdown-katex-stub.ts`。

**问题**:`@milkdown/crepe` 主入口与 `feature/toolbar` 静态 `import katex from 'katex'`,MilkdownEditor chunk 因此带上 katex(~260KB);mermaid 另动态带自己版本的 katex。

**修复**:renderer 构建插件把**来自 `node_modules/@milkdown/`** 的裸 `katex` 导入解析到空壳(`render(){}` / `renderToString(){return ''}` —— Crepe 只用这两个默认导出方法)。CrepeFeature.Latex 开启后,这两处调用点(行内公式 toDOM、latex 代码块预览)都由 `src/panels/Editor/milkdown-math.ts` 覆盖,公式改由 `katex-render.ts` 的 `import('katex')`(单独 chunk,首次遇到公式才加载;样式随 Crepe 主题、字体本地按需)渲染。mermaid 的 katex 不受影响;`katex/dist/katex.min.css` 等子路径不匹配。**去掉 configureMarkdownMath 前须先移除插件。** MilkdownEditor chunk 987,236 B → 726,893 B。

**契约不变量**(`milkdown-katex-stub.spec.ts`:插件挂在 renderer;只匹配 @milkdown importer;空壳 API 调用不抛错;MilkdownEditor 开启 Latex 且接 configureMarkdownMath;真实 Crepe 渲染含 `$...$` / `$$...$$` / ```` ```latex ```` 的文档不调用 @milkdown 的 katex 且原样往返)。

## renderer 产物压缩(renderer-minify.spec.ts)

- `electron.vite.config.ts` 的 renderer build 显式 `minify: 'esbuild'`(electron-vite 2.x 默认不压缩)。
- 首屏 main-app chunk 2,494,294 B → ~1,267,928 B;TerminalPanelView 654,356 B → ~496,848 B。
- 仓库运行时代码不依赖函数 / 类名(`constructor.name` 等),压缩不改变行为;以全量 e2e 验证。

## main 冷启动:node:http 不以 ESM 值导入(main-node-http-cjs.spec.ts)

- main 产物是 ESM;`import { createServer } from 'node:http'` 会让 Node 读取 node:http 全部导出(含懒 getter),
  连带加载并编译整个 undici,实测 main 求值 +17–18ms。mcp-host 只用 createServer,改经
  `createRequire(import.meta.url)('node:http')` 取得,类型仍用 `import type`。

- `first-interaction-warmup.spec.tsx`:Explorer 文件行 pointerdown 预热编辑引擎 chunk(早于 click);终端意图预热同时加载捆绑字体 MesloLGS NF。
