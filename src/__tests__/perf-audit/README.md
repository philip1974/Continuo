# perf-audit(性能优化审计 · 与 codex 协作)

第四个 `/goal` 阶段(接安全 S1-S6 / 可维护性 M1-M24 之后):「分析项目性能优化点,直到找不到新的,与 codex 协作」。同 dev-loop:codex(gpt-5.5 high)每轮报一个性能点 → Claude 亲读核实 → **行为保持**优化 + 基准/回归验证 → 反馈 → 下一轮,直到 `###CODEX-DONE###`。

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

**修复**:`milkdownUnsafe` 作为 tab 派生字段(`isMarkdownFilePath(filePath) && isMilkdownUnsafe(content)`),在 **content/filePath 任一变更**的 5 个入口算一次:createTab / updateContent / reloadFromDisk / setFilePath / getStateAfterRenamingPath(markSaved 不改 content 用 `...cur` 保留)。`getEffectiveMode` 改读缓存字段,**缺省回退现场计算**(行为逐字节等价,不破坏旧构造)。非 markdown 文件短路为 false 不扫描(保持原 0 扫描)。每按键全文扫描 3 → 1(updateContent 内一次)。

**契约不变量**(`editor-store.spec.ts`:createTab 派生值正确 / updateContent 重算不 stale;neutralize:去 updateContent 重算 → freshness 测试 FAIL)。

## P5 — EditorPanel 复用 milkdownUnsafe 缓存(去 P4 残留重扫)

**位置**:`src/panels/Editor/EditorPanel.tsx` `unsafeMarkdown`;新 accessor `editor.store.ts` `isTabMilkdownUnsafe()`。

**问题**:P4 缓存了 `EditorTab.milkdownUnsafe` 且 `getEffectiveMode` 读缓存,但 `EditorPanel` 仍直接 `isMilkdownUnsafe(activeTab.content)` 算 `unsafeMarkdown` → Markdown 每按键仍 = updateContent 1 次 + render 1 次 = **2 次** O(file) 扫描,而非预期 1 次。

**修复**:抽统一读取口径 `isTabMilkdownUnsafe(tab)`(cache-or-compute,getEffectiveMode 与 EditorPanel 共用单一来源);`unsafeMarkdown = isTabMilkdownUnsafe(activeTab)`(与旧 `activeIsMarkdown && isMilkdownUnsafe(content)` 逐字节等价,因 computeMilkdownUnsafe 同公式)。删 EditorPanel 内 `activeIsMarkdown` + `isMilkdownUnsafe` import。每按键扫描 2 → 1。

**契约不变量**(`editor-store.spec.ts`:isTabMilkdownUnsafe 优先读缓存 / 缺省回退现场计算 / null→false)。

## P6 — CodeEditor 受控回声免全文 toString

**位置**:`src/panels/Editor/CodeEditor.tsx` updateListener(line ~115)+ value-sync effect(line ~162)。

**问题**:CodeMirror 每按键 updateListener `doc.toString()` emit 给 `updateContent`(必要),store 更新后父把同一字符串作为 `value` 回传 → value-sync `useEffect([value])` 又 `view.state.doc.toString()` 仅为比较相等(受控回声)→ 长文件每按键 ≥2 次 O(file) 全文拷贝 + GC 压力。

**修复**:`lastSyncedValueRef` 记录 editor doc 当前反映的字符串(emit 时 / 外部 dispatch 后 / 初始 = 首个 value 都更新),value-sync effect 开头 `value === lastSyncedValueRef.current` 直接 return —— 本地回声连 `doc.toString()` 都省。真正外部新值(≠ lastSynced)仍正常 toString + 带 selection-clamp 的 dispatch 同步(P2-AQ 光标保持不破)。每按键 2 → 1 次全文拷贝。

**契约不变量**(`perf-audit/code-editor-echo-skip.spec.tsx`:回声 value → effect 不调 doc.toString + doc 不被多余 dispatch;外部新值 → 调 toString + dispatch 同步;`49-polish-bugfixes/code-editor-external-reload-keeps-cursor.spec.tsx` 外部 reload 光标保持仍过)。

## P7 — StatusBar 文本统计单遍零分配

**位置**:`src/lib/text-stats.ts`、`src/shell/StatusBar.tsx` `stats` useMemo。

**问题**:`lineCount` 用 `s.match(/\n/g)`(分配全部换行的匹配数组)、`wordCount` 用 `trim().split(/\s+/)`(分配全部单词的子串数组)。active editor 每按键 `activeContent` 变 → StatusBar memo 失效重算 → 2 次全文扫描 + 2 个大临时数组(长文件 GC 压力)。memo 已挡无关重渲(R1),但内容编辑必重算。

**修复**:`computeTextStats(s)` 用 `charCodeAt` **单遍、零数组分配**同时算 lines/words/chars(`isWhitespaceCode` 复刻 JS 正则 `\s` 码点集 → 单词切分逐字节等价);`lineCount`/`wordCount` 也重写为无分配循环。StatusBar 改用 `computeTextStats` 一遍拿三项。每按键 2 次全文扫 + 2 大数组 → 1 遍 0 分配。

**契约不变量**(`text-stats.spec.ts`:computeTextStats 与 lineCount/wordCount/charCount 一致 + 与旧 `match(/\n/g)`/`split(/\s+/)` 正则口径逐字节等价,覆盖空/全空白/CRLF/中文/尾换行;`statusbar-stats-memoized.spec.tsx`:memo 命中/失效契约不变,改 spy computeTextStats)。
