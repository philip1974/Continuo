# 竞态/并发正确性审计(codex 协作,第五方向)

第十四 session 续(2026-06-25,/goal「codex 一次报一个直到未发现问题」,第五方向=竞态/并发正确性,接 topic-57 a11y 收敛同 branch feat/cross-platform-p0)。范围:异步结果乱序覆盖(stale write)、effect/订阅未清理、stale closure、双触发(double-submit/fire)、TOCTOU、过期请求回写。codex read-only 报告 `[P*] file:line | 问题 | 影响 | 建议` + `###CODEX-DONE###`,逐个复查修复。

## R1 — LanguageFromSettings 语言保存失败回滚用过期闭包 + 无代际校验 (P1)

- **文件**: `src/plugins/settings/LanguageFromSettings.tsx:43`
- **问题**: 语言保存失败的 catch(A122 引入)用闭包捕获的旧 `storeLocale` 回滚,且无请求代际校验。快速切换语言时,较早请求稍后失败 → 把控件回滚到旧 locale + 可能 setValue 覆盖后一次成功选择(乱序回退)。
- **影响**: 后发成功的语言设置被先发失败结果反向覆盖,UI/持久化 locale 乱序回退。
- **修复**: 加单调请求 token(`latestReqRef`)—— catch 中 `if (reqId !== latestReqRef.current) return`(乱序旧失败直接忽略,不反馈不回滚);最新请求失败才 notify + 回滚,且回滚读 **live** `useSettingsStore.getState().locale`(不用闭包旧 storeLocale,catch 异步执行时它可能已过期)。
- **测试**: language-from-settings spec 新增 R1 race 例 —— 两次切换(zh in-flight 时切 ko),zh 晚失败 → notify 不调、values 仍 ko 不被覆盖;既有 A122 单切换例(latest req 失败)保持回滚 zh。
- **沉淀**: async toggle/切换 race 必单调 token 守卫(单 cancelled bool 不够,需区分「哪个请求」);catch/then 里回滚/善后须读 live store 状态而非闭包快照(异步执行时闭包值可能已过期)。

## R2 — Quick Open 跨 root 旧 results 泄漏(切 workspace 后展示/可打开旧文件) (P1)

- **文件**: `src/plugins/quick-open/QuickOpenModal.tsx:71` + `store.ts`
- **问题**: store 跨开关持久化 results(秒级再开复用优化)。root 变化时 effect 只 setLoading(true) **不清旧 results**;渲染分支 `loading && results.length>0` 为 false → 落列表分支展示旧 root 文件并允许 Enter/点击打开。切 workspace 后立即开 Quick Open,慢扫描期间可打开错误 workspace 的文件(跨 root 异步缓存泄漏)。
- **修复**: store 加 `resultsRoot: string|null` 绑定结果归属;`setResults(files, root?)` 记录 root。effect 开头若 `getState().resultsRoot !== root` → `setResults([], root)` 立即清旧+标记当前 root(同 root 保留复用,后台刷新)。渲染派生 `liveResults = resultsRoot===root ? results : EMPTY`(useMemo + 模块级稳定空数组),替换所有 `results.length` 渲染判断 + filtered 源 —— 防 effect(useEffect 在 paint 后)异步清理前的一帧泄漏。
- **测试**: quick-open-modal spec 新增 R2 例(旧 root 结果 + 切新 root 打开 → 慢扫描期间不展示旧 old-file.ts、0 option;新扫描完成只落 new-file.ts + resultsRoot='/new');虚拟化 spec setState 补 `resultsRoot:'/work'`。
- **沉淀**: 「跨开关持久化的缓存」必须绑定其上下文 key(此处 workspace root),否则上下文切换后旧缓存仍被当当前数据展示/操作 —— 同 [[topic_55_cross_platform_audit_codex]] 路径泄漏精神(状态须随 key 分叉)。effect 异步清理(useEffect after paint)不足以防一帧泄漏,须在派生层(useMemo)用 key 守卫双保险。

## R3 — Stop-hook broker scan-then-watch 启动窗口漏事件 (P2,main 进程 TOCTOU)

- **文件**: `electron/main/services/mcp-tools-hook-bridge.ts:336` `broker.start()`
- **问题**: start() 先 `readdir` 扫存量文件 ingest(336-339),扫完后才 `watch()`(344)。两步之间新写入的 stop-hook 事件文件:不在初始扫描里(扫描已结束)、也不触发 watcher(尚未注册)→ 永久漏。awaitNext 只查 buffered 不重扫目录 → Continuo 启动/重启时若 agent 的 Stop hook 正好落在该窗口,事件文件留磁盘但等待者一直超时(terminal.await_stop_hook 漏事件/假超时)。
- **修复**: 调换顺序 —— 先 attach watcher 再 readdir 补扫。watcher 先就位捕获扫描期间/之后的新文件;readdir 补扫 watch 前已存在的文件;两者重叠的文件由 ingestFile 经 `processed`/`inFlight` 去重(幂等,line 216 守卫 + 216→221 间无 await 原子)→ 无双 ingest。修复后无不可见窗口。
- **测试**: await-stop-hook spec 新增 R3 例 —— 存量 fixture(watch 前已存在)+ start + awaitStopHook 立即 resolve(scan 路径在「watcher-先」新顺序下未断);既有 watcher-后写入路径测试保持。
- **沉淀**: 「scan-then-watch」是事件源初始化的经典 TOCTOU,正确序是 **watch-before-scan**(watcher 先就位,scan 补存量,重叠去重)—— 反序留漏窗。前提:ingest 必须幂等(同名去重)才能容忍重叠双触发;check(216)→claim(221 inFlight.add)之间不能有 await 否则去重失效。此族同 [[topic_49_polish_bugfixes]] WatcherPool「先驱逐后creator」顺序错误的「初始化顺序决定正确性」精神。

## R4 — terminal.service.write fire-and-forget 恒返 true(A144 假成功) (P2,TOCTOU + 对偶)

- **文件**: `electron/main/services/terminal.service.ts:432` `write()` + `electron/main/ipc/terminal.ipc.ts` writeHandler
- **问题**: write() 查 `instances.get(id)` 后 fire-and-forget `sendInput()`(异步失败只 warnOnce),立即返 true;IPC handler 恒 ok:true。若 PTY 在 has()/instances.get() 与实际 sendInput 之间退出、或 server-node 拒写,renderer 收到假成功 → 用户输入在终端退出/重启边界被静默丢弃,**A144(renderer write 失败限流反馈)的 r.ok 检查无法感知真实失败**(主侧对偶缺口)。
- **修复**: `write` 改 `async (): Promise<boolean>` —— await sendInput,成功 true,catch→warnOnce+false。writeHandler 改 async,`await service.write` 后 `if (!ok) throw ERR_WRITE_FAILED`(新增 `ERROR_CODES.TERMINAL_WRITE_FAILED` + en/zh/ko catalog)→ IPC 返 ok:false。MCP send_input/send_text/press_key 的 write dep 类型放宽 `boolean | Promise<boolean>` + 调用点 await。index.ts autorun 调用点加 void(fire-and-forget 无反馈通道)。
- **测试**: window-isolation spec 改 write mock 为 `async()=>true`、not-found 断言改 `.rejects`、owner-write 加 await,新增 R4 例(service.write→false → handler 抛 TERMINAL_WRITE_FAILED);error-codes-enum 计数 34→35;catalog 全覆盖守卫自动验证新 code 三语言。
- **沉淀**: 「主侧 fire-and-forget 恒报成功」使 renderer 的失败反馈(A144)成摆设 —— 跨进程 r.ok 契约要求**主侧 await 真实结果再上抛**,否则 renderer 侧防御是空中楼阁(silent-failure 与 race 交汇:主侧 TOCTOU + 渲染侧假成功)。改 IPC handler sync→async 须确认注册层 await(ownerScopedHandle 已 await),且既有 `expect(()=>h()).toThrow` 同步断言改 `.rejects`。

## R5 — 插件 watcher tick() 无单飞守卫,并发扫描读写共享 mtimes/firstRun (P2)

- **文件**: `electron/main/services/plugins.service.ts:854` `createPluginsWatcher` start()
- **问题**: `void tick()` + `setInterval(() => void tick())`,tick 是异步扫描(readdir+stat+readFile)。扫描慢于 interval(2s,插件多/慢盘)时多个 tick 并发,并发读写共享的 `mtimes` Map + `firstRun` flag → 并发的 first-run 扫描都按 firstRun=true 吞掉实际变更,或交错写 mtimes 致重复 onChange/重复 reload。
- **修复**: 拆 `runScan`(原扫描体)+ 单飞包装 `tick` —— `running` 防重入,重入时置 `pending`、return;当前扫描结束后 `do/while(pending && !cancelled)` 串行补跑一次。mtimes/firstRun 只在串行 runScan 内更新。`tick` 同步检查 `running`(调用即占位),保证并发调用不并发扫描。
- **测试**: plugins-watcher spec 新增 R5 例 —— 填表 + touch mtime 后 `Promise.all([w.tick(), w.tick()])` 并发触发,断言 onChange 恰 fire 一次(旧码两个并发扫描各读旧 mtime → fire 两次,新码单飞 → 一次)。既有 sequential await 测试不受影响。
- **沉淀**: 「`setInterval(() => void asyncTick())`」是经典周期性异步重入隐患 —— 异步任务慢于周期即并发,共享可变状态(Map/flag)被并发读写。修法=单飞(running/pending),`running` 检查须同步发生在调用入口(占位先于任何 await)才能真正防并发。同 [[topic_49_polish_bugfixes]] in-flight 守卫族。

## R6 — 设置/快捷键 store 多窗口 lost update(整表写回陈旧快照) (P1,两 store)

- **文件**: `src/plugins/settings/values-store.ts:39` setValue/reset + `src/plugins/keybindings/keybindings-store.ts:41` setHotkey/reset(codex「同型再核」确为同款)
- **问题**: setValue/setHotkey 用本窗内存快照 `{ ...s.values, [id]: v }` 整表写回 localStorage。多窗口同时改不同 setting 时,各窗口基于各自(可能陈旧)的快照写整表 → 后写者覆盖前写者刚写的 key(lost update)。storage 事件只能事后同步,救不了已被整表覆盖的数据。例:窗口 A 改 editor 设置、B 几乎同时改 terminal 设置 → 最终只留一边。
- **修复**: 单 key RMW 改为基于 **live localStorage**:`const next = { ...readStored(), [id]: value }` 再 writeStored。localStorage 读写同步 + 跨窗 OS 串行 → set() 内 read→merge→write 原子,合并进别窗已写的 key 后再落本 key。reset 同理读 latest 再 delete;reset 不存在 key 时收敛到 latest(别窗可能已删)。resetAll 整表清空是刻意语义,不改。
- **测试**: values-store spec +2(setValue/reset 基于 live merge 不丢别窗 key);keybindings-store spec +2(同型)。模拟「本窗内存快照陈旧 + localStorage 已含别窗 key」→ 改自己 key → 断言别窗 key 保留。
- **沉淀**: 「内存快照整表写回共享持久层」在多窗口/多进程下必 lost update —— 单 key 操作须 read-merge-write live 存储(localStorage 同步可原子;若异步存储须收口到单一权威进程串行 RMW,见 [[topic_54_data_safety_audit_codex]] 跨进程 RMW 收口)。grep 所有 `{ ...s.X }` + writeStored 整表写回入口(values + keybindings 两 store 同型)。

## R7 — update-store refresh 用请求前 installed 快照,卸载的插件被复活 (P2,stale snapshot)

- **文件**: `src/marketplace/update-store.ts:66` `refresh()`
- **问题**: refresh 在网络请求前拍下 `installed = mgr.listAll()`,请求返回后仍用这个旧快照(line 98 `for (const item of installed)`)生成 available。已有的 `refreshGen` 只防**并发 refresh**,卸载/更新不 bump gen → 单次慢 refresh 期间用户卸载插件 + dismiss(id) 后,本次 refresh 仍按旧快照把已卸载插件重新加进 available(在 dismiss 之后落库)→ update 角标/Marketplace 更新列表里复活已卸载插件(过期更新提示)。
- **修复**: 提交结果前重读 live installed —— `const liveInstalled = getUserPluginManager()?.listAll() ?? []`,available 循环改遍历 liveInstalled。网络期间卸载的插件不在 live 集合 → 不会被重新加入。(remoteVersions 仍按旧 relevant 集合 fetch,无妨;新装插件无 remoteVersion 会 skip,下次 refresh 覆盖。)
- **测试**: update-store spec 新增 R7 例 —— `getMgr.mockReturnValueOnce([a]).mockReturnValueOnce([])`(请求前含 a、提交前 a 已卸载),remote 有 a 更新,断言 available=[](旧码用旧快照会算出 [a])。既有 mockReturnValue(每次同 mgr)测试不受影响。
- **沉淀**: 「请求前拍快照、返回后用旧快照写回」是 stale-write 经典形态;代际(gen)守卫只防并发同类操作,防不住**期间被正交操作(卸载/dismiss)改变的共享状态** —— 须在提交点重读 live 权威状态再计算。同 R2(跨 root 缓存)/R4(主侧 await live)/R6(live localStorage)同族:写回前读最新真值。

## R8 — 插件安装/更新 handler 仅靠 render disabled,同 tick 双触发双 clone (P2,4 入口)

- **文件**: `src/plugins/settings/PluginsTabContent.tsx:282` onInstall + `src/marketplace/MarketplaceTab.tsx` 卡片 onInstall(149)/onUpdate(187)/Git URL install(457)
- **问题**: 安装/更新 handler 只靠 React render 后的 `disabled={installing/busy}` 防重复,但 `setInstalling(true)`/`setBusy` 是异步状态,render-disable 滞后一帧。同一事件循环内双击/Enter 在状态生效前重入 → 启动两次 `installFromGit`。主进程 install lock 要等 clone + manifest 解析后才按 pluginId 串行 → 重复触发仍双 clone;第一个成功后第二个常以 EEXIST 结束,把成功消息覆盖成失败(用户看「安装失败」但插件实际已装)。
- **修复**: 每个 handler 入口加同步 in-flight 闸门(`useRef`):进入时 `if (ref.current) return; ref.current = true`,finally/落库点 `ref.current = false`。ref 同步占位先于任何 await,真正挡住同 tick 重入(render-disable 防不住)。Marketplace 卡片 install/update 共用一个 `installBusyRef`(一次只一个操作,与 `install.busy` 单 id 语义一致)。
- **测试**: marketplace-tab spec 新增 R8 例 —— 单 `act` 内 raw `.click()` 两次(中间不 flush re-render → disabled 未生效)→ 断言 installFromGit 只调一次(旧码两次)。
- **沉淀**: 「按钮 disabled 防重复点击」是 UI 错觉 —— React 状态异步,render-disable 滞后,同 tick 双事件仍双触发;真正防重入须同步 ref 闸门(占位先于 await)。这是 async toggle race(R1)在「按钮提交」场景的变体。修一个安装入口必 grep 所有 installFromGit 调用点(本仓 4 处)。R1-R8 共 8 类竞态。

## R9 — StatusBar MCP 复制反馈裸 setTimeout,旧 timer 清掉新反馈 (P2)

- **文件**: `src/shell/StatusBar.tsx:125` `onCopyMcp`
- **问题**: 复制反馈用裸 `setTimeout(() => setMcpCopyState('idle'), 1500)`,不保存/清理上一轮 timer,无 token 校验。连续点击复制:第一轮的 1500ms timeout 在第二轮反馈刚显示后把状态清回 idle → 新一次「已复制/失败」提示与 live region 被旧 timer 提前清掉,SR/用户错过真实结果;慢 `handleCopyMcpConfig` 先后返回也可能旧结果覆盖新结果。
- **修复**: `mcpCopyTimerRef`(保存当前 timer)+ `mcpCopyTokenRef`(递增 token)。新复制:`token = ++ref`;await 后若 `token !== ref` 直接 return(过期请求不更新);clearTimeout 旧 timer;setState;新 timer 回调仅当 `token === ref` 才清 idle。useEffect cleanup 在 unmount clearTimeout(防 setState-after-unmount)。
- **测试**: 新建 `statusbar-copy-feedback-timer` spec —— fake timers:复制→已复制,1000ms 后再复制,再 600ms(旧 timer 原 t=1500 应到期)断言仍「已复制」(旧 timer 已清),直到新 timer t=2500 才回 idle。
- **沉淀**: 「裸 setTimeout 清状态」在可重复触发的反馈上必被旧 timer 干扰 —— 须保存 timer 引用 + 新触发先 clearTimeout + token 校验(timer 回调与 await 回调都验 token),并 unmount cleanup。这是 R1 token 守卫在「定时清状态」场景的应用。R1-R9 共 9 类竞态。

## R10 — command-palette recent 列表多窗口 lost update (P2,R6 同型第三处)

- **文件**: `src/plugins/command-palette/recent.ts:56` `record()`
- **问题**: record 用本窗 zustand `get().list` 生成整条 recent 列表再写 localStorage,不读 live storage、无跨窗 storage 同步。两窗口几乎同时执行不同命令 → 各自基于旧列表整表写回 → 后写窗口覆盖先写窗口刚记录的命令(最近列表丢项/排序回退)。与 R6(settings/keybindings)跨窗 RMW lost update 同型,影响较轻。
- **修复**: record 改读 live `readFromStorage()` 合并(`const live = readFromStorage(); [{id,now}, ...live.filter(≠id)].slice(0,MAX)`)再 set + write,本次置顶、保留别窗已记录项。`get` 参数移除(不再用)。加 `subscribeStorageKey(RECENT_STORAGE_KEY, …)` 跨窗同步(别窗 record/clear 后本窗重读收敛)。
- **测试**: recent spec 新增 R10 例 —— 别窗已写 cmd.other + 本窗陈旧空快照 → record('cmd.mine') → 断言持久化与内存均为 [mine, other](不丢 other)。
- **沉淀**: 跨窗口 RMW lost update 已在三处同型(R6 values + keybindings / R10 recent)—— 凡 zustand store + localStorage 整表写回(`get().X` → writeStorage)都是该族,统一解=record-time 读 live storage 合并 + storage 事件订阅。grep `get().` + writeToStorage/writeRecord 整表写入口可批量定位。R1-R10 共 10 类竞态。

## R11 — IpcPluginDataStore load 在途被并发 write 后旧结果回滚 cache (P1,stale read/write)

- **文件**: `src/plugins/PluginDataStore.ts:58` `load()` / `write()`
- **问题**: read() 触发的 load IPC 在途期间,插件又 write() 新值 → write 先 `cache.set(new)` + loaded;随后旧 load() 返回执行 `this.cache.set(pluginId, data['value'])` 把 cache **回滚成旧磁盘快照**。后续 read() 返回旧值,插件基于旧 cache 再保存 → 覆盖刚写的新数据(同插件 stale read/write lost update)。
- **修复**: per-plugin `writeGen` Map。write 落盘成功后 `writeGen++` + cache.set。load() 函数开始捕获 `startGen`,IPC 返回后若 `writeGen !== startGen`(期间有 write 落地)→ 不回滚 cache,返回 cache 当前值;否则正常 set cache。
- **测试**: persist-integrity spec 新增 R11 例 —— 受控 deferred load(in-flight)+ write({v:new}) 落地 + 旧 load 返回 {v:old-disk} → 断言后续 read 得 {v:new}(cache 未被回滚;旧码会得 old-disk)。
- **沉淀**: in-flight 异步读与并发写竞争同一缓存 —— 读返回时必须校验「期间是否有更新的写落地」(代际/token),有则丢弃过期读结果不回滚。同 R7(update-store 提交前重读 live)/R2/R4/R6 写回前读最新真值族,但这里是「读不得覆盖更新的写」方向(对偶)。R1-R11 共 11 类竞态。

## R12 — terminal.service.interrupt fire-and-forget 恒「成功」 (P2,R4 同族对偶)

- **文件**: `electron/main/services/terminal.service.ts:456` `interrupt()` + `electron/main/ipc/terminal.ipc.ts` interruptHandler
- **问题**: R4(write)同族。interrupt() 仍 check-then-fire-and-forget:`instances.get(id)` 后异步 `sendInput('\x03')` 不 await,IPC 在实际写入 Ctrl-C 前返回成功。PTY 在检查后退出 / 写入失败时中断请求静默丢失 → 用户/agent 以为已中断但进程可能继续跑。
- **修复**: interrupt 改 `async (): Promise<boolean>` —— await sendInput,catch→warnOnce+false(内部 catch,永不 reject)。interruptHandler 改 async,`await service.interrupt` 后 `if (!ok) throw ERR_WRITE_FAILED`(复用 R4 的 TERMINAL_WRITE_FAILED)→ IPC 返 ok:false。MCP kill 工具的 `interrupt: ()=>void` dep 类型兼容 Promise<boolean>(void 返回类型接受任意返回值,且 interrupt 永不 reject → fire-and-forget 安全),无需改 MCP 路径。
- **测试**: window-isolation spec —— interrupt mock 改 `async()=>true`、not-owner 断言改 `.rejects`、owner 调用加 await,新增 R12 例(service.interrupt→false → handler 抛 TERMINAL_WRITE_FAILED)。
- **沉淀**: R4 修 write 时已注「resize/interrupt 同类」—— 同族 fire-and-forget 主侧操作应一并审,但当时只修被直接消费(A144)的 write;codex 后续单独捞出 interrupt 验证「同族其余入口须逐个确认而非假设已覆盖」。`()=>void` dep 类型接受 `()=>Promise<boolean>` 实参(void 吞返回值),故部分消费方(MCP fire-and-forget)无需改,前提是该 async 永不 reject。R1-R12 共 12 类竞态。

## R13 — Toast 去重读 ref,同一 tick 连续 notify 绕过去重 (P2)

- **文件**: `src/notifications/NotificationsProvider.tsx:126` `notify()`
- **问题**: toast 去重读 `notificationsRef.current`,但新增通知只在 `setNotifications` 的 updater 执行时(延迟到 render)才写回 ref(line 85)。同一事件循环内连续两次 `notify('same','success')`:第二次读到的 ref 仍缺第一条 pending 通知 → 绕过去重各自入队。突发同源成功/警告/状态通知会重复播报,违反 DEDUPE_WINDOW_MS,live region 重复打断用户。
- **修复**(codex 建议①): notify() 创建新通知后**同步** `notificationsRef.current = [...notificationsRef.current, n]`,使同 tick 后续 notify 的去重能看到这条 pending。functional updater 仍是权威(基于 React prev 计算 + trim 后落 ref);同步值仅同 tick 先行可见,updater 落 ref 后收敛(trim 差异在 tick 内对去重无害,只多几条可匹配项)。
- **测试**: notifications-provider spec 新增 R13 例 —— 单 `act` 内两次 `notify.success('dup-same', {code:'DUP'})`(中间不 flush)→ 断言去重为 1 条(旧码两条)。既有 T5(分 act 去重)保持。
- **沉淀**: 「读 ref 做去重 / 判定,但 ref 只在 React state updater 里更新」= 同 tick 窗口 ref 陈旧 → 判定基于过期快照。修法:决策性 ref 在触发点同步更新(不依赖 render 后的 updater 回写)。同 R8(按钮 disabled render 滞后用同步 ref 闸门)精神——同步 ref 先于异步 React 状态。R1-R13 共 13 类竞态。

## R14 — useFsWatcher 乐观记账:watchDir 失败仍标记已 watch,永不重试 (P2)

- **文件**: `src/panels/Explorer/hooks/useFsWatcher.ts:30`
- **问题**: `watchDir(p)` 是异步 IPC,但 effect 立即 `prevPathsRef.current = new Set(next)` —— 在 main 确认 watcher 创建前就把目录标记为「已 watch」。若 fs.watch 因 ENOENT/EACCES/资源上限返回 ok:false 或 IPC reject,该目录被永久记为已 watch;expandedPaths 不变时 effect 无 diff → 永不重试 → 展开的目录长期无增量刷新,外部创建/删除文件不触发 tree invalidate,依赖 Explorer watcher 的外部同步漏事件。
- **修复**: 分离「期望 expanded」(expandedPaths 参数)与「已安装 watch」(prevPathsRef,就地 mutate)。added 路径乐观加入 installed(防同一 path 并发重复 watch),`await watchDir`;ok:false / reject → `installed.delete(p)` 撤销记账 → 后续任意 expandedPaths 变化触发 effect 重跑时 diffSets 视其为 added → 重试。removed 路径 installed.delete + unwatch。
- **测试**: use-fs-watcher spec +2 —— watchDir 首次 ok:false 后展开新目录 → 该 path watchDir 被调 2 次(重试);watchDir 成功后同 expandedPaths 重渲不重复 watch(乐观记账防并发重复)。
- **沉淀**: 「异步操作未确认就乐观记账成功」(prevPathsRef = next 在 watchDir 前)是 fire-and-forget 记账族 —— 失败的资源被当已就绪、不重试。修法:记账分「期望」与「已确认」两态,只有异步成功才记已确认,失败撤销使可重试;乐观先记防并发重复,失败回滚保可重试(两者兼顾)。同 [[topic_49_polish_bugfixes]] watch ownerPaths 持有校验族。R1-R14 共 14 类竞态。

## R15 — IpcPermissionStore grant/deny/clearDenied 无 per-plugin 串行,并发 RMW lost update (P1)

- **文件**: `src/plugins/permissions/IpcPermissionStore.ts:204` upsert(grant/deny)+ clearDenied
- **问题**: 同一 renderer 内 grant/deny/clearDenied 是 `read cache[pluginId] → compute record → writePluginPermissions → commit cache` 的 RMW,无 per-plugin 串行。两并发调用各从同一 cache 快照算**整条** record;main 端虽串行写,但语义是按 plugin 整条覆盖、不合并 decisions → 后完成者抹掉先完成者的决策。例:`grant(['fs'])` 与 `deny(['shell'])` 并发 → 最终只剩一条(lost update)。
- **修复**: 加 `chains: Map<pluginId, Promise>` + `runExclusive(pluginId, fn)` —— 把 upsert / clearDenied 整段 RMW(ensureLoaded→读 cache→compute→写盘→commit)经 per-plugin 链串行,后一个变更读到前一个已提交的 cache。链尾吞错(前次失败不阻断后续);prev.then(fn, fn) 保证无论前次成功/失败本次都执行(权限变更不可跳过)。
- **测试**: ipc-permission-store spec +2 —— 并发 grant(fs)+deny(shell) → 两决策都保留(byPerm fs=true, shell=false,共 2 条);并发三次 grant 不同权限 → 全累积。
- **沉淀**: 同进程内多个异步 RMW 改同一 key 的共享态(cache + 整条覆盖写)必须 per-key 串行 —— 不能各读同一快照独立计算覆盖。修法=per-key mutation chain(Promise 链),整段临界区(读→算→写→提交)入链。区别于 R6/R10(跨窗 localStorage,靠 read live merge);此处同进程靠串行链。R1-R15 共 15 类竞态。

## R16 — PluginManager.init() fire-and-forget + 立即订阅 onChanged 漏窗口期变更 (P2)

- **文件**: `src/main-app.ts:142` init() + onChanged 订阅
- **问题**: `void userPluginManager.init()`(异步扫描+激活)后立刻 `coApi.plugins.onChanged((id) => reload(id))`。init 仍在扫描(某插件尚未 `entries.set()`)时该插件文件变化 → reload(id) 因「Plugin not found」被丢弃,随后 init 用旧快照激活该插件 → 漏掉启动窗口期的一次变更(插件以旧代码/manifest 运行直到下次改动或手动 reload)。
- **修复**: 抽 `wirePluginReloadGate(deps)` 解耦启动时序与变更订阅 —— init 完成前到达的 onChanged 只记入 pending(Set 去重),init 完成(成功或失败)后逐个 reload;之后的 onChanged 直接 reload。init 失败也 flush + 标 ready(否则缓冲变更永不重放 + 后续永久 buffer)。onChanged 仍同步注册(先于 init 异步工作完成,捕获窗口期)。main-app 调用 gate。
- **测试**: 新建 `plugin-reload-gate` spec 4 例 —— init 前变更缓冲去重、完成后 flush;init 后变更直接 reload;init 失败也 flush + 标 ready;reload 失败 onError 不抛。
- **沉淀**: 「异步初始化 fire-and-forget + 依赖其结果的订阅立即开启」= 初始化窗口期事件落在「资源尚未就绪」被丢。修法:gate(pending 队列 + ready 标志),订阅同步注册但事件先缓冲、init settle 后重放。同 R3(scan-then-watch:watch 先于 scan)异曲——都是「初始化与事件流的时序」,R3 是顺序调换,R16 是缓冲重放。R1-R16 共 16 类竞态。

## R17 — terminal.service.resize fire-and-forget,乱序完成回退 PTY 尺寸 (P2,R4/R12 同族第三)

- **文件**: `electron/main/services/terminal.service.ts:447` `resize()`
- **问题**: resize() fire-and-forget:连续 resize IPC 各自启动 `SessionManager.resize()` 不 await/串行,底层 Promise 可能乱序完成。较早的小尺寸若晚于较新的大尺寸完成 → 把 PTY 行列数回退到旧值。UI 已按最新容器尺寸渲染,但 PTY 停在旧 cols/rows → 换行/全屏 TUI/光标错乱;renderer lastSentSize 还认为最新尺寸已送达,不再重试。
- **修复**: 抽通用 `serializePerKey(chains, key, task)`(electron/main/services/serialize-per-key.ts)—— 把任务接到该 key 的 Promise 链尾,按调用顺序串行执行,链尾吞错前次失败不阻断后续。resize 用 per-session `resizeChains` 串行 → 最新一次自然最后生效(last-wins,不回退)。cleanupSessionLocal/`__resetForTest` 清 resizeChains 防泄漏。
- **测试**: 新建 `electron/main/__tests__/serialize-per-key.test.ts` 3 例 —— 同 key 严格保序(task2 在 task1 end 后才 start)、不同 key 并行不阻塞、前任务失败不阻断后续。(resize 走真实 create/instances 测试过重,提取纯 helper 单测覆盖核心串行逻辑。)
- **沉淀**: write(R4)/interrupt(R12)/resize(R17)是同族 fire-and-forget 主侧操作,但**失败语义不同**:write/interrupt 需上抛真实结果(调用方感知);resize 是高频 last-wins,需的是**保序串行**(不回退),不必上抛。同族不等于同解 —— 按消费语义分别处理。`serializePerKey` 与 R15 runExclusive 同型(Promise 链按 key 串行),fire-and-forget 版。R1-R17 共 17 类竞态。

## R18 — workspace 文件夹 drop 异步解析无代际守卫,乱序覆盖 root (P1)

- **文件**: `src/shell/App.tsx:91` window onDrop(`resolveDroppedWorkspace`)
- **问题**: 拖文件夹打开 workspace 的异步解析(R9/A149 引入)无代际/取消守卫。先拖入目录 A 触发 resolveDroppedWorkspace,再立刻拖入 B;若 B 先 resolve 并 `setRoot(B)`,随后 A 的旧 promise resolve 仍执行 `setRoot(A)` → 旧请求乱序覆盖新 workspace,窗口最终打开错误目录,后续 explorer/layout/editor 持久化全基于错误 root。
- **修复**: 抽通用 `createLatestGuard()`(src/lib/latest-wins.ts):`begin()` 标记本次为最新并返回 `isLatest()` 查询。onDrop 进入 async 前 `const isLatest = dropGuardRef.current.begin()`;await 后 `if (!isLatest()) return`(过期 drop 丢弃,不 setRoot 不反馈)。dropGuardRef = useRef(createLatestGuard())。
- **测试**: 新建 `latest-wins` spec 4 例 —— 单次 latest;后发起使先前 false;模拟乱序 resolve(A 慢 B 快 → 仅 B 落地);连续三次只最后为最新。
- **沉淀**: 「事件触发的异步解析 + 直接写全局状态」(drop→setRoot)凡可连续触发都需代际守卫,否则乱序 resolve 旧覆盖新。createLatestGuard 把 R1/R7/R11 的代际模式提炼成可复用纯 helper(begin→isLatest)。本族(乱序覆盖)统一解=最新者胜。R1-R18 共 18 类竞态。

## R19 — openRecentRootOrNotify 探测无 latest 守卫,旧探测乱序覆盖 root (P1,R18 同族)

- **文件**: `src/panels/Explorer/open-recent-root.ts:11`
- **问题**: openRecentRootOrNotify(A147 引入)先异步 `listDir(path)` 探测再 setRoot,无 latest-token/取消守卫。连点最近目录 A→B(或点 recent 后切走)时,迟到的 A 探测成功仍 `setRoot(A)` 覆盖后选的 B → workspace 被旧请求切回错误目录,后续 explorer/editor/layout 持久化基于错误 root。
- **修复**: 复用 `createLatestGuard()`(R18)—— 模块级 `recentOpenGuard`(单 workspace,EmptyWorkspace + ExplorerHeader 两入口共用,全局 last-wins);openRecentRootOrNotify 入口 `begin()`,await listDir 后 `if (!isLatest()) return`(过期探测丢弃)。
- **测试**: open-recent-root spec 新增 R19 例 —— 连发 A(慢)+B(快),B 先 resolve setRoot(B),A 后 resolve 过期 → setRoot 仅调一次且为 '/B'。既有 A147 三例(单次顺序调用)保持。
- **沉淀**: createLatestGuard 一次提炼,R18(drop)/R19(recent)两处复用。「先异步探测/解析再写全局 root」凡可连续触发都需 latest 守卫。模块级守卫适用于「全局唯一资源(workspace root)last-wins」;若是 per-实例独立操作则应 per-callsite guard(useRef)。R1-R19 共 19 类竞态。

## R20 — openFileByPath check→read→create TOCTOU,并发打开同文件建重复 tab (P1)

- **文件**: `src/panels/Editor/editor-file-actions.ts:42` `openFileByPath`
- **问题**: 「已打开」检查(pathEquals,X10 引入)在 `await fs.readFile` 之前,读完直接 `openTab(createTab(...))` 无二次检查。并发打开同一文件(尤其 Windows 不同大小写路径 `C:\Repo\a.md` / `c:\repo\a.md`)时,两个调用都在读前看不到 existing → 读后各自 createTab → 同一磁盘文件出现两个 tab,分别编辑保存互相覆盖(重现 X10 pathEquals 想防的数据丢失,只是从「顺序重开」变「并发打开」)。
- **修复**: readFile 返回后、openTab 前再用 `pathEquals(t.filePath ?? t.id, path)` 复检 store(double-checked),已存在则只 `switchTab(raced.id)`。第一个完成的 open 建 tab,第二个复检命中 → 切换。
- **测试**: editor-file-actions spec +2 —— 并发打开同 path(deferred readFile,第一个先 resolve 建 tab,第二个 resolve 复检命中)→ 只一个 tab;并发打开不同大小写路径(Win32 mock,pathEquals 大小写不敏感)→ 只一个 tab。
- **沉淀**: X10(topic-55 跨平台)修了「顺序重开同文件不同大小写」的 pathEquals 检查,但**并发打开**绕过它(check-then-act TOCTOU)—— 异步 read 把 check 与 act 拉开,中间窗口需读后复检(double-checked locking 的单线程版)。pathEquals 修复点须同时覆盖「检查」与「读后复检」两处。R1-R20 共 20 类竞态。

## R21 — saveFile 同 tab 并发保存无串行,旧内容晚落盘覆盖新 (P1)

- **文件**: `src/panels/Editor/editor-file-actions.ts:92` `saveFile`
- **问题**: 同一 tab 的保存无 per-tab/per-file 串行。autosave A(旧内容)写盘在途时,用户继续编辑并手动保存 B(新内容);若 B 先写完、A 后写完 → 旧内容 A 最后落盘覆盖 B。markSaved 会把内存重标 dirty,但磁盘已是错误旧内容(关闭/崩溃/非 autosave 文件留下错误磁盘内容)。
- **修复**: 抽 renderer 版 `runSerialPerKey(chains, key, task): Promise<T>`(R15 runExclusive 通用化,返回结果版,区别于 R17 fire-and-forget 的 serializePerKey)。saveFile 经 module 级 `saveChains` 按 tabId 串行 → 按发起顺序写盘,最后发起者最后落盘。内容快照移入串行后的 task(saveFileNow)内取 → 串行后读最新内容。
- **测试**: editor-file-actions spec 新增 R21 例 —— write1 挂起时发起 save2(内容改 B),断言 write2 在 write1 完整结束后才 start(order=[start:A, end:A, start:B]),严格保序。既有 saveFile 测试(单次)保持。
- **沉淀**: 写盘类操作(save/autosave)对同一目标并发时,乱序完成会让旧覆盖新 —— 须 per-target 串行链(保序),不能只靠 markSaved 事后补救(磁盘已坏)。runSerialPerKey(返回结果)与 serializePerKey(R17,fire-and-forget)按调用方是否需要结果二选一。R15/R17/R21 三处串行链(runExclusive/serializePerKey/runSerialPerKey)统一为「per-key Promise 链」族。R1-R21 共 21 类竞态。

## R22 — DockShell onReady 的 dockview listeners 不 dispose + debounce 不 cancel (P2)

- **文件**: `src/shell/dock/DockShell.tsx:206` onReady
- **问题**: onReady 注册的 `onDidLayoutChange/onDidRemovePanel/onDidAddPanel/onDidMaximizedGroupChange` 都不保存 disposable、DockShell 卸载/重建时不清理;且 onDidLayoutChange 闭包持 300ms debounce 持久化写。HMR/StrictMode/dockview 重建后,旧 listener + 旧 debounce(闭包持旧 event.api)仍触发 → 对已卸载组件 setEmpty、重复 handleTerminalPanelRemoved、或用旧 `event.api.toJSON()` 迟到写回 layout 覆盖新实例布局。
- **修复**: `dockDisposablesRef`(存各 onDid* disposable)+ `layoutPersistRef`(存 debounce)+ `disposeDockListeners()`(dispose 全部 + persist.cancel())。onReady 开头先 `disposeDockListeners()`(重入清旧),注册时 push 各 disposable;DockShell 卸载 effect cleanup 调 disposeDockListeners。`debounce` 工具加 `.cancel()`(向后兼容)。
- **测试**: layout-restore spec mock 4 个 onDid* 返回带计数 dispose 的 disposable,新增 R22 例 —— 触发 layoutChange 排定 debounce → unmount → 断言「注册数 === dispose 数」(全部 listener 被 dispose)+ 400ms 后无 write(debounce 已 cancel,迟到写不覆盖新实例)。
- **沉淀**: 一次性回调(dockview onReady)里注册的长期 listener / debounce,若不保存 disposable + 在卸载/重入时清理,就是 stale-listener 泄漏 —— 重建后旧回调用旧闭包(旧 api)对新实例生效。修法:disposable 收集 + 卸载统一 dispose + debounce.cancel();onReady 重入先清旧再注册。R1-R22 共 22 类竞态。

## R23 — PermissionEditorModal 异步 load 覆盖用户提前的表单编辑 (P2)

- **文件**: `src/plugins/permissions/PermissionEditorModal.tsx:42`
- **问题**: 权限编辑弹窗打开后立即渲染可操作 checkbox,但 `store.get(pluginId)` 异步返回后无条件 `setDecisions(m)`。用户若在加载完成前先勾选/取消,迟到的 load 结果覆盖用户刚改的表单 → 看到/保存的权限决策不是刚才的操作(IPC 慢/磁盘卡顿时误授/误拒权限)。
- **修复**(codex 首选,避免 touched 守卫的「丢未触碰项已存值」问题): 加 `loading` 态,初始 decisions 加载完成(成功/失败)前禁用 checkbox(`disabled={loading || loadFailed}`)+ 保存按钮(`disabled={loadFailed || loading}`)。load .then/.catch 各 `setLoading(false)`。加载落地后才可编辑,无 clobber、无部分丢失。
- **测试**: permission-editor-modal spec 新增 R23 例 —— deferred get:load 在途时 checkbox/保存 disabled;resolve(fs granted)后启用 + checkbox 反映已存。既有测试(get 立即 resolve)await 后交互,不受影响。
- **沉淀**: 「表单打开即可编辑 + 异步 load 无条件回填」= load 覆盖用户输入族。两解:loading 门控(禁用至加载完成,适合敏感全量表单——避免 touched 守卫只保留部分编辑而丢未触项已存值)或 touched/代际守卫(适合可增量合并的场景)。权限这类全量决策表用门控更安全。R1-R23 共 23 类竞态。

## R24 — forceKill/kill cleanup-before-kill 失败留 orphan (P1) — DEFER(架构权衡,反转刻意 P0-1 设计)

- **文件**: `electron/main/services/terminal.service.ts:523` forceKill + :500 kill grace SIGKILL 分支
- **codex 报告**: forceKill 先 `cleanupSessionLocal()` 删本地实例/metadata,再 fire-and-forget `sm.kill()`;kill reject 时 PTY 可能仍跑但主进程已失跟踪 → 未跟踪 orphan(关闭/撤销授权/MCP SIGKILL 显示成功但子进程继续)。建议改 async:await kill 成功再 cleanup,失败保留实例 + 上抛。
- **DEFER 理由**:
  1. **反转刻意设计**:代码注释明确「SYNC cleanup BEFORE sm.kill (P0-1 fix from red-team-v3)」([[topic_44_mcp_await_stop_hook]])。该顺序的目的正是**保证 sm.kill 抛错时本地清理(timers/listeners/mcp token revoke)仍执行**,避免本地状态泄漏。反转即引入对立失败模式。
  2. **双失败面权衡(非单纯 bug)**:cleanup-first → kill 失败留「未跟踪 orphan」;kill-first → kill 抛错则本地 cleanup 被跳过留「本地泄漏」(原 P0-1 bug)。两者各有失败面,孰优是架构判断。
  3. **多同步调用点 async churn**:forceKill 被 window-close cleanup / agent-auth revoke / MCP forceKill / kill grace timer 多处**同步**调用;改 async 牵连广,且 cleanupAll(before-quit)是另一并行模式。
  4. 实际触发需 SIGKILL 失败(罕见);非可单测纯逻辑项,改动风险 > 收益。
- **结论**: 按「与注释/刻意设计矛盾须分流 + 架构权衡项不擅自反转 P0 决策」规则 DEFER,留 user 架构决策。codex 继续其余方向。

## R25 — DockReconciler originHint 焦点兜底误抢 workspace 切回重现的 user terminal (P2)

- **文件**: `src/shell/dock/DockReconciler.ts:76`
- **问题**: `shouldFocus = consumePendingFocus(id) || originHint==='user'`。originHint 兜底(注释 68-75:RPC/IPC 时序无关地聚焦 user 新建)的论证只覆盖 **startup**(prev=[]+单 create);但 terminal.store 按 workspace 过滤可见 session(同文件 store 注释明言「切回旧根能重现」),切 workspace A→B→A 时 A 的 user terminal 重新进 `added` → 仍走 originHint 兜底 → setActive 抢焦点(用户可能在别的面板键入)。
- **修复**: 加模块级 `everAddedSessionIds` Set 记「本 app session 内曾出现过的 id」;originHint 兜底改为**仅首次出现**生效(`originHint==='user' && isFirstAppearance`)。首次新建仍聚焦(保留设计意图);重现的 session 已在 set 中 → 不兜底(除非显式 pendingFocus)。set 永久保留(不在 removed 循环剪除——那里无法区分「workspace 隐藏」与「真关闭」)。加 `__resetReconcilerForTest`。
- **测试**: addpanel-position spec +2(切走再切回重现不抢焦点;重现 + 显式 pendingFocus 仍聚焦)+ beforeEach reset。
- **沉淀**: 「用属性(originHint)做全局行为兜底」在状态会**重现**(workspace 过滤隐藏/再现)的系统里漏判 —— 兜底注释只论证了它考虑到的场景(startup),漏了同文件另一特性(workspace 过滤)引入的重现。修法:兜底加「首次/已见」判别(everAdded),把「属性兜底」收窄到真正的首次。与 R24(反转刻意 P0 设计 → DEFER)区别:此处注释推理**不完整**(漏 case)而非错误,补判别是修真 bug 非反转设计。R1-R23/R25 共 24 修 + R24 DEFER。

## R26 — useDockReconciler [api] effect 在 api 重建后不补建现有 terminal panel (P2)

- **文件**: `src/shell/dock/DockReconciler.ts:151`(`useDockReconciler` 的 `[api]` effect)
- **问题**: `[api]` effect 用 `previousSessionsRef.current` 与当前 store sessions 做 diff,只对「新增」session 建 panel。当 api 变更(dockview 重建 / onReady 重入 / HMR / StrictMode,均在 R22 注释中被承认)时,新 DockviewApi 是一个**全新空 dock**,但 `previousSessionsRef.current` 仍是上个 api 的旧 sessions → 现有 terminal session 被判「非新增」→ 在新空 dock 中不补建 → 终端消失,直到 sessions 再变化才恢复。
- **关键前提确认**: `sanitizePersistedDockLayout`(DockShell.tsx:55)在持久布局含任何 `contentComponent===TERMINAL_PANEL_TYPE` 的 panel 时返回 `null`(整体弃用 → 落回默认布局)。即**terminal panel 永不从 fromJSON 恢复**,只由本 reconciler 从 terminal.store 建。所以 api 重建后没有任何其它路径会补回终端 → reconciler 漏建 = 终端真消失。
- **修复**: `[api]` effect 的 `previousSessions` 改为 `[]`(而非 `previousSessionsRef.current`)。该 effect 仅在 api 引用变化时运行,新 api 总对应全新空 dock,故一律视作空、让现有 sessions 全量重建;reconciler 内 `getPanel` 守卫防重复 add。首次挂载时 ref 本就是 `[]`,行为不变。
- **测试**: 新增 `src/__tests__/dock-reconciler-api-rebuild/api-rebuild.spec.tsx`(jsdom + renderHook):api 重建 + store sessions 不变 → 现有 session 在新 api 重建(单/多 session)+ 首次挂载空 store 不建 panel(行为不变)。
- **沉淀**: 「跨 effect 用 ref 记上次状态做增量 diff」在**依赖项(api)本身会被换成全新空实例**时漏判 —— ref 记的是「逻辑上的上次 sessions」,但它对应的是**旧容器**;新容器是空的,逻辑增量 diff 不等于物理增量 diff。修法:当容器(api)换新时把基线重置为空(全量重建),而非沿用上一个容器的基线。与 R25 同属 DockReconciler 在「重建/重现」场景的时序漏判族,但 R25 是焦点误抢(多做),R26 是 panel 漏建(少做)。R1-R23/R25/R26 共 25 修 + R24 DEFER。

## R27 — workspace root 异步选择的「最新者胜」守卫按入口分裂,跨入口不互相失效 (P2)

- **文件**: `src/shell/App.tsx`(drop)、`src/panels/Explorer/open-recent-root.ts`(打开最近)、`src/panels/Explorer/EmptyWorkspace.tsx`(打开)、`src/panels/Explorer/ExplorerHeader.tsx`(切换)
- **问题**: 一个窗口只有一个 workspace root,上述 4 个入口都异步选择后 setRoot 同一目标,但守卫分裂:drop 用 App 组件级 `dropGuardRef`(R18)、打开最近用 open-recent-root 模块级 `recentOpenGuard`(R19)、EmptyWorkspace/ExplorerHeader 的 selectDirectory **完全无守卫**(仅各自 `busy` 本地态防同组件重入)。不同入口的守卫互不失效 → 拖入目录 A 的异步探测未完成时,用户点击「最近」B(或对话框选 B)成功切到 B,随后 A 迟到 resolve 仍 `setRoot(A)`,打开错误 workspace 并触发 tab/session/layout 持久化写入错误 root。
- **修复**: 新增模块级单例 `src/lib/workspace-root-guard.ts` 导出 `workspaceRootSelectionGuard = createLatestGuard()`。4 个入口全部改用此共享守卫:发起选择时 `begin()`,`await` 后 `isLatest()` 判定;任一入口的 `begin()` 都作废其它入口在途选择(全局 last-wins)。drop 去掉 per-component `dropGuardRef`(顺带移除 App.tsx 不再使用的 `useRef` 导入);open-recent 去掉私有 `recentOpenGuard`;EmptyWorkspace/ExplorerHeader 的 selectDirectory 加 `begin()` + 三出口(setRoot/error/cancel)`isLatest()` 守卫(过期请求静默,由最新入口负责反馈)。
- **测试**: 新增 `src/__tests__/workspace-root-selection-guard/shared-guard.spec.ts`(openRecent 在途时外部 `begin()` → 结果丢弃 / 失败也不抢报 / 控制组正常 setRoot)+ empty-workspace.spec 与 explorer-header.spec 各 +1(对话框结果落地前另一入口接管 → 不 setRoot)。证明每个入口确实用共享守卫:若某入口仍用私有/无守卫,外部 `begin()` 不会作废它 → setRoot 会被调用(回归)。
- **沉淀**: 「同一目标资源(workspace root)的多个异步选择入口各自建独立 latest 守卫」= R18/R19 分轮加守卫却未意识到应共享,典型「防御/helper 建了未传播到所有兄弟入口 + 平行实例各自为政」族。守卫的作用域必须匹配它保护的资源作用域:资源是单例(一个 root)→ 守卫也必须是单例,否则跨入口乱序覆盖照样发生。修法:抽全局共享守卫,grep 所有 setRoot 兄弟入口统一接入。R1-R23/R25/R26/R27 共 26 修 + R24 DEFER。

## R28 — 关闭文件夹(同步 setRoot(null))不作废在途异步 root 选择 (P2) — R27 直接遗漏边

- **文件**: `src/panels/Explorer/ExplorerHeader.tsx:264`(关闭文件夹 MenuItem)
- **问题**: R27 收口了 4 个**异步** root 选择入口共用 latest 守卫,但关闭文件夹是**同步** `setRoot(null)`,没参与守卫。它同样是对 workspace root 的更新:若用户先触发一个仍在途的打开/拖入/recent 选择,再点关闭文件夹,旧异步选择迟到 resolve 时 `isLatest()` 仍为真(关闭没 bump seq)→ 重新 `setRoot(oldPath)`,关闭被撤销,后续 tab/session/layout 持久化也写回错误 root。
- **修复**: workspace-root-guard 加 `cancelPendingWorkspaceRootSelection()`(内部 `workspaceRootSelectionGuard.begin()` 一次,bump seq 作废所有在途异步选择;同步入口不 await、无需自己的 isLatest)。关闭文件夹 onClick 在 `setRoot(null)` 前调用它。
- **测试**: shared-guard.spec +1(`cancelPendingWorkspaceRootSelection()` 作废在途 openRecent → 不 setRoot)+ explorer-header.spec +1(切换文件夹在途时点关闭文件夹 → 迟到 selectDirectory resolve 不撤销关闭,root 保持 null)。
- **沉淀**: last-wins 守卫的常见漏边——**只守住了异步入口,漏掉同步入口**。同一资源的「所有变更入口」(不分同步/异步)都必须参与同一 last-wins 排序:同步变更虽不 await,但它发生在某个时间点,任何更早发起、更晚 resolve 的异步操作都应被它作废。修法:抽 `cancel*()` helper 让同步变更也 bump 守卫代际。codex 沉淀的「latest guard 常见漏边=同步状态变更」精准。R1-R23/R25-R28 共 27 修 + R24 DEFER。

## R29 — 插件停用 _unregisterPlugin reject 致 token 回收半提交 + 状态卡死 (P1)

- **文件**: `src/plugins/PluginManager.ts` `revokePluginFsToken()`(原 471-476)+ `activateEntry()` token 注册段(原 420-422)
- **问题**: `revokePluginFsToken` 先 `entry.pluginFsToken = undefined` **再** `await _unregisterPlugin(token)`。若 unregister IPC reject:(1) 本地丢 token、main 侧 token 可能仍有效 = 不可回收的 plugin-fs capability 泄漏;(2) 异常上抛 → `deactivateEntry` 的 finally(已先 `entry.instance = undefined`)半提交,`disableLocked` 在 `await deactivateEntry` 处抛出,status 没落到 'disabled' → entry 卡在 status='enabled' + instance=undefined;(3) 再次 disable 被 `disableLocked` 的 `if (entry.status!=='enabled' || !entry.instance) return` 早退(instance 已空)→ 永远无法重试回收 token / 修正状态。
- **修复**: (1) `revokePluginFsToken` 改 try/catch:**仅 unregister 成功后才清 token**;失败保留 token + 不抛(本地拆除照常完成,status 正常落 'disabled',token 仍被追踪可重试)。(2) `activateEntry` 在 `_registerPlugin` 前先 `await this.revokePluginFsToken(entry)` flush 残留旧 token(上次回收失败保留的),否则下一行 `entry.pluginFsToken = newToken` 覆盖旧 token 引用 → 永久泄漏。生命周期锁串行化同 id,无并发 deactivate 竞争。
- **测试**: 新增 `src/__tests__/plugin-fs-token-revoke-retry/token-revoke-retry.spec.ts`(3 例):disable 时 unregister reject → 不抛 + status='disabled'(不卡 enabled)/ 回收失败保留 token → 再启用先用旧 tok1 重试回收再注册 tok2(证明 token 未丢)/ 正常 disable 成功即清 → 再启用不重复回收(flush 无残留)。
- **沉淀**: 「清状态在 await 之前」是回收/撤销类操作的经典半提交陷阱 —— 异步操作未确认成功就先把本地引用清掉,失败时既丢了重试依据又留下不一致状态(本地以为已撤、远端仍在)。修法铁律:**清本地引用必须在远端确认成功之后**(commit-after-ack),失败保留引用 + best-effort 不抛 + 提供重试入口(此处 = 下次激活前 flush)。与 [[topic_54_data_safety_audit_codex]] 的「promise reject 未清 in-flight / 半提交 cache」同族,本例是 capability token 维度。R1-R23/R25-R29 共 28 修 + R24 DEFER。

## R30 — DockShell onReady(async)await layout.read() 后无 stale/mounted 守卫 (P1)

- **文件**: `src/shell/dock/DockShell.tsx` `onReady`(await layout.read 之后)+ unmount cleanup effect
- **问题**: onReady 是 async,`await coApi.layout.read()` 期间可能发生 dockview 重建 / StrictMode / onReady 重入(新 onReady 把 apiRef.current 指向新 api)或组件卸载。R22 已处理「注册前先 disposeDockListeners 清旧」,但漏了 **async 交错**:一个旧 onReady 在新 onReady 完成后才从 await 恢复,继续对 stale `event.api` 跑 fromJSON/applyDefaultLayout、`setDockApi`/`setEmpty` 覆盖新实例、`disposeDockListeners()` 清掉**新实例**刚注册的 listener、再把 debounce/flush listener 绑到**旧 api**(布局保存/关闭 flush 指向旧 dock、panel 事件丢失),以及卸载后 setState。
- **修复**: onReady 在 `await layout.read()` 之后、使用 event.api 之前加守卫 `if (apiRef.current !== event.api) return;`。apiRef.current 在每次 onReady 入口同步赋值 → 较新的 onReady 会把它改成新 api,使旧 onReady 恢复时判定过期提前返回;unmount cleanup 置 `apiRef.current = null` → 卸载后恢复的 onReady 同样过期返回(防卸载后副作用)。onReady 内 await 之后无其它让权点,单一守卫足够。
- **测试**: dock-layout-restore-feedback.spec +1:layout.read 返回 pending promise → render(onReady park)→ unmount → 迟到 resolve → 断言 regCount 不超过 baseline(过期 onReady 不再注册它的 4 个 onDid*)。临时移除守卫验证回归(regCount 1→5)。
- **沉淀**: 「async 回调跨 await 后对捕获的实例继续副作用」必须有 stale/mounted 守卫 —— 与 R26(同 DockReconciler 的 api 重建漏建)、R18/R19/R27(latest-wins)同源:任何「发起时捕获目标、await 后落地」的逻辑都要在落地前复核目标仍是最新/仍挂载。React 里复用已有的「入口同步写 + 卸载置空」的 ref(apiRef)即可,无需新代际计数。R22 修了同步重入的 listener 清理却漏了异步交错的 stale-resume,属「守卫建了但没覆盖 async 让权点」族。R1-R23/R25-R30 共 29 修 + R24 DEFER。

## R31 — terminal create 期间关 tab 留下不可见孤儿 PTY (P1)

- **文件**: `electron/main/ipc/terminal.ipc.ts` `makeCreateHandler`(add 在 await createTerminal 之前)+ `makeRemoveHandler`(service.has 门控 kill)
- **问题**: makeCreateHandler 先 `sessionStore.add()`(可见 reservation,R19 为接住 spawn 期极速退出的 setExited 而提前),再 `await service.createTerminal()`(PTY 在 await 期间才真正建立)。这段窗口内用户关 tab → makeRemoveHandler `sessionStore.remove(id)` 删 metadata,但 `if (service.has(id)) service.kill(id)` 时 PTY 还没建 → has 为 false → **不 kill**;随后 createTerminal resolve 出真实 PTY,而 metadata 已删 → renderer 看不到、无法经 UI 关闭 = 不可见孤儿终端/进程(资源 + 子进程泄漏)。
- **修复**: makeCreateHandler 在 createTerminal resolve 后复查 reservation:`if (!sessionStore.get(id))` 说明该 session 已被 remove 取消(区别于 exit-during-create —— 那条走 setExited **保留** metadata 故 get(id) 仍在)→ `if (service.has(id)) service.kill(id)` 杀掉刚建的孤儿 PTY,并抛 `TERMINAL_CREATE_CANCELLED` 不返回成功。createUserTerminal 的 catch 把该 code 当静默 no-op(用户主动关 tab,非失败,不弹 toast)。新增 error code + en/zh/ko catalog + enum count 35→36。
- **测试**: 新增 `src/__tests__/terminal-create-cancel-orphan/create-cancel-orphan.spec.ts`(3 例):create 期间 remove → kill 孤儿 + 抛 CANCELLED / 正常 create 不 kill 返 {id} / exit-during-create 保留 metadata 不误判取消(R19 兼容);并把 terminal-ipc.spec 的 mock store 改为有状态(add 后 get 返回 session,模型真实 store —— 原 stateless `get: vi.fn()` 恒 undefined 会被新检查误判)。
- **沉淀**: 「先广播可见占位 → await 建真实资源」的 reservation 模式有 TOCTOU 取消窗口:占位可被并发 remove 取消,但取消方据「真实资源是否已建」(service.has)决定是否清理,而资源恰在 await 期间从无到有 → 取消方查到「还没建」放过,创建方 await 后建出 → 孤儿。修法:创建方在 await 后**复查占位是否仍在**(取消方留下的删除态),已取消则自行清理刚建的资源 + 不返回成功(commit-or-rollback after ack)。与 R29(commit-after-ack)、R30(async 落地前复核)同源:凡「发起时登记、await 后落地」都要在落地前/后复核登记仍有效。R1-R23/R25-R31 共 30 修 + R24 DEFER。

## R32 — plugin-mcp 反向 invoke send 到已销毁 wc 静默 no-op,pending 干等 30s (P2)

- **文件**: `electron/main/ipc/plugin-mcp.ipc.ts` send 回调(原 68-75)+ `electron/main/services/plugin-mcp-bridge.service.ts` createInvokeRemote
- **问题**: createInvokeRemote.invoke 先 `pending.set(requestId, ...)` 再 `send(...)`。IPC 层 send 在 `webContents.fromId(owner.wcId)` 已不存在/destroyed 时只 `return`(静默 no-op),不通知 core 清 pending。外部 agent 调用 plugin MCP tool 的同时插件窗口刚销毁时:`destroyed` cleanup(handleWebContentsGone→abortByWebContents)可能已先跑完,随后这次**更晚登记**的新 pending 无人 abort → 只能等 30s INVOKE_TIMEOUT,表现为 agent 的 tools/call 卡死。
- **修复**: send 契约改返 `boolean | void`:wc 已销毁返 `false`,成功返 `true`(旧 void 桩视作已投递)。invoke 在 `delivered === false` 或 send **抛错**时立即 `pending.delete(requestId)` + `timer.cancel()` + `reject(PLUGIN_GONE)`,不等 timeout。PLUGIN_GONE code 已存在(abortByWebContents 复用同 code)。
- **测试**: 新增 `src/__tests__/plugin-mcp-send-fail-abort/send-fail-abort.spec.ts`(4 例):send false → 立即 reject PLUGIN_GONE + 清 pending + cancel timer / send 抛错同样 / send true 正常等 reply / send void 向后兼容仍 pending。既有 plugin-mcp e2e/stub/unregister 测试(send: vi.fn() 返 void)不受影响。
- **沉淀**: 「登记 pending → 异步投递,投递失败静默 no-op」= 又一例 fire-and-forget 假成功(与 R3/R4/R29 同族,但这里是「投递通道断了不回执」)。pending/in-flight 表的每个登记都必须有**对应的失败结算路径**:投递层失败必须可见(返失败/抛)并回传给登记层立即结算,否则只能靠 timeout 兜底(用户/agent 卡到 timeout)。尤其当「另有一条 cleanup 路径(destroyed→abort)只清它扫到的 pending」时,登记与 cleanup 的时序竞争会漏掉晚登记的那条 → 投递点自身必须能失败。R1-R23/R25-R32 共 31 修 + R24 DEFER。

## R33 — co:// 深链冷启动:onProtocolUrl 订阅晚于 did-finish-load 推送丢事件 (P2)

- **文件**: `src/main-app.ts`(co:// 接线)+ 新增 `src/plugins/protocol/wire-protocol-url.ts`
- **问题**: renderer 把 `coApi.plugins.onProtocolUrl(cb)` 订阅写在 `import('./plugins/protocol/handler').then(...)` 里 —— preload 的 onProtocolUrl 是同步挂 `ipcRenderer.on`,但它要等动态 import 的**微任务** resolve 才被调用。而 main 冷启动在 `win.webContents.once('did-finish-load')` 里只 `send(PROTOCOL_URL)` 一次、无 replay/缓冲(index.ts:881-899)。若 import 晚于 did-finish-load,事件投到一个还没挂 listener 的 renderer → 丢失:用户点 co:// 链接应用打开却不执行命令/路由(冷启动偶发)。
- **修复**: 抽 `wireProtocolUrl(deps)`(listener-before-async-work,R16 同族):**同步**调 onProtocolUrl 注册监听(初始同步执行阶段就位,早于 did-finish-load),handler 推迟到回调里 lazy-load(无 url 到达不拉 chunk)+ onError 可见。main-app.ts 改用它。
- **测试**: 新增 `src/__tests__/protocol-url-listener-before-load/wire-protocol-url.spec.ts`(3 例):onProtocolUrl 在 wireProtocolUrl 返回前被同步调用(旧实现此处 registered=false=回归点)+ handler 懒加载未提前拉 / url 到达 → lazy-load 并以 (url,app) 调 handler / handler 失败 onError 可见不抛。
- **沉淀**: 「先 import 再订阅」把监听注册推到动态 import 微任务之后,与「main 启动握手只推一次无 replay」相撞 = lost-event(与 R16 init-then-subscribe、scan-then-watch 同族)。铁律:跨进程/跨异步边界的**一次性**通知,接收端必须**先挂监听再做异步加载**(listener 同步就位,处理逻辑可懒加载);或发送端 ack 后再 drain pending。凡「订阅在 await/import 之后」都要查它是否会错过更早的一次性事件。R1-R23/R25-R33 共 32 修 + R24 DEFER。

## R34 — editor saveFileNow 跨 await 与 Explorer rename/move 的 stale-path 写 (P1) — DEFER(架构:id≡path 耦合)

- **文件**: `src/panels/Editor/editor-file-actions.ts:118` saveFileNow(`await fs.writeFile(tab.filePath, ...)`)
- **codex 报告**: saveFileNow 写盘前捕获旧 tabId/filePath;await 期间 Explorer 的 rename/move 调 `renamePath` 把同一 tab 的 **id+filePath 一起改成 newPath**(editor.store renamePath:`id===filePath`)。迟到的写仍落到旧 path(文件级改名时在旧 path 重建孤儿文件),完成后 `markSaved(oldTabId)` 因 id 已变成 newPath 而 no-op(renamed tab 脏态没清)。rename/move 与 autosave(2s 防抖)/手动保存并发时:旧路径孤儿文件 / 已保存内容未标记 / 后续覆盖。
- **核查**: 属实。根因是 editor.store 的 **`tab.id ≡ filePath`** 设计(createTab:`id: filePath ?? untitled-uuid`;renamePath 同步改 `id+filePath`)。saveChains(R21)只按 tabId 串行**同 tab 的多次保存**,不与 rename 互斥;rename 在 writeFile 的 await 期间插入即触发。`save` 在 rename **之前**完成的情形已安全(saveFileNow 同步 find by tabId 找不到 → TAB_NOT_FOUND 早退);唯一不安全是 rename 发生在 **writeFile await 期间**,此时写已在途无法撤销。
- **DEFER 理由(架构权衡,非刻意设计但完整修复=多站点跨模块重构)**:
  1. **完整修复二选一,均非平凡**:(a) 解耦 `tab.id` 与 `filePath`(引入稳定合成 id)—— id 作为 path 派生 key 遍布 store/dock/reconcile/open/save 全链,大改;(b) editor-save 与**所有** rename/move/remove 站点(`mutate-actions.renameItem` + FolderTree 单 rename:173 + drag-move:214/510/638 + removePath)共享路径互斥。
  2. **路径精确锁无法覆盖目录操作**:目录改名/移动按**前缀**影响子文件 tab(`isSameOrInsidePath`),按 exact path 上锁的 save 与按目录 path 上锁的 rename 键不同 → 不串行,目录场景竞态仍在。要正确需前缀感知锁,更复杂。
  3. **触发窗口窄**:需保存(autosave 防抖落盘 / Cmd+S)恰在某文件 rename/move 的 writeFile await 期间;非常态路径。
  4. 局部「写后复检 markSaved」对核心损害(孤儿写)无效(写已在途);收益 < 多站点改动风险。
- **结论**: 按「架构权衡项不擅自大重构 + 先留 user 决策」(对照 R24)DEFER。建议 follow-up:优先 (a) 稳定合成 tab id(从根上消除 id 随 path 漂移),一并简化 rename/markSaved 失配。已告知 codex 跳过,继续其余竞态点。R1-R23/R25-R33 共 32 修 + R24/R34 DEFER。

## R35 — PermissionEditorModal save 无 in-flight 门控,迟到 onClose 丢弃保存后改动 (P2)

- **文件**: `src/plugins/permissions/PermissionEditorModal.tsx:83` save()
- **问题**: save() 按点击瞬间的 decisions 取快照,`await store.grant/deny` 后**无条件 onClose()**;期间 checkbox/Save 仍可操作(只有 R23 的 load 侧 loading 门控,save 侧无)。用户点保存后又改 checkbox → 迟到的旧保存 onClose 关闭弹窗,新改动既没写入也无提示;双击 Save 还会重复排队同一批 grant/deny 写入。是 R23(load 侧 loading 门控)的 **save 侧对偶缺口**。
- **修复**: 加 `saving` 状态。save() 入口 `if (saving) return`(重入守卫)+ `setSaving(true)`,finally `setSaving(false)`;checkbox 与 Save 按钮 `disabled` 增加 `|| saving`。写盘期间不允许继续编辑同一份 decisions / 不允许重复提交;完成(onClose)或失败(保持打开重试)后清除。Cancel 保留可用(逃生)。
- **测试**: permission-editor-modal.spec +2:grant 阻塞期间 checkbox+Save 禁用、完成后 onClose / 双击 Save 仅排队一次 grant(重入守卫)。
- **沉淀**: 「表单提交 = 取快照 → await 写 → 无条件关闭」在写盘 await 期间放任继续编辑 = 提交后改动被关闭丢弃 + 可重复提交,与 R23(表单加载期放任编辑被回填覆盖)是同一表单的**加载/保存两侧对偶**。铁律:异步表单的 load 与 save 两个 await 窗口都要门控交互(loading / saving 各一),且提交要重入守卫。修一侧必查另一侧对偶(防御未传播族)。R1-R23/R25-R33/R35 共 33 修 + R24/R34 DEFER。

## R36 — SET_LOCALE 广播用「已发起 gen」判定,后发起者失败压掉先成功者广播 (P2)

- **文件**: `electron/main/ipc/i18n.ipc.ts:42` + `electron/main/services/settings.service.ts` setCurrentLocale/gen
- **问题**: `setCurrentLocale` 在 `await saveSettings` **之前** `++setLocaleGen`(已发起 gen);handler 用 `gen === getSetLocaleGen()` 决定是否广播 CHANGED + 重建菜单。若请求 A(gen1)写盘成功、请求 B(gen2)随后发起把 setLocaleGen 推到 2 但 B 写盘**失败**:A 的 gen1 ≠ getSetLocaleGen()(2) → A **不广播**;B 失败 → 也不广播。磁盘 = locale_A、发起 A 的窗口已切,但**其它窗口 + 菜单仍停旧语言**,直到下次成功切换才收敛。把「请求已发起」与「请求已成功提交」混为一谈。
- **修复**: 新增 `committedLocaleGen` + `commitSetLocaleGen(gen): boolean`(只被**成功写盘**的调用推进:`gen > committedLocaleGen` 才推进并返 true)。handler 改为 `const gen = await setCurrentLocale(locale); if (commitSetLocaleGen(gen)) { 重建菜单 + 广播 }`。setCurrentLocale 写盘失败会上抛 → 根本不到 commit,故失败调用不碰 committedLocaleGen、不压先成功者;乱序提交时旧 gen ≤ committed 返 false 不覆盖。setLocaleGen(已发起 gen)保留供排序/兼容。_resetSettingsForTest 重置 committedLocaleGen。
- **测试**: 新增 `src/__tests__/i18n-set-locale-commit-gen/commit-gen.spec.ts`(4 例,纯 gen 语义):单调推进 / R36 核心(后发起失败=从不 commit 不影响先成功者)/ 乱序过期不覆盖 / reset;并更新 main-menu-rebuild + popout-locale-broadcast 两 handler 测试的 mock 加 `commitSetLocaleGen: () => true`。
- **沉淀**: latest-wins/代际守卫的「发起 gen 在 await **前**自增」陷阱 —— 用「已发起」当「最新有效」会让**后发起但失败**者压掉**先发起且成功**者(失败者只动了 gen 没动状态)。铁律:决定「最新有效结果」的代际必须在**成功提交后**推进(committed gen),不是发起时(initiated gen);失败/过期请求不得推进 committed。与 R18/R19/R27(latest guard begin 后必有 isLatest 落地判定)同族,本例补「落地判定要基于 committed 而非 initiated」。R1-R23/R25-R33/R35/R36 共 34 修 + R24/R34 DEFER。

## R37 — useFsWatcher 失败撤销无代际校验,误删 re-expand 后的成功记账 (P2)

- **文件**: `src/panels/Explorer/hooks/useFsWatcher.ts:40`(watchDir 失败撤销分支)
- **问题**: R14 给 watchDir 加了「乐观记账 installed.add + 失败撤销 installed.delete」,但撤销**无代际校验**。旧 expand /a 的 watchDir 仍在途时,用户 collapse /a 再 re-expand /a,第二次 watch 成功后,**第一次迟到**的 ok:false/reject 会无条件 `installed.delete('/a')` → renderer 账本丢掉第二次已成功安装的 watcher。后果:后续 collapse 因 /a 不在 installed 而**不 unwatchDir**(main 侧 watcher 泄漏),或之后重复 watchDir('/a') 增 refCount(重复引用)。
- **修复**: 加 `watchGenRef: Map<path, gen>`。每次 add/remove 对该 path `bumpGen`;add 分支捕获 `myGen`,失败撤销改为 `if (!r.ok && watchGen.get(p) === myGen) installed.delete(p)`(catch 同)。collapse/re-expand 会把代际推进,使第一次在途尝试的迟到失败撤销因代际不匹配而跳过,不动第二次的记账。
- **测试**: use-fs-watcher.spec +1:第一次 watchDir('/a') 在途 → collapse → re-expand(第二次成功)→ 第一次迟到 reject → 再 collapse 应 unwatchDir('/a')(证明 installed 仍含 /a)。临时移除代际校验验证回归(该断言失败)。
- **沉淀**: 「乐观记账 + 异步失败撤销」也是 latest-wins 的一种 —— 撤销必须代际守卫,否则**过期尝试的失败**会撤销**更新尝试的成功**(与 R26/R36/R18/R19/R27 同族:任何「发起时登记、await 后撤销/落地」都要 begin→isLatest)。尤其「同一 key 可被快速 remove→re-add」的记账(watcher/订阅/pending)失败回滚必须确认仍是当前代际。R1-R23/R25-R33/R35/R36/R37 共 35 修 + R24/R34 DEFER。

## R38 — 启动 hydrate 迟到覆盖 read 期间的用户 workspace 选择 (P1)

- **文件**: `src/lib/persist/explorer-persist.ts` initExplorerPersistence(`await api.read()` 后的 hydrate)
- **问题**: initExplorerPersistence 是 fire-and-forget,main-app 调用后立即 `createRoot().render()`。冷启动磁盘/IPC 慢时,UI 先以 root=null 渲染、EmptyWorkspace 可交互;用户经 EmptyWorkspace/drop/recent 选了新 workspace B(setRoot)。随后旧 explorer.json 读取完成 → `hydrateStores`/`hydrateStoresForNewWindow` 的 `useWorkspaceStore.setState({ root: A, ... })` **覆盖** B(连 recent/pinned/layout/editor 一起回退旧快照),之后写订阅持久化错误 workspace。只有终端 cwd 读取显式 `waitForWorkspaceHydrated`,普通 root 选择入口没等这个标志。
- **修复**: 复用 R27 的 `workspaceRootSelectionGuard`。initExplorerPersistence 在 `await api.read()` **之前** `const isLatestRootSelection = workspaceRootSelectionGuard.begin()`(把本次启动恢复登记为「当前 root 选择」)。read 返回后,若 `!isLatestRootSelection()`(read 期间有任何用户 root 选择 / 同步 root 变更经同一守卫 begin 过)→ 跳过所有 hydrate-into-stores(及随后 editor tabs restore,因 hydratedSnap 保持 null),避免覆盖用户选择;`loadTrusted` 仍为 true,照常注册写订阅持久化用户当前选择。与 R27/R28 全局 last-wins 守卫统一。
- **测试**: 新增 `src/__tests__/explorer-hydrate-vs-user-root/hydrate-vs-user-root.spec.ts`(2 例):read 在途时用户 begin()+setRoot('/userPicked')→ 迟到 hydrate 跳过(root 保持 userPicked、不灌旧 expanded)/ 控制组无用户选择正常 hydrate '/old'。临时移除守卫验证回归(root 被覆盖回 '/old')。
- **沉淀**: 「fire-and-forget 启动 hydrate + UI 立即可交互」= hydrate 与用户输入竞争(R23/R35 表单 load 侧的应用级版本)。凡「异步加载完成后 setState 回填」都要防它覆盖加载期间的用户操作 —— 此处把「启动恢复」也纳入 workspaceRootSelectionGuard 的 last-wins:启动恢复是「最早的一次 root 选择」,任何更晚的用户选择都该胜。守卫的资源作用域(workspace root)再次证明要覆盖**所有**写该资源的入口,包括启动恢复。R1-R23/R25-R33/R35/R36/R37/R38 共 36 修 + R24/R34 DEFER。

## R39 — co:// 深链 main 分发投给未就绪窗口而丢失 (P2) — R33 同族 main 侧残留

- **文件**: `electron/main/index.ts:474` dispatchProtocolUrl + 新增 `electron/main/protocol-dispatch.ts`
- **问题**: dispatchProtocolUrl 只在 `wins.length === 0` 时缓冲(pendingProtocolUrl,由 createMainWindow did-finish-load drain);否则无脑 `webContents.send(PROTOCOL_URL)` 给所有未销毁窗口。但窗口**已创建却还在 loading**(renderer 未 did-finish-load、preload onProtocolUrl 还没挂 ipcRenderer.on)时,send 投给没有 listener 的 renderer → 丢失。运行中第二实例 / macOS open-url 在启动或新窗加载空窗期到达 → co:// 深链应用聚焦却不执行命令。R33(renderer 侧 listener-before-send)同族在 **main 分发侧**的残留。
- **修复**: 抽 `routeProtocolUrl(url, deps)`:只投给「已就绪(`!webContents.isLoading()`)」的窗口;无就绪窗口 → 缓冲 pendingProtocolUrl + 给当前所有 loading 窗口挂一次性 `did-finish-load` drain(`getPending()===url` 守卫防与 createMainWindow drain 重复投递)。冷启动「无窗口」仍走 setPending 由 createMainWindow drain 兜底。dispatchProtocolUrl 改调它。R33 已保证 renderer onProtocolUrl 在脚本同步执行期就挂(早于 did-finish-load),故「!isLoading() ⟹ listener 已挂」成立。
- **测试**: 新增 `electron/main/__tests__/protocol-dispatch.test.ts`(6 例):就绪立即 send / loading 窗口不发而缓冲+drain(回归点)/ 无窗口仅缓冲 / 混合就绪+loading / drain 守卫防重复 / 已销毁窗口不收。
- **沉淀**: 「一次性事件投给跨进程接收端」的就绪判定不能只看「接收端是否存在」,要看「接收端是否**已挂 listener**」。`wins.length===0` 只排除了「没有窗口」,漏了「窗口存在但 renderer 未就绪」的空窗期 —— 与 R33 同根(listener-before-send),发送端也要 readiness-gate(isLoading)+ 未就绪则缓冲到 ready 再 drain。R1-R23/R25-R33/R35-R39 共 37 修 + R24/R34 DEFER。

## R40 — co:// 深链缓冲单槽,无就绪窗口期并发深链 last-write-wins 丢失 (P2)

- **文件**: `electron/main/protocol-dispatch.ts` + `electron/main/index.ts`(pendingProtocolUrl)
- **问题**: 协议 URL 缓冲是单槽 `pendingProtocolUrl: string | null`(R39 沿用既有设计)。无就绪窗口期间(冷启动 / 窗口 loading)连续到达的多个 co:// 会互相覆盖 —— 后到的 setPending 冲掉先到的,只剩最后一个;每个 loading 窗口的 drain 也只检查「当前 pending === 自己捕获的 url」。连续触发两个深链时**先到的命令永久丢失**,只执行最后一个。
- **修复**: 把缓冲从单槽 string 改为 FIFO 队列 `pendingProtocolUrls: string[]`。routeProtocolUrl 无就绪窗口时 `pending.push(url)`(不覆盖),did-finish-load 后用 `drainPendingProtocolUrls(wc, channel, pending)` 一次性按序排空整个队列并清空;多个 loading 窗口时第一个就绪者排空、其余见空队列 no-op(不重复投递)。有就绪窗口时也先排空残留队列再发本次(FIFO)。createMainWindow 的冷启动 drain 同样改用 drainPendingProtocolUrls 排空队列(单槽时代只发最后一个)。
- **测试**: protocol-dispatch.test.ts 重构为队列签名 + 新增 R40 4 例:连续两深链都入队按序 drain / 两 loading 窗口第一个排空第二个 no-op / 有就绪窗口先排空残留再发 / drainPendingProtocolUrls 一次性排空。
- **沉淀**: 「缓冲一次性事件」用单槽 = 并发到达 last-write-wins 丢事件(与 R32 pending-map 不同:那是漏清,这是容量为 1)。凡「就绪前缓冲、就绪后重放」的通道,缓冲必须是**队列**(可容纳就绪窗口期内到达的全部),不能是单值;重放按 FIFO 一次性排空。R39 修了「投给未就绪窗口丢失」,R40 修了「缓冲容量为 1 丢并发」——同一通道两个独立缺陷。R1-R23/R25-R33/R35-R40 共 38 修 + R24/R34 DEFER。

## R41 — 协议队列 drain 只挂 bootstrap 窗口,后续新窗口不消费 (P1) — R39/R40 同通道残留

- **文件**: `electron/main/index.ts`(pendingProtocolUrls drain 兜底)+ `electron/main/protocol-dispatch.ts`
- **问题**: dispatchProtocolUrl 无就绪窗口时把 URL 入 `pendingProtocolUrls`,但队列 drain 兜底只在 **bootstrap 段**(whenReady 里那个 win)注册一次,且只在「当时队列非空」时挂。后续 `createMainWindow`(newWindow / openPathInNewWindow / macOS activate / 窗口恢复)创建的窗口**不 drain 队列**。macOS 应用已运行但无窗口(全关)、或原 loading 窗口被关时收到 co:// → 深链入队后无人消费,永久挂队列直到下一次协议事件偶然触发带就绪窗口的 dispatch(routeProtocolUrl ready-path 才顺带排空)。R39/R40 同通道的第三个残留。
- **修复**: 抽 `attachWindowDrain(win, channel, pending)`(一次性 did-finish-load → 未销毁则 drainPendingProtocolUrls),在 **createMainWindow** 内对每个新窗口调用。bootstrap 窗口同样经 createMainWindow 创建,故移除 whenReady 里冗余的 bootstrap drain 块。drain 幂等(队列空 no-op),与 routeProtocolUrl 给 loading 窗口挂的 drain 重叠安全。pendingProtocolUrls 声明上移到 createMainWindow 之前(供闭包引用,避免 use-before-define)。
- **测试**: protocol-dispatch.test.ts +3(attachWindowDrain):就绪后排空队列 / 就绪时已销毁不发(留给下一个窗口)/ 队列空 no-op(幂等)。共 12 例。
- **沉淀**: 「就绪后重放缓冲」的 drain 必须挂在**所有**可能成为「下一个就绪接收者」的窗口上,不能只挂创建时机恰好赶上的那一个。兜底逻辑写在「一次性的 bootstrap 流程」里 = 只覆盖启动那一个窗口,后续入口(新窗/activate/恢复)全漏 —— 与「防御建了未传播到所有兄弟入口」同族,这里的「兄弟入口」是「所有窗口创建路径」,收口到 createMainWindow 单一来源。R39(投未就绪丢)+R40(单槽丢并发)+R41(drain 只挂一个窗口)= 同通道三个独立缺陷,逐层收敛。R1-R23/R25-R33/R35-R41 共 39 修 + R24/R34 DEFER。

## R42 — 关窗 layout:flush 回调闭包捕获 stale api,重入后用旧 api 写盘 (P1)

- **文件**: `src/shell/dock/DockShell.tsx:295` flush-request effect
- **问题**: flush listener 的 effect 只依赖 `[apiReady]`、只注册一次,回调里用的是 effect 运行时 `const api = apiRef.current` **闭包捕获**的实例。若 Dockview onReady 重入/重建(HMR/StrictMode/dockview rebuild)把 apiRef.current 换成新 api(effect 不会因 [apiReady] 不变而重跑),关窗 `layout:flush-request` 仍用**旧 api** 执行 writeDockLayoutSnapshot → 关窗落盘旧 dock 布局,当前窗口的 panel 增删/移动被 stale snapshot 覆盖或丢失。
- **修复**: 回调内改为**执行时**读 `const api = apiRef.current`(而非注册时捕获)+ `if (api)` 守卫。apiRef.current 由 onReady 同步更新、卸载置 null(R30 同款基准),故 flush 总用最新 api;卸载/无 api 时跳过写盘不报错。
- **测试**: layout-restore-feedback.spec +1:mock window.electron.layout.onFlushRequest 捕获回调 → render(onReady 设 apiRef)→ unmount(apiRef.current→null)→ 调 flush 回调 → 断言不 writeDockLayoutSnapshot(h.write 未调)。临时改回闭包捕获验证回归(用 stale api 写盘)。beforeEach 清 window.electron 防串扰。
- **沉淀**: 「只注册一次的 effect 把可变 ref 当时的值闭包进长生命周期回调」= stale-capture(与 R30 onReady 同源:同一 apiRef 的两个消费点,onReady 落地 + flush 回调都要 call-time 读 apiRef.current 而非 register-time 捕获)。凡「回调存活跨越 ref 可能变更」的场景,回调内读 ref 而非闭包捕获。DockShell 的 onReady(R30)/flush(R42)是同一 stale-api 族两处。R1-R23/R25-R33/R35-R42 共 40 修 + R24/R34 DEFER。

## R43 — spawnLeaf 取消/orphan 分支 remove 无 try/catch,reject 致未处理 rejection + 漏清孤儿 PTY (P2)

- **文件**: `src/panels/Terminal/spawnLeaf.ts` run() 的取消分支 + orphan-no-dispatch 分支
- **问题**: in-flight spawn 被取消(或 panel 已关 dispatch 清空)后,迟到的 `terminal.create` 成功结果须清掉 main 侧已建的 PTY。但取消分支 `const r = await coApi.terminal.remove(id)` **无 try/catch** → remove IPC reject 时 run()(由外层 `void run()` 调)产生**未处理 rejection**;orphan-no-dispatch 分支 `void coApi.terminal.remove(id)` 不 await、不检查 ok:false → 静默漏清。两种乱序下 main 侧新建的 PTY/session 变成**不可见孤儿**(占资源 / 被会话同步重新带回)。
- **修复**: 抽 `removeOrphanPty(id, reason)`(createSpawnQueue 闭包内,access removedPtyIds + coApi):`removedPtyIds.add(id)` + try `await remove`、`!r.ok` 记 warn、catch reject 记 warn —— **不抛**。取消分支 `await removeOrphanPty(id,'cancelled-spawn')`、orphan 分支 `await removeOrphanPty(id,'spawn-orphan-no-dispatch')`。清理失败可见且不产生未处理 rejection。
- **测试**: 新增 `src/__tests__/spawn-leaf-cancel-remove-safe/cancel-remove-safe.spec.ts`(3 例,经取消分支覆盖共享 helper):remove reject → 内部 catch 不冒泡 + 记入 removedPtyIds + warn('remove rejected') / remove ok:false → warn('remove ok=false') + 记账 / remove ok → 正常无 warn。orphan 分支共用同 helper。
- **沉淀**: fire-and-forget(`void run()`)里的 `await X()` 若不 try/catch,reject 会变未处理 rejection(外层 void 接不住);清理/回滚类的 remove/unwatch 必须**自带 catch + 检查 ok:false 不抛**,使「清理本身失败」可见而非静默漏资源(与 R32 send 失败回传、R29 commit-after-ack 同族:撤销/清理路径的失败也要被处理)。多个分支重复 remove → 抽单一 helper 统一三态处理(ok / ok:false / reject)。R1-R23/R25-R33/R35-R43 共 41 修 + R24/R34 DEFER。

## R44 — 终端 panel 延迟关闭:PTY 删除在排定时立即执行,复活面板留下死会话 (P1)

- **文件**: `src/shell/dock/wrap-panel-close.ts:60`(wrapPanelClose)
- **问题**: wrapPanelClose 把真实 `original()` close 延迟到 EXIT_DURATION_MS 后执行,并提供 `cancelPendingPanelClose()` 允许这段动画窗口内复活面板(DockShell editor 激活 effect 命中已关 panel 时调用)。但 terminal panel 的 `removeTerminalPtysForPanel(panel)`(cancelPanelSpawns + coApi.terminal.remove(sessionId))在 **close() 排定时同步立即执行**,早于可取消的真 close。用户在 EXIT 动画窗口内重新激活/复活 terminal panel 时,close 被 cancelPendingPanelClose 取消(清 timer + unmark),但 PTY/session **已被删除** → 留下一个还存在但终端已死 / 会话缺失的面板。
- **修复**: 把 `removeTerminalPtysForPanel(panel)` 从 close() 同步段移入延迟 `setTimeout` 回调内、紧挨 `original()` 前执行。这样 cancelPendingPanelClose 清掉 timer 时,terminal 删除根本不执行,面板与会话都保留;只有真正走到延迟 close(未被取消)才删 PTY。相对 original()/onDidRemovePanel 的顺序不变(仍在其前),不影响正常关闭的 remove 反馈(A128)。
- **测试**: wrap-panel-close-remove-feedback.spec +2(fake timers):close 后 cancelPendingPanelClose → advanceTimers 后 remove/cancelPanelSpawns/原 close 都不调用(复活保留会话)/ 不取消 → 排定时未删、timer 到点才 remove+cancelSpawn+原 close(对照)。既有 3 个 A128 用例改为 real-timer waitFor 等 EXIT_DURATION_MS(220ms)仍通过。
- **沉淀**: 「可取消的延迟操作」的**不可逆副作用必须放在延迟回调内**,不能在排定时提前执行 —— 否则取消只撤销了「最终动作」却留下已发生的副作用(此处:取消了 panel close 但 PTY 已删)。排定 = 承诺「将要做」,真正做(含所有副作用)应在不被取消时才发生。与 R29/R31/R43「commit/cleanup 时机」族相关:副作用与它所属的可取消动作必须同生命周期。R1-R23/R25-R33/R35-R44 共 42 修 + R24/R34 DEFER。

## R45 — 窗口关闭 flush 无 in-flight 守卫,重复 close 覆盖 pendingFlushAcks (P2)

- **文件**: `electron/main/index.ts:178` wireWindowCloseFlush
- **问题**: close 处理器在 `requestWindowFlush(win)` 完成前不会把 `flushed` 置 true(它在 await 之后才设)。requestWindowFlush 异步等 renderer ack / 10s 超时,这段窗口内的第二个 close 事件(快速重复关窗 / 系统关窗 / app.quit 触发的 close)再次满足 `!flushed && !flushedOnQuit` → 又 `event.preventDefault()` + 再 `requestWindowFlush(win)`,`pendingFlushAcks.set(win.id, done)` **覆盖**首个请求的 done。renderer 的 ack(`pendingFlushAcks.get(windowId)`)只 resolve 最新请求 → **首个 promise 只能等满 10s timeout** 才放行,且两个 async IIFE 各自 `win.close()` → 可能重复 close、关窗卡 10s。
- **修复**: 加 per-window `let flushing = false` 守卫。close 处理器在 `flushed/flushedOnQuit` 检查 + preventDefault 后,若 `flushing` 已为 true 则直接 return(只阻止本次关闭,不再发第二个 flush);首个 flush 发起前置 `flushing = true`。flush 完成后 `flushed=true`/`flushedOnQuit.add` 成为终态门,后续 close 早退放行。
- **测试**: close-flush.spec +1:连续两次 win.close() → `layout:flush-request` 只发一次(旧实现两次)、单 ack 即结算关窗。临时移除 flushing 守卫验证回归(发两次)。
- **沉淀**: 「异步操作完成才置『已完成』标志」之间的窗口期,重入会重复发起并覆盖共享 in-flight 记账(pendingFlushAcks 单槽 per-key)。须有**发起即置位的 in-flight 守卫**(flushing),不能只靠「完成后置位的 done 标志」防重入 —— 与 R35(saving 重入守卫)、R23(loading 门控)同族(异步操作的「进行中」状态必须在发起时立即标记,不是完成时)。R1-R23/R25-R33/R35-R45 共 43 修 + R24/R34 DEFER。

## R46 — notifyRoot 未等 hydrate,首帧 root=null 写进 main map 致 MCP 终端错 cwd (P1)

- **文件**: `src/shell/App.tsx:55`(notifyRoot effect)+ 新增 `src/shell/notify-root-when-hydrated.ts`
- **问题**: App 的 effect 在 `workspaceRoot` 一变就 `coApi.window.notifyRoot(root ?? null)`,但 initExplorerPersistence 是 fire-and-forget,**首帧 root=null**(hydrate 未完成)。这个 null 会立即写进 main 的 window→root map。hydrate 完成前若 MCP/agent 经 `terminal.create_session`(未显式传 cwd)建终端,main 从空 map 回退 → 创建成无 workspaceRoot 的全局终端 / 错误 cwd;hydrate 后才修正 map 已来不及。renderer 自身新建终端早已用 `waitForWorkspaceHydrated()` 规避,但 main MCP fallback 无同等门控。
- **修复**: 抽 `notifyRootWhenHydrated(deps)`:`await waitHydrated()` → 若未取消 → 读**最新** root(getState,非首帧捕获)→ notifyRoot。App effect 改用它(waitHydrated=waitForWorkspaceHydrated,getRoot=store.getState().root,isCancelled=effect cleanup 标志)。waitForWorkspaceHydrated 幂等(已 hydrated 立即 resolve),故 hydrate 后正常 root 变更无延迟;仅首帧 pre-hydrate null 被压住,等 hydrate 后推真值。关窗 root=null 是 hydrate 后的正常空态,照常推 null。
- **测试**: 新增 `src/__tests__/notify-root-when-hydrated/notify-root-when-hydrated.spec.ts`(4 例):hydrate 前不推、hydrate 后推最新 root(非首帧 null)/ hydrate 后 root=null 推 null / cancel 后不推 / 已 hydrated 无延迟推。
- **沉淀**: 「初始默认态(null)在真实数据 hydrate 前被同步给依赖方」= R38 的对偶(R38 是 hydrate 覆盖用户输入,R46 是初始默认态抢先污染下游 map)。renderer 已用 waitForWorkspaceHydrated 门控自己消费 root 的路径,但**推给 main 的同步链路漏挂同一门控** —— 凡「向外部依赖方推送本地状态」的链路,若本地状态有「hydrate 前是占位默认值」的契约,推送也必须等 hydrate(与终端 cwd 消费方同一门控)。「防御建了但没覆盖所有兄弟入口」族:waitForWorkspaceHydrated 用在了消费端却漏了 notify 推送端。R1-R23/R25-R33/R35-R46 共 44 修 + R24/R34 DEFER。

## R47 — useTerminal lastSentSizeRef 跨 session 复用,新 PTY 漏初始 resize 停默认 80×24 (P1)

- **文件**: `src/panels/Terminal/useTerminal.ts:201`(lastSentSizeRef)+ [termId] init effect
- **问题**: `lastSentSizeRef`(性能 P9 的 resize-IPC 去重 ref)是 **hook 级 useRef**,跨 termId 持久。useTerminal(termId) 的 [termId] init effect 在切 session 时重建 xterm,但 lastSentSizeRef 不重置(hook 实例不 remount —— TerminalPanelContent 未按 sessionId 加 key,React 复用 hook 实例)。新 xterm 首次 `fitAndResize` 算出的 cols/rows 若与**上一 session 残留值相同**(容器尺寸不变 → 网格相同),被 P9 去重(`!prev || cols/rows 变` 才发)跳过 → 新 PTY 一直保持 main spawn 时的默认 80×24,直到窗口尺寸再变才收到 resize → 终端换行 / 全屏 TUI 尺寸错乱。
- **修复**: [termId] init effect 起始(紧随 `setIsReady(false)` 的「切 session」点)`lastSentSizeRef.current = null`。新 session 的首次 fitAndResize 因 `!prev` 必发一次初始 resize;同 session 内的后续 fit 仍按 P9 去重。
- **测试**: perf-audit/terminal-resize-gating.spec +1(fitAndResize 层复现):session A 发 80×24 → 切 session B 同网格不重置=漏发(bug)→ 重置 null 后补发(fix 语义)。hook 渲染极重(xterm/container/theme/settings),故在 fitAndResize 层记录 cross-session 重置语义。
- **沉淀**: 「性能去重 ref(记上次值,相同则跳过)」绑定的生命周期必须与它去重的**目标实体**一致 —— lastSentSizeRef 去重的是「本 PTY 的尺寸」,但它挂在 hook 级而 hook 跨 session 复用 → 去重跨了实体边界,把 A 的尺寸当 B 的「已发」。修法:实体(session)切换时重置去重 ref(或按实体 key 分桶)。与 R26(api 重建重置 diff 基线)、R37(per-path 代际)同族:**增量/去重的基线必须随被比较实体的更替而重置**。codex 早轮曾因「不确定 hook 是否复用」搁置,亲读 TerminalPanelContent 确认未加 key 后定性为真 bug(亲读分流犹豫项)。R1-R23/R25-R33/R35-R47 共 45 修 + R24/R34 DEFER。

## R48 — Quick Open 异步列表变短后 selectedIndex 越界,Enter 失效 (P2)

- **文件**: `src/plugins/quick-open/store.ts:67`(setResults)+ `src/plugins/quick-open/QuickOpenModal.tsx`(filtered)
- **问题**: 用户打开 Quick Open(复用上次缓存 results)并移动 selectedIndex 到较大下标后,后台 walk scan 完成 `setResults(newFiles)` 替换列表(或 query 收窄)使 `filtered` 变短,但 selectedIndex 不被钳制。Enter 路径 `filtered[selectedIndex]` 得 undefined → 已有 `if (file)` 守卫使其静默无操作(键盘打开失效);高亮/`scrollToIndex(selectedIndex)` 也停在越界项,直到用户再按方向键(moveSelection 的 modulo)才恢复。既有 a11y(A111)只守了 aria-activedescendant 属性(装饰),未修 Enter/滚动。
- **修复**: store 加 `clampSelection(len)`(`Math.min(selectedIndex, len-1)`,空列表置 0;已在范围内返 `{}` 不触发 selectedIndex 订阅者重渲染)。QuickOpenModal 加 effect 在 `filtered.length` 变化时 `clampSelection(filtered.length)`(声明在 scroll effect 之前 → 同次提交先钳后滚)。selectedIndex 索引的是 filtered(fuzzy 过滤后),故按 filtered.length 钳而非 results.length。
- **测试**: quick-open/store.spec +4(clampSelection:越界钳末项 / 空列表置 0 / 范围内不变 / 边界 len-1 不变);quick-open-modal.spec 的 A111 越界用例更新为反映 R48 自愈(钳回 option-0,aria-activedescendant 指向有效 option 而非移除 —— A111「不指向不存在 option」意图仍满足且 Enter 现在能打开有效项)。
- **沉淀**: 「selectedIndex/游标 索引一个会异步变长度的列表」必须在列表长度变化时钳回有效范围 —— 否则越界游标让「读 list[index]」得 undefined(Enter 失效 / 高亮悬空)。钳制要按**实际被索引的集合**(filtered,过滤后)而非原始集合(results)。与 a11y A111(装饰层守越界)互补:A111 防 UI 属性悬空,R48 修行为(Enter/滚动)。属「异步结果改变集合大小,依赖该大小的索引未同步」族。R1-R23/R25-R33/R35-R48 共 46 修 + R24/R34 DEFER。

## R49 — 命令面板动态变短后 selectedIndex 越界,Enter 失效 (P2) — R48 孪生

- **文件**: `src/plugins/command-palette/store.ts` + `src/plugins/command-palette/CommandPalette.tsx:128`
- **问题**: R48 的孪生(command-palette 与 quick-open 同模式)。`filtered` 随 commands registry 变化、**插件 reload/disable**、locale/hotkey/recent 重算而动态变短,但 selectedIndex 只在 open/setQuery/moveSelection 时更新。变短后只有 a11y(A111)移除了悬空 aria-activedescendant,没把实际选择钳回有效项 → 键盘用户 Enter 读 `filtered[selectedIndex]===undefined`,命令无法执行,直到再按方向键才恢复。
- **修复**: 与 R48 同款:store 加 `clampSelection(len)`(同实现),CommandPalette 加 effect 在 `filtered.length` 变化时 `clampSelection(filtered.length)`(scroll effect 之前)。
- **测试**: command-palette/store.spec +3(clampSelection:越界钳末项 / 空列表置 0 / 范围内不变)。
- **沉淀**: 「修一个 bug 必 grep 所有孪生入口」—— quick-open(R48)与 command-palette 是同一「fuzzy 过滤列表 + selectedIndex + 异步/动态变短集合」模式的两份实现,R48 修 quick-open 后 codex 立即指出 command-palette 同病。command-palette 的集合变短源更多(插件 reload/disable 运行时改 registry)。防御未传播族:同模式双实现,修一份必同步另一份。R1-R23/R25-R33/R35-R49 共 47 修 + R24/R34 DEFER。

## R50 — 快捷键编辑弹窗持有 stale command,命令被移除后写 override 到不存在命令 (P2)

- **文件**: `src/plugins/settings/KeybindingsTabContent.tsx:164`(editing 状态 + onSave/onReset)
- **问题**: 编辑弹窗的 `editing` state 是打开时捕获的**完整 CommandSpec**;onSave=`setHotkey(editing.id, combo)`、onReset=`reset(editing.id)` 用捕获的 id。若弹窗打开期间插件 reload/disable 把该命令移出 registry(allCommands 更新但 editing 仍持旧对象),保存仍写 override 到已不存在的命令 → 同 id 命令日后重注册时意外继承旧快捷键/解绑(stale write)。
- **修复**: (1) 加 effect:`editing` 命令从 `allCommands` 消失即 `setEditing(null)` 自动关闭弹窗。(2) onSave/onReset 加同帧守卫:写之前从当前 allCommands 复检命令仍存在(覆盖 effect 关闭弹窗前的同帧点击),已移除则关弹窗不写。
- **测试**: keybindings-tab-content.spec +1:打开编辑弹窗 → `disp.dispose()`(模拟插件 disable 移除命令)→ 弹窗自动关闭 + overrides 不写该命令。
- **沉淀**: 「弹窗/编辑器打开时捕获整个目标对象,提交时用捕获值」在「目标可被运行时移除(插件 reload/disable 改 registry)」的系统里 = stale write。修法:捕获 **id**(而非整对象)+ 提交前从当前真源复检存在性 + 目标消失时关闭编辑 UI。与 R34(editor save 持旧 path)、R47/R48/R49(动态集合)同族:凡持有「可被异步/运行时改变的实体引用」跨越用户操作,提交前都要对当前真源复核。codex 在排查 DockReconciler previousCustomTitlesRef 模块级单例(疑点但未定性)后转报此项。R1-R23/R25-R33/R35-R50 共 48 修 + R24/R34 DEFER。

## R51 — hotkey 绑定表 / 命令面板缓存 CommandSpec,命令移除后仍执行已卸载插件代码 (P2) — R50 同族

- **文件**: `src/plugins/command-palette/useCommandHotkeys.ts:121`(全局 hotkey)+ `CommandPalette.tsx:172`(面板 execute)+ `CommandRegistry.ts`(新增 get)
- **问题**: useCommandHotkeys 的预编译绑定表 `CompiledBinding.cmd` 缓存 CommandSpec 对象,keydown 命中直接 `b.cmd.fn()`;CommandPalette execute 同样 `d.cmd.fn()`(filtered 快照里的 spec)。命令被插件 disable/reload **同步 unregister** 后,到 React 订阅重渲替换 keydown handler / 列表快照前的窗口内,旧闭包仍持已卸载命令的 fn → hotkey 或面板 Enter/click 仍执行**已卸载/重载中**的插件代码,绕过当前 registry 状态。
- **修复**: CommandRegistry 加公共 `get(id): CommandSpec | undefined`。两处 execute 改为触发时按 id 从 live registry 重查:`const live = commands.get(b.cmd.id); if (!live) return; return live.fn();`。死命令静默忽略,不再调缓存 fn。useCommandHotkeys effect deps 补 `commands`(稳定 registry 实例)。
- **测试**: 新增 `src/__tests__/command-hotkey-live-lookup/live-lookup.spec.tsx`(3 例):CommandRegistry.get register→spec / dispose→undefined;hotkey 命令仍在 → live 查找执行 fn;hotkey 触发时 `vi.spyOn(reg,'get').mockReturnValue(undefined)`(模拟绑定表 stale 但命令已移除)→ 不执行 stale fn。
- **沉淀**: R50 同族升级版 —— 不仅「编辑 UI 提交」要按 id 复检,「执行/调用缓存的回调」也要。凡缓存了「可运行时移除的实体的可执行引用(fn)」,执行点都要从真源(registry)按 id 重新解析,而非调缓存的引用 —— 否则 unregister 与 UI 重建之间的窗口会执行死代码。「按 id 重查 + 不存在则忽略」是缓存可变实体引用的通用安全执行模式。R1-R23/R25-R33/R35-R51 共 49 修 + R24/R34 DEFER。

## R52 — Ribbon 按钮 onClick 捕获 spec,命令移除后仍执行已卸载插件 action (P2) — R51 同族

- **文件**: `src/shell/IconSidebar.tsx:118`(NavRailButton onClick)+ `RibbonRegistry.ts`(新增 get)
- **问题**: IconSidebar 渲染 ribbon 按钮时 `onClick={() => runContributedAction(r.title, r.onClick)}` 捕获了 RibbonActionSpec 的 `onClick`。插件 disable/reload 同步 unregister ribbon action 后,到 React 订阅重渲移除按钮前的窗口内,旧 DOM handler 仍可被点击触发 → 执行已卸载/重载中插件的 action,绕过当前 registry。R51 同族(activity bar 维度)。
- **修复**: RibbonRegistry 加 `get(id)`。IconSidebar onClick 改为 click 时按 id 从 live `coApp.ribbon.get(r.id)` 重查再执行,死 action 静默忽略。
- **测试**: ribbon-registry.spec +2(get(id):register→spec / dispose→undefined;重复 id 后注册赢 get 返 live)。
- **沉淀**: 「缓存可变实体引用 + 执行点直接调缓存引用」family 第三处(R50 keybinding 编辑提交 / R51 command hotkey+palette / R52 ribbon)。codex 系统性扫所有插件贡献点(ribbon/status bar/editor actions/context menu)。统一解:每个 registry 提供 `get(id)`,所有「执行用户贡献的回调」的点在触发时从 live registry 按 id 重查,不调渲染时捕获的 spec.fn —— 把「按 id 重查执行」固化为插件贡献回调的调用约定。R1-R23/R25-R33/R35-R52 共 50 修 + R24/R34 DEFER。

## R53 — Editor action 按钮捕获 spec,命令移除后仍执行已卸载插件 action (P2) — R51/R52 同族

- **文件**: `src/panels/Editor/EditorHeader.tsx:92`(action 按钮 onClick)+ `EditorActionRegistry.ts`(新增 get)
- **问题**: EditorActionsArea 渲染 action 按钮时 `onClick={() => runContributedAction(a.label, a.fn)}` 捕获 EditorActionSpec.fn。插件 disable/reload 同步 unregister 后,到 registry 订阅重渲移除按钮前,旧按钮 handler 仍能执行已卸载 action(若 action 依赖已释放插件资源 → 异常 / stale side effect)。R51/R52 同族第 4 处。
- **修复**: EditorActionRegistry 加 `get(id)`。EditorHeader 抽 `runAction(a)`:click 时 `coApp.editorActions.get(a.id)` 重查 + 按当前 `{filePath,dirty,mode}` 经 `filterVisible([live], ctx)` **重检 when**(editor action 的可见性依赖当前 tab 状态,比 R51/R52 多一层 when 复检)+ 执行;死 action / 当前 ctx 下不可见者静默忽略。两处按钮(IconButton/Button)共用 runAction。
- **测试**: editor-action.spec +3(get(id):register→spec / dispose→undefined;重复 id get 返 live;dispose 后经 get→filterVisible 复检不执行 stale fn)。
- **沉淀**: 「缓存可变实体引用 + 执行点直调缓存引用」族第 4 处。editor action 比 ribbon/command 多了 **when 谓词**(可见性依赖运行时 ctx),故重查后还要按当前 ctx 重检 when 再执行 —— 不仅「实体还在吗」,还要「当前条件下它仍该可执行吗」。统一约定再次印证:所有插件贡献的可执行回调,触发时从 live registry 按 id 重解析 + 按当前上下文重检 gating + 执行。R1-R23/R25-R33/R35-R53 共 51 修 + R24/R34 DEFER。

## R54 — Explorer 右键菜单项捕获 spec,菜单打开期间命令移除后仍执行 (P2) — R51/R52/R53 同族

- **文件**: `src/panels/Explorer/ContextMenu.tsx:304`(onSelect)+ `ExplorerContextMenuRegistry.ts`(新增 get)
- **问题**: ContextMenu 打开时把 ExplorerContextMenuItemSpec 缓存进 pluginGroups(open 时 groupPluginItems 一次),`onSelect={() => runContributedAction(item.label, () => item.fn(pluginCtx))}` 捕获 item.fn。菜单打开期间插件 disable/reload 同步 unregister 该 item,旧菜单仍可执行已卸载 action(作用于当前文件/选区,绕过 live registry);when 也不按最新状态复检。R51/R52/R53 同族第 5 处。
- **修复**: ExplorerContextMenuRegistry 加 `get(id)`。onSelect 改为 select 时 `coApp.explorerContextMenu.get(item.id)` 重查 + 用当前 `pluginCtx` 经 `filterVisible([live], pluginCtx)` 重检 when + 执行;死项 / 当前 ctx 下不可见项静默忽略。
- **测试**: explorer-context-menu.spec +3(get(id):register→spec / dispose→undefined;dispose 后经 get→filterVisible 不执行 stale fn;live 项 when=false 经复检不执行)。
- **沉淀**: 「缓存可变实体引用 + 执行点直调缓存引用」族完整收口(5 处:R50 keybinding 编辑 / R51 command hotkey+palette / R52 ribbon / R53 editor action / R54 explorer context menu)。所有「带 when 谓词的贡献点」(editor action R53 / context menu R54)重查后都要复检 when。codex 用 5 轮系统性扫遍所有插件贡献点入口(commands/ribbon/editorActions/explorerContextMenu),每个 registry 现都有 `get(id)` + 调用点 live-lookup。这是「修一个 bug 必 grep 所有同模式入口」的极致体现 —— 同一缺陷模式(渲染时捕获 spec,运行时实体可被移除)横跨 5 个独立 UI 入口。R1-R23/R25-R33/R35-R54 共 52 修 + R24/R34 DEFER。

## R55 — Settings 面板 active.render() 调已 unregister tab 的 render(快照滞后) (P2) — R50-R54 同族(render 维度)

- **文件**: `src/plugins/settings/SettingsPanel.tsx:89`(active 计算)+ `SettingTabRegistry.ts`(新增 get)
- **问题**: `active = tabs.find(id) ?? tabs[0]`,`tabs = useRegistry(coApp.settingTabs)`。useRegistry 是 **useState + useEffect 订阅**(非 useSyncExternalStore),快照 `tabs` **滞后 registry 一帧**:tab 被插件 disable/reload 同步 unregister 后,registry.items 立即更新但 `tabs` 要等 setSnap 重渲才更新。这一帧内 `active` 仍是已卸载的 tab → `active.render()`(line 157)执行已卸载插件的设置页代码(访问已释放资源 / 渲染陈旧 UI)。R50-R54 是「click 执行缓存 spec」,R55 是「render 执行滞后快照里的 spec」。
- **修复**: SettingTabRegistry 加 `get(id)`。active 改为从 **live** registry 计算:`(activeTabId ? registry.get(activeTabId) : undefined) ?? registry.getAll()[0] ?? null`(live Map 比滞后快照新)。nav 列表仍用 `tabs` 快照(订阅驱动重渲);只有 `active.render()` 的 spec 用 live 查找,保证只调当前仍注册的 tab 的 render。
- **测试**: setting-tab-registry.spec +2(get(id):register→spec / dispose→undefined;dispose 后经 live 查找回退,render 不被调)。
- **沉淀**: 同族第 6 处,也是「useState 式快照滞后 registry 一帧」的根因点题 —— R50-R54 的 click handler 重查 live registry 之所以必要,正因为 useRegistry 快照滞后;R55 把这一点暴露在 render 路径。统一约定补强:凡「执行从 registry 快照取来的插件函数」(click 或 render),都要在执行前从 live registry 按 id 重解析。decorator/StatusBarItem.render 等剩余 render 型贡献点同理(codex 续查)。R1-R23/R25-R33/R35-R55 共 53 修 + R24/R34 DEFER。

## R56 — StatusBar item.render() 调已 unregister item(快照滞后) (P2) — R55 同族(render 维度)

- **文件**: `src/shell/StatusBar.tsx:190`(left/right items render)+ `StatusBarRegistry.ts`(新增 get)
- **问题**: StatusBar `{leftItems.map((item) => <span>{item.render()}</span>)}`(right 同)直接调订阅快照里缓存的 `item.render`。`statusItems = useRegistry(coApp.statusBar)` 快照滞后 registry 一帧(R55 同根);item 被插件 disable/reload unregister 后、到 useRegistry state 更新移除前,任意状态栏重渲(状态栏因 workspace/agent count/copy 状态等频繁重渲)仍执行已卸载插件的 render;render 同步抛错还连累整条状态栏渲染。
- **修复**: StatusBarRegistry 加 `get(id)`。抽 `liveRenderStatusItem(item)`:按 id 从 live `coApp.statusBar.get` 复查 → 找不到返 null;找到则 try/catch 调 render()(隔离单项同步抛错,不连累整条)。left/right 两处改用它。
- **测试**: plugin-contributions-core/registries.spec +2(StatusBarRegistry.get:register→spec / dispose→undefined;dispose 后经 live 查找跳过 render 不被调)。
- **沉淀**: 同族第 7 处(R50-R56)。render 型贡献点(R55 setting tab / R56 status bar)比 click 型更危险:**状态栏/设置页每次重渲都执行插件 render**,unregister 后的滞后窗口里任意无关重渲都会触发死代码,远比「用户恰好点击」频繁。render 型还应 try/catch 隔离单项抛错。「执行任何从 registry 快照取来的插件函数前,先从 live registry 按 id 复查」已是全仓约定(commands/ribbon/editorAction/contextMenu/settingTab/statusBar 6 个 registry 全部具备 get(id) + 调用点 live-lookup)。R1-R23/R25-R33/R35-R56 共 54 修 + R24/R34 DEFER。

## R57 — Explorer decorator 合并执行快照里已 unregister 的裸函数 (P2) — R55/R56 同族(render 维度)

- **文件**: `src/panels/Explorer/FileRow.tsx` useDecoration(mergeDecorations)+ ExplorerDecoratorRegistry(getAll 已 live)
- **问题**: ExplorerDecoratorRegistry 存**裸函数数组**(无 id)。FolderTree 一次 `useRegistry(coApp.explorerDecorators)`(R7:订阅集中)拿快照下传给每个 FileRow,FileRow useDecoration `mergeDecorations(entry, decorators)` 执行这些函数。useRegistry 快照(useState 订阅)滞后 registry 一帧;插件 unregister 后快照仍含该函数,FileRow 在滞后窗口内因 path/isDirectory 变化触发 memo 重算时会执行已移除 decorator(虚拟文件树渲染热路径,访问已释放资源 / 加陈旧 badge/icon)。decorator 无 id,无法 get(id),但 registry.getAll()(`this.fns.slice()`)本身即时反映。
- **修复**: FileRow useDecoration 的 memo 仍以 `decorators` 快照作**失效键**(保持 R7 单订阅 + 原重算频率/性能),但实际合并读 **live** `coApp.explorerDecorators.getAll()`(`void decorators` 标明失效键意图)。滞后窗口内 memo 不重算 → 不重复执行;重算时读 live 列表 → 已移除函数不再被调。
- **测试**: explorer-decorator.spec +2(dispose 后 live getAll() 不含该 fn → mergeDecorations 不执行 / 未 dispose 执行,对照);更新 filerow-decorators-prop.spec 在真源 coApp.explorerDecorators 注册 decorator(FileRow 现读 live)+ afterEach dispose 防跨测试泄漏。
- **沉淀**: 同族第 8 处,**裸函数(无 id)变体**:不能 get(id) 时,执行点改读 registry 的 live getAll()(即时数组)而非 useState 快照。「失效键 + live 执行」模式:用滞后快照的引用作 memo 依赖(驱动重算频率),用 live registry 作执行数据(保正确)—— 兼顾性能与正确。decorator/render 这类高频渲染贡献点尤其受益(快照滞后窗口里任意重渲都可能执行死代码)。R1-R23/R25-R33/R35-R57 共 55 修 + R24/R34 DEFER。

## R58 — 设置项控件写 override 到已 unregister 的 setting id (P2) — R50 同族(write 维度)

- **文件**: `src/plugins/settings/SettingItemRow.tsx`(onChange/reset 写)+ CategoryTabContent/SettingsPanel(注入 live 检查)+ SettingItemRegistry(新增 get)
- **问题**: SettingItemRow 拿到 SettingItemSpec 快照后,boolean/select/number/text 控件 onChange + reset 直接 `setValue(spec.id, ...)` / `reset(spec.id)`。若该 setting item 在用户操作前被插件 disable/reload unregister(快照滞后仍渲染旧控件),旧控件仍把 override 写到已不存在的 setting id → localStorage 残留;之后同 id setting 重注册会意外继承旧值。R50(keybinding 编辑写)同族,write 维度。
- **修复**: SettingItemRegistry 加 `get(id)`。SettingItemRow 加可选 `isStillRegistered?: (id) => boolean`(默认 `() => true`,单测不破);所有写入经 setValue/reset 包装,`if (isStillRegistered(id))` 才写。渲染行的父组件 CategoryTabContent / SettingsSearchResults 注入 `(id) => registry.get(id) !== undefined`(live 复查)。已移除 setting 的旧控件写入被跳过。
- **测试**: setting-item-row.spec +2(isStillRegistered=false → 点 toggle 不写 / =true 正常写);setting-item-registry.spec +1(get:register→spec / dispose→undefined)。注入式默认恒真,既有断言写入的用例不受影响。
- **沉淀**: 同族第 9 处,write 维度(R50 keybinding 之后第二个「写到已移除实体」)。注入式 `isStillRegistered`(默认恒真,父注入 live 检查)比 R57 的「组件直读 coApp」更解耦 —— 保持 SettingItemRow 纯组件(测试无需注册到真源),把 live-ness 责任放在「知道真源的父组件」。当组件被测试以隔离 spec 渲染时,注入式 prop 是比直读全局单例更友好的模式。R1-R23/R25-R33/R35-R58 共 56 修 + R24/R34 DEFER。

## R59 — DockShell panel component 闭包捕获快照里已 unregister 的 factory (P2) — R55-R58 同族(panel factory 维度)

- **文件**: `src/shell/dock/DockShell.tsx:77` usePanelComponents + PanelRegistry(新增 get)
- **问题**: usePanelComponents 从 `useRegistry(coApp.panels)` 快照构建 dockview components map,wrapper 闭包捕获 `const Factory = spec.factory`。panel type 被插件 disable/reload unregister 后、到 useRegistry 快照重渲移除 component 前,dockview 仍会渲染该 component → 调闭包捕获的旧 factory 实例化已移除插件代码(访问已释放资源);同 type 重注册时也可能短暂渲染旧 factory。R55-R58 同族第 10 处(panel factory 维度)。
- **修复**: PanelRegistry 加 `get(type)`。usePanelComponents 的 wrapper 只捕获 `type`,渲染时 `const live = coApp.panels.get(type)`,`live ? live.factory(p) : null`(live 查找;已移除渲染空,由 reconciler/关闭流程移除 panel)。
- **测试**: plugin-contributions-core/registries.spec +2(PanelRegistry.get:register→spec / dispose→undefined;dispose 后经 live 查找跳过 factory 不被调)。
- **沉淀**: 同族第 10 处也是「贡献点缓存 spec」族的最后主要入口收口。全部 7 个 registry(commands/ribbon/editorAction/explorerContextMenu/settingTab/statusBar/panel)+ settingItem + decorator 现都按 id/type live 查找执行;**「执行任何插件贡献的回调/factory/render 前,从 live registry 重解析」已是全仓不变量**。dockview component map 是 React-外的渲染入口(dockview 持有 component ref),更需 live 查找——它不随 React 快照而是随 dockview 内部状态渲染,闭包捕获的 stale factory 存活更久。R1-R23/R25-R33/R35-R59 共 57 修 + R24/R34 DEFER。

## R60 — Dock「添加 panel」菜单创建已 unregister 的 panel type (P2) — R59 同族(添加入口)

- **文件**: `src/shell/dock/HeaderActions.tsx:178`(添加 panel 菜单项 onClick)
- **问题**: 「更多操作」菜单的 panel 选项 `onClick={() => addPanel(c.type, label, c.titleKey)}` 捕获打开菜单时的 PanelSpec 快照。菜单打开期间该 panel type 被插件 disable/reload unregister 后,点击仍 `addPanel(c.type)` 创建一个 component 已不存在的 panel(R59 修复后渲染空,即空白/不可渲染 panel);若同 type 随后重注册,旧 panel 可能以旧 title/params 复活。R59(panel factory render)同族(添加入口维度)。
- **修复**: onClick 改为点击时 `const live = coApp.panels.get(c.type)`,`!live` → `setOpen(false)` 关菜单不创建;存在则用 **live** title/titleKey 调 addPanel。
- **测试**: header-actions.spec +1(菜单打开期 `vi.spyOn(coApp.panels,'get').mockReturnValue(undefined)` 模拟 unregister → 点击不 addPanel + 关菜单);修复 window-workspace-roots-map T21 的 coApp.panels mock 补 `get`(R60 新增方法,mock 缺则调用抛错)。
- **沉淀**: 同族第 11 处,也提醒「给 registry 加新方法(get)后,所有 mock 该 registry 的测试都要同步补该方法」—— mock 与真 registry 的接口漂移会让无关测试在调用新方法时抛错(T21 因此连带失败)。「执行/创建插件贡献的东西前,从 live registry 按 id/type 复查」不变量现覆盖:执行回调(R51/R52/R53/R54)、render(R55/R56/R57/R59)、写值(R58)、创建 panel(R60)—— 所有「用快照里的 spec 做事」的入口。R1-R23/R25-R33/R35-R60 共 58 修 + R24/R34 DEFER。

## R61 — IpcPluginDataStore 同 plugin 写写无串行,乱序 save 致 lost update (P1)

(注:codex 第 61 轮先重报了 R60 的 HeaderActions 添加 panel —— 已修,经我贴当前代码纠正后 codex 复读确认并跳过;此 R61 为其后找到的真新项。)

- **文件**: `src/plugins/PluginDataStore.ts:45` IpcPluginDataStore.write()
- **问题**: write() = `await save → writeGen++ → cache.set`。同一 pluginId 并发两次 write(A 先发、B 后发)时:主进程文件 lock 只保证 JSON 不损坏、**不保证调用顺序**;renderer cache 提交按各自 save 的 **resolve 顺序**。若 B 的 save 先 resolve、A 的后 resolve,cache 最终回到 A(旧值)= lost update,磁盘/cache 都回旧值,插件重启读到过期数据。
- **修复**: 加 per-plugin `writeChains` Map,write 用 `runSerialPerKey(this.writeChains, pluginId, task)`(R21 的串行助手)把整段 save→writeGen++→cache commit 串行化,保证「后发起者最后落地」。JSON.stringify 校验留在链外(非可序列化值早抛,不占链)。tsconfig.node.json include 补 `src/lib/serialize-per-key.ts`(PluginDataStore 在 node 项目 file list 内,新依赖须显式列出)。
- **测试**: plugin-data-store-persist-integrity.spec +2:并发 write(A 先发/save 后 resolve、B 后发/save 先 resolve)→ 最终 read=B + save 按调用顺序发;写链中一次 save reject 不卡死后续 write(链续跑)。临时移除串行验证回归(乱序覆盖 → read=A)。**测试时序坑**:`store.write` 的 task 在微任务里才跑到 `save`(此刻才捕获 resolveX),须先 `await Promise.resolve()` 让 task 跑到 save 再 resolve,否则 resolveX 仍是初始 no-op → task 永挂 → 超时(且 hang 的 pending promise 会级联污染同文件其它测试)。
- **沉淀**: 「await 写盘 → 提交本地状态」的并发写,若提交按 resolve 顺序而非调用顺序,后发写会被先发但迟到者覆盖(lost update)。同一资源的多个异步写必须 per-key 串行(runSerialPerKey)—— 与 R21(editor save)、R15(IpcPermissionStore)同族,本例是 plugin KV 维度。主进程文件锁只防损坏不防乱序,**顺序保证必须在发起端(renderer)做**。R1-R23/R25-R33/R35-R61 共 59 修 + R24/R34 DEFER。

## R62 — requestAgentAuth: pending.set 后 send 抛错致泄漏 + 假死 (P2)

- **文件**: `electron/main/services/agent-auth.service.ts:84` requestAgentAuth()
- **问题**: 流程是 `setTimeout(timer) → pending.set(requestId,…) → win.webContents.send(REQUEST, payload)`。win 在函数开头通过了 `isDestroyed()` 检查,但在 send 这一刻其 webContents 可能已销毁(窗口正在关闭的竞态窗口)→ `send` 同步抛 "Object has been destroyed"。未捕获则:(1) Promise executor 抛错使 Promise **reject**(契约要求失败返 'denied' 而非抛,调用方 tool 拿到异常);(2) 已登记的 pending 条目 + timer **泄漏到 5min 超时**才清,期间发起授权请求、仍存活的外部 agent CLI 进程干等假死。
- **修复**: send 包 try/catch,投递失败时 `clearTimeout(timer) + pending.delete(requestId) + resolve('denied')`,立即结算不等超时。`pending.has(requestId)` 守卫防与 timer/cancelByWindow 重复结算。
- **测试**: agent-auth-service.spec +1(T2c):`webContents.send` mock 抛错 → requestAgentAuth **不抛**且 resolve 'denied';再发一个正常请求独立结算成功,间接验证 pending map 已清无残留。中和(移除 try/catch)确认回归。
- **沉淀**: 「先登记 pending/计数 → 再投递(send/IPC)」的反向调度,投递这一步可同步抛(目标已销毁),必须 try/catch 并在 catch 里回滚登记 + 结算,否则 reject 破坏「失败返默认值」契约 + pending 泄漏到超时。**send-fail-abort 同族**:plugin-mcp 已修过同型(codex 明确指认这是未传播的兄弟入口)—— 凡「pending.set 在前、send 在后」的反向 IPC 调度器都须查 send 抛错回滚。与 R31(terminal create cancelled)、stop-hook broker.cancelByWindow 同思路(等待者是活的外部进程,不能干等超时)。R1-R23/R25-R33/R35-R62 共 60 修 + R24/R34 DEFER。

## R63 — protocol-dispatch drain: shift 在 send 前 + 广播循环抛错中断 (P2)

- **文件**: `electron/main/protocol-dispatch.ts:30` drainPendingProtocolUrls() + :78 routeProtocolUrl 广播循环
- **问题**:
  - **drain**: `const url = pending.shift()!; wc.send(...)`。wc 在调用方 isDestroyed()/isLoading() 检查后、实际 send 前销毁(窗口关闭竞态)→ send 抛 "Object has been destroyed",但 URL 已出队且不会重投 → **co:// 深链永久丢失**;且抛错中断 while 循环使后续 pending 也停发。该 drain 还在 `attachWindowDrain` 的 did-finish-load 回调里被调,抛错会变 Electron 未捕获异常。
  - **广播(同族)**: `for (const w of ready) w.webContents.send(...)`。某就绪窗口在 ready 过滤后、send 前销毁 → send 抛 → 中断循环,其余就绪窗口漏投本次 url。
- **修复**:
  - drain 改 **peek 队首 → send 成功才 shift**;send 抛错时保留队首 URL 在 pending(留给下一个就绪/新建窗口 drain)+ return 停止本次 drain(不抛给调用方)。
  - 广播改 **逐窗口 try/catch**(一个已死窗口不拖累其它)+ 全部失败回退 `pending.push(url)`(极端竞态下不丢深链,留给后续 attachWindowDrain 窗口消费)。
- **测试**: protocol-dispatch.test +3:drain send 抛错 → 队列不丢 + 不抛 + 换就绪窗口完整消费;广播一窗口抛错 → 其余仍收到 + 不回退入队;广播全失败 → 回退入队。中和(drain 还原 shift-before-send)确认回归。
- **沉淀**: send-fail-abort 族第三处(R62 agent-auth / plugin-mcp 已修 / 本处 protocol)。**「从队列取出 → 投递」必须投递成功才出队(peek-then-commit),否则投递失败=数据永久丢失**;**「遍历多目标广播」每个目标独立 try/catch,否则一个已死目标中断整轮**;失败全军覆没时回退入队保不丢。凡 webContents.send / IPC 投递点都在「检查存活」与「实际投递」间存在销毁竞态窗口,投递须按可抛处理。R1-R23/R25-R33/R35-R63 共 61 修 + R24/R34 DEFER。

## R64 — i18n broadcastChanged 广播 send 抛错致 locale 分裂 + 后续窗口漏广播 (P1)

- **文件**: `electron/main/ipc/i18n.ipc.ts:23` broadcastChanged()
- **问题**: SET_LOCALE handler 先 `setCurrentLocale(locale)`(写盘)+ `commitSetLocaleGen(gen)` 提交,再调 broadcastChanged 遍历窗口 `w.webContents.send(CHANGED)`。窗口在 `isDestroyed()` 检查后、实际 send 前销毁(窗口关闭竞态)→ send 抛 "Object has been destroyed",异常冒泡出 broadcastChanged → 出 SET_LOCALE async handler → safeHandle 捕获返回 **ok:false** 给发起 renderer。但此刻 locale 已落 disk/main:(1) 发起 renderer 收 ok:false 不更新本地语言,而 disk/main 已是新值 → **locale 分裂**;(2) 循环中断 → 抛错窗口之后的窗口收不到 CHANGED 广播,停在旧语言。
- **修复**: broadcastChanged 每个窗口的 send 独立 try/catch,失败只 `console.error` 跳过,不影响其它窗口广播与 handler 返回。镜像同文件 menuRebuilder 已有的 try/catch(失败不阻断 locale 同步)。
- **测试**: popout-locale-broadcast.spec +1(R64):第一个窗口 send 抛错 → 其后健康窗口仍收到广播 + handler 仍返回 `{ok:true,locale,gen}`。中和(还原直接 send)确认回归。
- **沉淀**: send-fail-abort 广播族第四处(R62 agent-auth / R63 protocol drain+broadcast / 本处 i18n)。**「已提交持久状态 → 再广播 IPC 通知」时,广播失败绝不能反向使提交操作返回失败**——否则发起方据失败回滚本地视图,与已提交的 disk/main 状态分裂。广播循环每目标独立 try/catch(R63 同结论)。凡「commit 后 fan-out 通知」结构都须查广播抛错是否污染 commit 的返回值。R1-R23/R25-R33/R35-R64 共 62 修 + R24/R34 DEFER。

## R65 — plugin-fs scope-updated 广播 send 抛错反向打断 grant/revokeAll (P1)

- **文件**: `electron/main/ipc/plugin-fs.ipc.ts:77` registerPluginFsIpc 内 pathScopeRegistry.on('scope-updated') 回调
- **问题**: 该回调是 pathScopeRegistry 的 **EventEmitter listener**,遍历 webContents 直接 `wc.send(SCOPE_UPDATED)`。grant()/revokeAll() 会**同步** emit('scope-updated') 触发它。wc 在 `isDestroyed()` 检查后、send 前销毁 → send 抛 "Object has been destroyed" → 异常冒泡出 listener → 经 EventEmitter.emit **反向打断 grant/revokeAll 的调用栈** → 对应 IPC handler(request-scope / _unregister-plugin)收到异常返回失败,但 scope 已写入内存(grant)或 token 已 revoke / scope 已清(unregister)= **「授权状态已变更但调用方感知失败」的不一致**;且循环中断使后续窗口收不到 SCOPE_UPDATED。
- **修复**: 每个 wc.send 独立 try/catch,失败只 console.error 跳过,不让广播异常冒泡出 listener。镜像 i18n(R64)/protocol(R63)。
- **测试**: 新增 scope-updated-broadcast-send-throw.spec(R65):构造一个 send 抛错的 wc + 一个健康 wc,直接 `pathScopeRegistry.emit('scope-updated', payload)` 模拟 grant 触发 → 断言 emit **不抛**(grant/revoke 调用栈安全)+ 健康 wc 仍收到广播。中和(还原直接 send)确认回归。
- **沉淀**: send-fail-abort 广播族第五处(R62 / R63 / R64 / 本处)。**EventEmitter listener 内做 IPC 广播尤其危险**:listener 抛错经 emit() 反向传播到 emit 的调用方(此处是已半提交状态的 grant/revokeAll),使「副作用已发生但调用返回失败」。凡 `registry.on(event, () => fan-out send)` 结构都须把每个 send 包 try/catch,杜绝广播异常污染触发 emit 的业务调用栈。R1-R23/R25-R33/R35-R65 共 63 修 + R24/R34 DEFER。

## R66 — fs broadcastDirChanged 广播 send 抛错中断 + fs.watch 回调未捕获 (P1)

- **文件**: `electron/main/ipc/fs.ipc.ts:202` broadcastDirChanged()
- **问题**: 由 fs.watch 回调(watcherPool onChange,line 275)触发,遍历 BrowserWindow 裸 `w.webContents.send(DIR_CHANGED)`。窗口在 `isDestroyed()` 检查后、send 前销毁 → send 抛 "Object has been destroyed":(1)中断循环 → 后续窗口漏收 DIR_CHANGED,Explorer/外部文件同步停在旧树/旧内容;(2)裸抛在 **fs.watch 异步事件回调**里成主进程未捕获异常(噪声/崩溃风险,无 IPC handler 兜底)。
- **修复**: 每个窗口的 send 独立 try/catch,失败只 console.error 跳过并继续广播其它窗口。导出 broadcastDirChanged 仅供回归测试(生产仍只经 watcherPool onChange 调用)。
- **测试**: 新增 dir-changed-broadcast-send-throw.spec(R66):第一个窗口 send 抛错 → broadcastDirChanged **不抛**(回调安全)+ 其后健康窗口仍收到 DIR_CHANGED。中和(还原裸 send)确认回归。
- **沉淀**: send-fail-abort 广播族第六处(R62 / R63 / R64 / R65 / 本处)。**fs.watch / setInterval / EventEmitter 等异步事件回调里的广播更危险**——没有 IPC handler 的 try/catch 兜底,裸抛直接成进程级未捕获异常。本族已遍历主进程全部「检查存活→fan-out send」入口:agent-auth(R62)、protocol-dispatch(R63)、i18n(R64)、plugin-fs scope-updated(R65)、fs DIR_CHANGED(R66)。统一解=每个 send 独立 try/catch。R1-R23/R25-R33/R35-R66 共 64 修 + R24/R34 DEFER。

## R67 — plugins PLUGINS_CHANGED 广播 send 抛错 + onChange 抛错阻 mtime 推进致反复触发 (P1)

- **文件**: `electron/main/ipc/plugins.ipc.ts`(广播)+ `electron/main/services/plugins.service.ts:846`(顺序)
- **问题**: createPluginsWatcher 的 onChange 回调(plugins.ipc)遍历窗口裸 `win.webContents.send(PLUGINS_CHANGED)`。窗口在 isDestroyed() 检查后销毁 → send 抛 "Object has been destroyed":(1)**广播中断** → 后续窗口漏收插件热重载通知;(2)更隐蔽:onChange 抛错冒泡**回 watcher 扫描循环**,被其 per-entry `try{}catch{continue}` 吞掉,而 onChange 调用在 `mtimes.set(pluginId, mtime)` **之前** → mtimes 不推进 → 下一 tick `prev !== mtime` 仍成立 → **同一变更每 2s 反复触发、反复失败**(广播永远打不出去)。
- **修复(两部分)**:
  - **A**: 把广播抽成导出 `broadcastPluginsChanged(id)`,每个窗口 send 独立 try/catch,失败只 console.error 跳过(广播族统一解,R63-R66 同)。
  - **B**: watcher 内**先 `mtimes.set` 再 onChange** —— 变更检测一旦确认即记录 mtime,通知(onChange)成败不影响 mtime 推进;坏窗口由 A 的 per-window try/catch 兜底,不再回灌脏状态致反复触发。
- **测试**: plugins-watcher.spec +1(B:onChange 抛错 → mtime 仍推进,下一 tick 不重复触发)+ 新增 plugins-changed-broadcast-send-throw.spec(A:单窗口 send 抛错 → broadcastPluginsChanged 不抛 + 其后窗口仍收到)。两部分分别中和确认回归。
- **沉淀**: send-fail-abort 广播族第七处(R62-R67)。本例叠加**第二层缺陷**:广播失败不仅丢通知,还经「异步事件回调 throw → 上游扫描循环 catch → 状态不推进」形成**自我重放**(同一变更反复触发)。**「检测变更 → 记录已处理 → 通知」三步,记录必须在通知之前(或独立于通知成败),否则通知失败会让"已处理"标记不落地 → 无限重试**。与 R11(load 在途 write 不回滚)、R61(写写串行)同属「副作用顺序/状态推进」族。R1-R23/R25-R33/R35-R67 共 65 修 + R24/R34 DEFER。

## R68 — terminal SESSIONS_CHANGED 广播 send 抛错中断后续窗口 (P2)

- **文件**: `electron/main/ipc/terminal.ipc.ts` terminalSessions.subscribe 广播(抽为 broadcastSessionsChanged)
- **问题**: terminalSessions 的 subscriber 遍历窗口,按 `ownerWindowId` 过滤后裸 `w.webContents.send(SESSIONS_CHANGED, snapshot)`。窗口在 `isDestroyed()` 检查后、send 前销毁 → send 抛 "Object has been destroyed" → 中断窗口循环 → 坏窗口之后的其它窗口漏收终端会话快照,Dock/Terminal 面板停在旧 session 列表直到下一次 session 变化。(session mutation 本身被 terminal-sessions.service 的 subscriber try/catch 保护不回滚,故定 P2;但跨窗口陈旧态仍真实。)
- **修复**: 抽出导出 `broadcastSessionsChanged()`,每个窗口的 send 独立 try/catch,失败只 console.error 跳过并继续给其它窗口发送。
- **测试**: 新增 sessions-changed-broadcast-send-throw.spec(R68):第一个窗口 send 抛错 → broadcastSessionsChanged **不抛** + 其后窗口仍收到按其 ownerWindowId 过滤的 SESSIONS_CHANGED。中和(还原裸 send)确认回归。
- **沉淀**: send-fail-abort 广播族第八处(R62-R68)。本族已穷尽主进程「检查存活→fan-out send」全部入口:agent-auth(R62)/protocol-dispatch(R63)/i18n(R64)/plugin-fs scope-updated(R65)/fs DIR_CHANGED(R66)/plugins PLUGINS_CHANGED(R67)/terminal SESSIONS_CHANGED(R68)。**主进程对多窗口广播 IPC 必须每个 send 独立 try/catch** —— 统一不变量。R1-R23/R25-R33/R35-R68 共 66 修 + R24/R34 DEFER。

## R69 — packaged 冷启动 argv co:// 直发绕过统一协议路由 (P1)

- **文件**: `electron/main/index.ts:904` app.whenReady 内冷启动协议处理
- **问题**: packaged(`!process.defaultApp`)冷启动从 `process.argv` 取到的 co:// 此前在 `win.webContents.once('did-finish-load', () => win.webContents.send(PROTOCOL_URL, {url}))` 里**直发**,绕过已统一的 `routeProtocolUrl` + 共享 `pendingProtocolUrls` FIFO 队列 + R63 的「send 成功才出队 / 失败保留队首」韧性逻辑。两个漏洞:(1)主窗在 load 前关闭 → did-finish-load 永不触发 → 冷启动深链永久丢失;(2)load 后、send 前窗口销毁 → send 抛 "Object has been destroyed" → 深链丢失 + 在事件回调里成未捕获异常。
- **修复**: 改为 `if (url) dispatchProtocolUrl(url)` —— 交统一协议路由。win 经 createMainWindow 已挂 `attachWindowDrain`(index.ts:353),dispatchProtocolUrl 把 URL 入 pendingProtocolUrls 后由该 drain 在窗口就绪时韧性消费(R63:send 失败保留队首,留给下个窗口/下次 did-finish-load)。顺带移除不再被读取的 `let win`(两分支 createMainWindow 仅留副作用调用,lint no-unused-vars)。
- **测试**: 无新增专用测试 —— index.ts 是 app 入口(import 即跑 app 级副作用,不可单元导入)。R69 是「删除直发绕过、委托给已测的 dispatchProtocolUrl→routeProtocolUrl→drainPendingProtocolUrls」型修复,其 send 抛错韧性 + FIFO 不丢由 protocol-dispatch.test.ts(R63 三测)覆盖;冷启动 URL 现走同一受测路径。typecheck + lint + 全量 suite(3786)确认无破坏。
- **沉淀**: 修了统一机制(R39-R41/R63)后,必须 grep 所有**绕过该机制的旁路直发点**——本例是 packaged 冷启动 argv 这条与 open-url/second-instance(都已走 dispatchProtocolUrl)并行的入口,独自保留了旧直发。**「建了中央化韧性机制就要消灭所有旁路」**,与 send-fail-abort 广播族(R62-R68)同理但方向相反:那是给每个入口加 try/catch,这是把旁路并入唯一受保护通道。R1-R23/R25-R33/R35-R69 共 67 修 + R24/R34 DEFER。

## R70 — notify pushNotification 定向+广播 send 抛错遮蔽原业务错误/中断后续 (P2)

- **文件**: `electron/main/ipc/notify.ipc.ts:44`(定向)+ `:51`(广播)
- **问题**: pushNotification() 两条路径都只 isDestroyed() 检查后裸 `webContents.send`。窗口在检查后销毁 → send 抛 "Object has been destroyed"。两个影响:(1)**定向**:pushNotification 常被失败处理路径当兜底反馈调用(PTY exit / auth revoke / 各种 error toast),通知 send 裸抛会**反过来遮蔽原业务错误处理**(本想报告错误 A,却抛出无关的 send 异常 B);(2)**广播**:一个坏窗口中断循环 → 后续窗口漏收通知。
- **修复**: 定向和广播的每次 send 各包独立 try/catch,失败只 console.error(logFallback 已 console 过 payload)并继续。
- **测试**: notify-main-broadcast.spec +2(R70):定向 send 抛错 → pushNotification **不抛**(不遮蔽原业务错误);广播首窗 send 抛错 → 不抛 + 后续窗口仍收到 PUSH。两测试分别中和确认回归。
- **沉淀**: send-fail-abort 族第九处(R62-R70)。**纠正 R68「本族已穷尽」的误判** —— notify.ipc 既是广播族新入口,又揭示**定向单发**(非循环)同样需 try/catch。**「兜底反馈通道(toast/notify)的 send 失败绝不能抛」尤为关键**:它处于错误处理路径的最末端,自身抛出会吃掉它本要报告的真错误,把可诊断故障变成误导性的 "Object has been destroyed"。凡 `BrowserWindow.fromId(id)?.webContents.send` 单点定向投递都须 try/catch(不止广播循环)。R1-R23/R25-R33/R35-R70 共 68 修 + R24/R34 DEFER。

## R71 — terminal safeSend send 抛错卡死 flush(终端永久停旧输出)(P1)

- **文件**: `electron/main/services/terminal.service.ts:111` safeSend()
- **问题**: safeSend 只检查 `target.isDestroyed()` 后裸 `target.send(...)`。webContents 在检查后销毁(窗口关闭竞态)→ send 抛 "Object has been destroyed"。safeSend 被 PTY onData/flush timer/exit 回调调用,**最严重在 handleChunk 的 flush 闭包**:
  ```
  const flush = () => {
    if (inst.pendingData) { safeSend(...); inst.pendingData = ''; }  // send 抛 → 后两步跳过
    inst.flushTimer = null;                                          // ← 不执行
  };
  ```
  send 抛 → `pendingData=''` 和 `flushTimer=null` 都不执行 → 下个 chunk 进 handleChunk 时 `if (!inst.flushTimer)` 为 false(timer 已 fire 但引用还在)→ **不再 setTimeout 调度 flush** → 终端面板永久卡在旧输出;且 flush 是 setTimeout 回调,裸抛成主进程未捕获异常(崩溃/噪声)。
- **修复**: safeSend 内 send 包 try/catch,失败只 warnOnce 不冒泡,保证调用方(flush)继续清 pending/timer。后续 send 由 isDestroyed() 检查短路(销毁的 webContents isDestroyed() 返 true),无需显式删 target(评估后判定 codex 建议的 delete 冗余)。一处修复保护全部调用点(onData/flush/overflow/exit)。
- **测试**: multi-window-routing.spec +1(R71):flush 时 send 抛错一次 → advanceTimers **不抛** + 后续 chunk 仍能重新调度并送达同窗口(证明 flushTimer 已清,未卡死)。中和(还原裸 send)确认回归。
- **沉淀**: send-fail-abort 族第十处(R62-R71),也是后果最重一处 —— 不只是丢一次投递,而是**投递异常打断了清理副作用状态的后续语句,使节流状态机(pendingData/flushTimer)永久卡死**。**「投递 + 紧随其后的状态清理」必须保证投递失败不阻断清理**:要么投递包 try/catch(本例),要么把状态清理放投递之前/finally(与 R67-B「mtimes.set 前置」同思路)。名为 safe* 的 helper 必须真正吞掉它声称防御的失败。R1-R23/R25-R33/R35-R71 共 69 修 + R24/R34 DEFER。

## R72 — plugin-shell-stream send 抛错阻断 finalize 致 active/timer 泄漏 (P1)

- **文件**: `electron/main/services/plugin-shell-stream.service.ts:116` send() helper
- **问题**: send() 只检查 `senderWc.isDestroyed()` 后裸 `senderWc.send(...)`。renderer reload/关窗在检查后销毁 webContents → send 抛 "Object has been destroyed"。两处后果:(1)`child.stdout/stderr.on('data', chunk => send(...))` 裸抛 → 主进程未捕获异常;(2)`child.on('error', err => { send('stderr', ...); finalize(-1, null); })` —— send 在 finalize **之前**,若 send 抛则 **finalize 不执行** → active 条目 + timeoutTimer 泄漏(spawn error 的子进程不发 'close',finalize 不会被 close 路径补触发,插件侧 stream 也永远等不到 exit)。(注:finalize 自身是先清理后 send('exit'),故 close 路径安全;漏的是 error 路径 send 在前。)
- **修复**: send helper 内 `senderWc.send` 包 try/catch,失败静默丢弃不冒泡(stream 由 did-start-navigation/finalize 清理)。一处修复保护全部调用点(stdout/stderr data / error / exit)。
- **测试**: plugin-shell-stream.test +1(R72):令 sender.send 抛(isDestroyed 仍 false 模拟竞态)+ 无效可执行触发 child 'error' → 轮询同 id 可重新 START(active 已清);中和(还原裸 send)→ active 泄漏 → re-START 抛 "already active" 确认回归。
- **沉淀**: send-fail-abort 族第十一处(R62-R72),与 R71 同构(投递抛错阻断紧随的清理/终结)。**「先投递事件、再 finalize/清理」的顺序最危险**:投递失败时清理被跳过 → 资源泄漏。两类正解:(a)投递包 try/catch 使其不冒泡(R71/R72);(b)清理放投递之前(finalize 已这么做:clearTimeout+active.delete 在 send('exit') 前,故 close 路径天然安全)。审计同类「事件回调里 send 后还有清理语句」必查 send 在不在清理前。R1-R23/R25-R33/R35-R72 共 70 修 + R24/R34 DEFER。

## R73 — request-scope createRequest 后 send 抛错致 pending 泄漏到 TTL(授权假死)(P1)

- **文件**: `electron/main/services/plugin-fs.service.ts:531` REQUEST_SCOPE handler
- **问题**: 流程是 `correlator.createRequest(token, scopes, sender.id)` 登记 pending → `event.sender.send('plugin-fs:scope-request', ...)` 通知 renderer 弹窗 → `await promise`。下方 try **只裹 `await promise`,不裹这次 send**。sender 在 createRequest 后、send 前销毁(renderer reload/关窗)→ send 抛 "Object has been destroyed" → 冒泡出 handler,且该 pending 留在 correlator 直到 **5min TTL** 才被 sweep。后果:插件侧 `app.fs.requestScope()` 一直挂着(等满 TTL 才失败),且用户从未看到授权弹窗(send 失败)= **「授权请求假死」**。与 agent-auth R62(pending.set 后 send 抛)、R72 同源(登记后投递,投递抛阻断/泄漏)。
- **修复**: send 包 try/catch,失败时 `correlator.cancelBySender(event.sender.id)` 立即清掉本 sender 的 pending(sender 已死)+ 返回终态 'deny';`promise.catch(() => undefined)` 吞掉 cancel 触发的 reject(此处不再 await 它),避免 unhandled rejection。
- **测试**: request-scope-swallows-window-closed.spec +1(R73):令 event.sender.send 抛 → handler **立即 resolve 'deny'**(不挂到 TTL)+ 事后 `cancelBySender` 返 0(pending 已清无残留)。中和(还原裸 send)确认回归。
- **沉淀**: send-fail-abort 族第十二处(R62-R73)。**「登记 pending/in-flight → 再投递触发对端」的反向请求,投递这一步必须 try/catch,失败立即取消登记**,否则等待方挂到 TTL = 假死。本族两类:广播 fan-out(R62-R70)与单点反向请求(R62 agent-auth / R73 plugin-fs scope / R72 shell-stream)。审计要点:凡 `createRequest()/pending.set()` 紧跟 `send()` 且 send 不在覆盖它的 try 内,都是泄漏点。R1-R23/R25-R33/R35-R73 共 71 修 + R24/R34 DEFER。

## R74 — plugin-mcp tool dispose→register 同名无串行致 reload TOOL_NAME_TAKEN (P1)

- **文件**: `src/plugins/registries/PluginMcpRegistry.ts:113` Disposable.dispose() / :91 register()
- **问题**: dispose() 是同步的(plugin Disposable 模型),内部同步删本地 entries + **fire-and-forget** `void this.upstream.unregister(name).catch(...)`(unregister IPC 异步、不 await)。register() 本地 `entries.has` 检查(dispose 已删,通过)后直接 `await upstream.register`。插件 reload / disable→enable 时:`_deactivate()` 同步 dispose → 立刻 `registerMcpTool('same.name')`。两条 IPC 竞争:register 可能先于 unregister 到 main → main 仍持旧同名 tool → 返回 **TOOL_NAME_TAKEN** → reload 后该 tool 注册失败 / main 端残留旧 stub。
- **修复**: 加 `pendingUnregister: Map<name, Promise<void>>`。dispose 把 unregister(已 .catch 包装成 resolve void)记入该 map,settle 后清表(仅当仍是本 promise,避免清掉后继 dispose 的)。register 在 `await upstream.register` 前先 `await` 同名在途 unregister,保证「先 unregister 落地、再 register」。dispose 仍保持同步契约(只是额外记录 promise)。
- **测试**: registry.spec +1(R74):注入 deferred-unregister 的 fake upstream → register→dispose→立即 re-register;断言 unregister resolve 前 re-register 的 upstream.register **未被调用**(order=[register, unregister-start]),resolve 后才发(order 追加 unregister-done, register)。中和(去掉 await pending)确认回归。
- **沉淀**: 「同步 dispose 触发异步 unregister + 紧接同名 register」是 reload 类竞态的通用形态。**同一资源 key 的 unregister/register 必须串行(后者 await 前者在途完成)**,与 R21/R61(写写串行)、R67-B(记录前置)同族,但本例跨「释放↔再获取」生命周期边界。fire-and-forget 的清理 IPC 必须留下可被后继操作 await 的句柄,否则 reload 抢跑 = 注册失败/残留。R1-R23/R25-R33/R35-R74 共 72 修 + R24/R34 DEFER。

## R75 — MCP host token 仅 readBody 前校验一次,撤销期间旧 token 仍可调工具 (P1,TOCTOU)

- **文件**: `electron/main/services/mcp-host.service.ts:445/493` handleMessage
- **问题**: handleMessage 在 `await readBody(req)` **之前**校验一次 bearer token(得 ctx),随后 `await readBody` + `JSON.parse` 可能较慢;最后用那个 ctx 执行 `dispatchRpc(rpc, tools, serverInfo, ctx)`。TOCTOU 窗口:body 读取/解析期间若发生 `rotateToken()`(用户撤销 agent 授权 → `revokeAndKillAgentSessions` → `rotateToken`),旧 ctx 已失效但仍被复用 → **「撤销后、body 尚未发完」的旧 token 请求仍能调用工具**(绕过撤销)。
- **修复**: parse 之后、dispatchRpc 之前用最新 token 状态 `host.verifyAndResolveCtx(authorization)` **二次校验**;失败返 401(用 rpc.id)不复用旧 ctx;成功用 freshCtx(窗口归属以最新为准)dispatch。首次校验保留(对明显未授权请求免读 body 早拒)。
- **测试**: 新增 mcp-host-reverify-on-rotate.spec(R75):用 node:http 把 body 分两段发,两段间 `host.rotateToken()` —— 确定性命中 readBody 窗口 → 断言 401 + 工具 `invoked===false`;并加正常请求仍 200+执行的契约保持测试。中和(还原用旧 ctx dispatch)→ 旧 token 仍 dispatch 非 401 确认回归。
- **沉淀**: send-fail-abort 之外的另一竞态族 **「校验后 await 慢操作再用旧凭据/状态」(TOCTOU)**:鉴权、容量、归属等检查若在 `await`(IO/body/IPC)之前做、之后用,中途状态变更使旧判定失效。**凡安全/授权检查与实际动作之间隔着 await,动作前必须用最新状态重校验**。与 R2x 系列「latest-wins / generation 重校验」同思想,本例是 token 维度。R1-R23/R25-R33/R35-R75 共 73 修 + R24/R34 DEFER。

## R76 — revokeToken/revokeWindowTokens 不关闭已建立的 SSE 连接致撤销后 stale + 泄漏 (P2)

- **文件**: `electron/main/services/mcp-host.service.ts:607/610` revokeToken/revokeWindowTokens
- **问题**: 两个 revoke 只 `windowTokens.delete`,不关闭该 token/window 已建立的 SSE 连接。handleSse 校验一次后把 res 加进全局 `sseClients`,之后 revoke 触达不到它。撤销 agent 授权(或关窗的 per-window 撤销)后:旧 MCP client 的 SSE 仍 keepalive interval 不停、且继续收 `broadcast()` 推送 → **撤销后的 stale 连接 + keepalive interval 长期泄漏**。(对比:`rotateToken()` 已正确踢断所有 SSE;定向 revoke 这条平行路径漏了。)
- **修复**: `sseClients` 从 `Set<ServerResponse>` 升级为 `Map<res, {windowId, token, keepalive}>`(handleSse 存 ctx 的 ownerWindowId + callerSubject + keepalive 句柄)。加 `closeSseClient(res)`(清 interval + 删表 + end,幂等)。revokeToken 关闭 `meta.token===token` 的连接;revokeWindowTokens 关闭 `meta.windowId===windowId` 的连接。broadcast 改迭代 `keys()` + dead 走 closeSseClient;rotateToken/close 迭代时一并 clearInterval(此前漏清 keepalive interval)。
- **测试**: mcp-host-reverify-on-rotate.spec +1(R76):node:http 建真 SSE(GET /mcp)→ 等 ready → `revokeToken(token)` → 断言服务端 end 该连接(sseClosed resolve);中和(revoke 不关 SSE)→ 连接保持 → 测试 5s 超时确认回归。
- **沉淀**: 与 R75 同属「撤销/失效未传播到已建立的长连接」。**token/授权撤销必须同时作用于(a)后续校验(删 token)和(b)已建立的长生命周期连接(SSE/stream)**,只做 (a) 则旧连接逃逸。全量踢断(rotateToken)与定向撤销(revokeToken/Window)是平行入口,修一个必查另一个是否传播(本族复发主题:防御/清理建了未传播到所有兄弟入口)。顺带修 rotateToken/close 迭代漏 clearInterval 的 keepalive 泄漏。R1-R23/R25-R33/R35-R76 共 74 修 + R24/R34 DEFER。

## R77 — reload 用瞬时 status 而非用户启用意图判重激活,坏快照致持久启用插件停用 (P2)

- **文件**: `src/plugins/PluginManager.ts:281` reloadLocked()
- **问题**: reloadLocked 用 `wasEnabled = entry.status === 'enabled'` 决定重载后是否重激活。热重载由 mtime watcher 每 2s fire-and-forget 触发,连续事件易读到**半写入/瞬时非法 manifest**(JSON 合法、id 匹配能被 find 到,但缺 name/version 等 → parseManifest 失败)→ 把已启用插件先 deactivate 再置 `status='failed'`。随后文件修好再次 reload 时 `wasEnabled = (status==='enabled')` 为 **false** → status 被设成 'disabled' 且不激活。**结果:持久启用(_enabled.json 仍列)的插件因一次瞬时坏快照在会话内被停用,直到用户手动启用或重启。**
- **修复**: PluginEntry 加 `enabledIntent: boolean` —— 用户「启用意图」,与运行态 status 解耦。init 自 `_enabled.json`(enabledIds.has)初始化;仅 enable(成功持久化时)/disable 修改(镜像 mutateEnabledId 写 _enabled.json),uninstall 删整个 entry。reloadLocked 改用 `wasEnabled = entry.enabledIntent`:坏快照置 failed 后 enabledIntent 仍 true,修好 reload 据意图重激活。
- **测试**: plugin-manager.spec +1(R77):启用插件 → reload 半写入 manifest(`{id:'r'}` 缺 name/version)→ failed → 修好 manifest reload → 断言回到 enabled。中和(还原 status-based wasEnabled)→ 修好后变 disabled 确认回归。
- **沉淀**: **「用户意图」与「运行态」必须分离存储** —— 运行态(active/failed/disabled)会被瞬时事件(坏快照、激活失败、依赖缺失)改写,若用它推断「是否应启用」,一次瞬时故障就把持久配置改没了。意图字段(此处 enabledIntent,镜像 _enabled.json)只由显式用户动作改,自动流程(reload)只读不写。与 R67-B(检测记录独立于通知成败)同思想:别让易变的派生态污染稳定的源头意图。R1-R23/R25-R33/R35-R77 共 75 修 + R24/R34 DEFER。

## R78 — dismiss 后在途 refresh 用旧 PluginManager 快照复活已 dismiss 的更新 (P2)

- **文件**: `src/marketplace/update-store.ts:53` dismiss() / refresh()
- **问题**: dismiss(id) 只从当前 `available` 乐观删除,不能让已在途的 refresh() 失效。`refreshGen` 只防并发 refresh;R7 修复(提交前重读 liveInstalled)只防「卸载」(插件从 listAll 消失)。但**更新场景**:用户点更新成功 → dismiss(id) + mgr.reload(id)(异步,未必立即落地)。一个在 dismiss 之前发起、之后提交的在途 refresh,提交时 mgr.reload 尚未完成 → liveInstalled 里该插件仍是**旧版本** → `isNewerVersion(remoteV, oldVersion)` 为真 → 把同一 update 重新加进 available,覆盖 dismiss → **Marketplace 更新角标/按钮在成功更新后复活**。
- **修复**: store 加 `dismissed: Map<id, toVersion>`。dismiss(id) 查 available 里该项的目标版本并记入 dismissed。refresh() 提交前(读最新 `get().dismissed`)过滤掉「id 已 dismiss 且目标版本 === remoteV」的项。远端 toVersion 变化(出现更新的版本)→ `dismissed.get(id)!==remoteV` → 重新显示。
- **测试**: marketplace-update-store.spec +1(R78):available 含 a@1.0.0→2.0.0;deferred fetchManifest 使 refresh 在途;in-flight 期间 dismiss('a')(mgr 仍 a@1.0.0 模拟 reload 未落地)→ resolve manifest 2.0.0 → 断言 available 仍空(未复活)。中和(去掉 dismissed 过滤)→ a 复活 confirms 回归。
- **沉淀**: 乐观 UI 移除(dismiss)对抗「在途异步重算」必须用**版本/代际维度的抑制集**,而非仅删当前快照 —— 因为在途任务持的是旧输入快照,提交时会重算出被删项。与 R7(提交前重读 live)同主题但补全:重读 live 只覆盖「实体消失」,覆盖不了「实体仍在但状态未更新(reload 未落地)」,需额外的「已处理版本」抑制。`refreshGen`(并发防护)+ live 重读(消失防护)+ dismissed 版本集(迟到复活防护)三者正交,缺一不可。R1-R23/R25-R33/R35-R78 共 76 修 + R24/R34 DEFER。

## R79 — useExternalFileSync effect cleanup 不失效在途 readFile,迟到结果回滚 clean tab (P2)

- **文件**: `src/panels/Editor/useExternalFileSync.ts:43` effect / settle
- **问题**: effect 的 cleanup 此前只 `return unsub`(取消 onDirChanged 订阅),不让已在途的 `coApi.fs.readFile(...).then(settle)` 失效。EditorPanel 卸载/重挂或 React StrictMode 双 effect(dev mount→cleanup→remount)时,旧 effect 发起的慢读仍会在 cleanup 之后 resolve → settle → `reloadFromDisk(tabId, 旧快照)`。**结果:clean tab 被迟到的旧磁盘内容回滚;用户随后基于旧内容编辑/保存,覆盖外部已写入的真实新内容。**(in-flight 合并/seqByPath/reject 兜底都只在单个 effect 生命周期内防乱序,跨 effect 边界的迟到 settle 没防。)
- **修复**: effect 内加 `let cancelled = false`;cleanup 改 `() => { cancelled = true; unsub(); }`;settle 开头 `if (cancelled) return`(过期 effect 的迟到结果直接丢弃,不 reloadFromDisk;inFlight/pending 随闭包 GC 无需手清)。
- **测试**: external-file-sync-out-of-order.spec +1(R79):deferred readFile 在途 → renderHook unmount(触发 cleanup,断言 unsub 调用)→ 此后 read 才 resolve → 断言 reloadFromDisk **未被调用**。中和(去掉 cancelled 守卫)→ 迟到结果落地确认回归。
- **沉淀**: **useEffect 里发起的异步(readFile/fetch/IPC)其 `.then` 回调必须受 effect 生命周期门控** —— cleanup 只退订事件不够,还要用 cancelled/generation 令牌使「cleanup 后才 resolve 的回调」成 no-op。否则卸载/重挂/StrictMode 双跑时,旧 effect 的迟到回调污染新状态。这是 R75/R76(撤销未传播到长连接)在「组件 effect 异步」维度的对应,也与 R27/R28(createLatestGuard latest-wins)同思想:异步落地前校验自己仍是当前轮次。R1-R23/R25-R33/R35-R79 共 77 修 + R24/R34 DEFER。

## R80 — wrap-panel-close 真实 close 路径漏 markPanelCloseSuppressed,双 terminal.remove 竞争 (P2)

- **文件**: `src/shell/dock/wrap-panel-close.ts:66` 延迟 close timer
- **问题**: `src/shell/dock/README.md` 明确约定:真实 close 路径(× 按钮 / 中键 / 程序调用)的 patched `api.close` 必须在实际 `close()` **之前** `markPanelCloseSuppressed(id)`,使随后 dockview `onDidRemovePanel → handleTerminalPanelRemoved` 认出这是已处理的真 close(PTY 已删)而早退。但实装的 timer 里 `removeTerminalPtysForPanel(panel)`(发 terminal.remove IPC #1)后**直接** `original()`,未标记。于是 onDidRemovePanel → handleTerminalPanelRemoved 中 `consumePanelCloseSuppressed` 返回 false → 经 move-vs-close 兜底(panel 已删)→ 发**第二次** terminal.remove(IPC #2)。两 IPC 并发:若 #2 先删 metadata,#1 收 NOT_FOUND → `notify.error` 误报「关闭失败」;且重复 kill/remove 同一 PTY session。
- **修复**: timer 内 `original()` 前 `if (isTerminalPanelId(id)) markPanelCloseSuppressed(id)`。仅 terminal panel 标记(consume 端只对 terminal panel 接线;非 terminal id 标记会泄漏进 suppressedPanelCloses 集无人 consume)。
- **测试**: wrap-panel-close-remove-feedback.spec +2(R80):真 close 落地后 `consumePanelCloseSuppressed('terminal-s6')===true`(handleTerminalPanelRemoved 会早退)+ 二次 consume false;被 cancelPendingPanelClose 取消的 close 不标记(无泄漏)。中和(删标记行)→ suppressed 未标记确认回归。
- **沉淀**: 有文档约定的协作协议(此处 README 的 suppress-before-close)必须在所有实装路径落实 —— 实装漏一处 = 协议两端失配 → 重复副作用(双删/双 kill)。属本族高频主题「防御/标记建了未传播到所有兄弟入口」的协议维度:reconciler close 路径(DockReconciler:131)已 mark,真实 close 路径(wrap-panel-close)漏 mark。同一资源由两条事件路径(主动删 + 事件回调兜底)处理时,主动方须显式抑制兜底方,否则并发重复执行。R1-R23/R25-R33/R35-R80 共 78 修 + R24/R34 DEFER。

## R81 — HookFileBroker.start() await mkdir 后未复查 stopped/代际,致 stop 后复活泄漏 (P2)

- **文件**: `electron/main/services/mcp-tools-hook-bridge.ts:330` start()
- **问题**: start() 流程 `if(started)return; started=true; stopped=false; await mkdir(...); → attach watcher + setInterval(cleanupTimer)`。`await mkdir` 是让权点。若 stop() 在 mkdir 挂起期间执行(stopped=true、started=false、close 此刻仍为 null 的 watcher/timer),start() 恢复后**不复查**就继续 attach watcher + cleanupTimer → **broker 已标记 stopped 却"复活"**:watcher/timer 泄漏(stop 已跑过不会再清)、stopped 态与实际资源不一致、后续 hook 文件仍被 ingest。start→stop→start 交错时,旧 start 还会覆盖新 start 的 watcher/timer 引用致再泄漏。
- **修复**: 加 `startGen` 启动代际,start() 入口 `const myGen = ++startGen`;`await mkdir` 返回后 `if (stopped || myGen !== startGen) return`(过期启动不接资源)。started/stopped 由插入的 stop()/start() 维护,本次只负责不 attach。
- **测试**: stop-hook-window-close.spec +1(R81):`const startP = broker.start()`(挂在 await mkdir)→ `await broker.stop()` → `await startP` → 断言 `vi.getTimerCount()===0`(cleanupTimer 未被复活创建)+ awaitNext reject(stopped 态)。中和(删 await 后复查)→ timer 泄漏确认回归。
- **沉淀**: TOCTOU 第三例(R75 token / R79 effect / 本处 start/stop)。**异步初始化(start)在 await 之后 attach 长生命周期资源(watcher/interval)前,必须复查自身是否仍是当前轮次**(stopped 标志 + 启动代际),否则与并发的 teardown(stop)交错会「停止后复活」泄漏资源。与 R27/R28(latest-wins)、R74(unregister→register 串行)同族:跨「启动↔停止」生命周期边界的异步操作须代际门控。R1-R23/R25-R33/R35-R81 共 79 修 + R24/R34 DEFER。

## R82 — CreateInput 快速双 Enter 双提交,并发两次 createFile/createDir (P2)

- **文件**: `src/panels/Explorer/CreateInput.tsx:49` keydown handler Enter 分支
- **问题**: Enter 提交无同步 once/in-flight 守卫。父层 submitCreate 的 `setCreating(null)`(卸载 CreateInput)要等 React commit;在 commit 之前快速双 Enter 会在同一挂载实例里两次进 handler → 两次 `onSubmit(t)` → 并发两次 createFile/createDir IPC。第一笔成功、第二笔通常 EEXIST 失败弹错 → 用户见「创建成功却报错」,且给底层制造无意义并发。
- **修复**: CreateInput 加 `submittedRef`(useRef,同步生效不依赖 React state commit)。Enter 分支先 `if (submittedRef.current) return`;实际提交前置 `submittedRef.current = true`。空白值走 onCancel 不置位(随即卸载,无后续 Enter)。
- **测试**: create-input.spec +1(R82):非空值连发 3 次 Enter → onSubmit 只调一次 + onCancel 不调。中和(去 once 守卫)→ onSubmit 调 3 次确认回归。
- **沉淀**: **「提交后靠 React state 卸载/禁用」无法防 commit 之前的重复触发** —— state 更新异步、原生 capture-phase keydown 可在同一帧连发。需同步 ref(submittedRef/in-flight ref)做 once 守卫,ref 写入即时生效。与 R43(commit amend token 守卫)、busyRef 族同思想:用户可重复触发的提交动作必须有同步单飞守卫,不能依赖异步 UI 态收起。R1-R23/R25-R33/R35-R82 共 80 修 + R24/R34 DEFER。

## R83 — before-quit MCP host/stdio close 未 await,与进程退出竞争致 socket 残留 (P2)

- **文件**: `electron/main/index.ts:950` app.on('before-quit') 清理
- **问题**: before-quit 清理里 `await termService.cleanupAll()` 之后,`mcpHost?.close()` 与 `mcpStdio?.close()` 是 `void ...catch()` **fire-and-forget**,紧接着 `markFinished()` + `app.quit()`。Electron 进程可能在 HTTP/SSE server 关闭(end SSE clients + close server)、stdio unix socket server close + `mcp.sock` unlink 完成**之前**就退出 → SSE/keepalive/socket 清理与退出竞态;`mcp.sock` 残留到下次启动的兜底清理;退出/测试路径也无法可靠等待资源释放。
- **修复**: 把两个 close 纳入与 cleanupAll 同段的 awaited 清理:`await Promise.allSettled([mcpHost?.close(), mcpStdio?.close()])` 后再 markFinished()+app.quit()。allSettled:单个 close reject 不阻断另一个、也不阻断退出;`?.close()` 为 undefined(host 未启)时 allSettled 视为已完成。
- **测试**: 无新增专用测试 —— index.ts 是 app 入口(import 即跑 app 级 bootstrap,不可单元导入,同 R69)。本修是「fire-and-forget → awaited」的 sequencing 改动;被 await 的 mcpHost.close()(end SSE + close server,R76 已测 SSE end)/mcpStdio.close() 各自有独立测试覆盖其真实关闭行为。typecheck + lint + 全量 suite(3802)确认无破坏。
- **沉淀**: **退出/teardown 路径里「释放资源」必须 await 到完成再触发进程退出** —— fire-and-forget 的 close 在 app.quit() 后被强制中断,留下未 unlink 的 socket / 未 flush 的状态。与本段已正确 await 的 cleanupAll 一致化:同一 teardown 里所有资源释放要么全 await,要么显式记录「故意不等」。凡 `app.quit()` / `process.exit()` 之前的清理,异步释放都不能 void。R1-R23/R25-R33/R35-R83 共 81 修 + R24/R34 DEFER。

## R84 — terminal search hotkey 微任务用 hook 级 mountedRef 而非 per-init teardownDone (P2)

- **文件**: `src/panels/Terminal/useTerminal.ts:323` attachCustomKeyEventHandler 内 search hotkey 的 queueMicrotask
- **问题**: 按搜索热键时 `queueMicrotask(() => { if (mountedRef.current) setSearchState(open) })`。`mountedRef` 是 **hook 级**(整个 useTerminal 生命周期),而 init 作用域已有 per-term 的 `teardownDone`(line 250,本文件其它 5 个异步回调 readHistory/safeWrite/resize 都用它,且注释 246-249 明确说明「StrictMode 双 mount 时 mountedRef 会被第二次 mount 置回,故用 teardownDone」)。session 切换(termId 变 → 同一 hook re-init doInitXterm,cleanup 旧 term + 新 term mount,mountedRef 经 false→true)或 StrictMode remount 同一 tick 内,旧 term 排队的这个微任务在新 term 已 mount 后才跑:mountedRef 此刻是 true → 旧微任务误把搜索框打开到新实例。
- **修复**: 微任务守卫改 `mountedRef.current` → `!teardownDone`(per-init 闭包变量;旧 term cleanup 置位,旧微任务据此丢弃)。与同文件其它异步回调一致。
- **测试**: 新增 terminal-search-hotkey-after-reinit.spec(R84):劫持 queueMicrotask 捕获回调(不调度)→ 在 term-a 按热键 → rerender termId='term-b'(cleanup#1 teardownDone#1=true + init#2 mountedRef 回 true)→ 手动执行被捕获的旧微任务 → 断言 searchApi.isOpen 仍 false。中和(还原 mountedRef)→ 'true' 误开确认回归。**测试时序坑**:必须劫持 queueMicrotask 手动延后执行,否则微任务先于 cleanup 跑(teardownDone 还 false,此时开在 term-a 上反而正确),复现不出「re-init 后才跑」的真 bug 窗口。
- **沉淀**: TOCTOU/迟到回调族(R79 effect cancelled / R81 start-gen / 本处)。**异步回调(微任务/定时器/IPC then)的存活守卫必须用「发起时所属那一轮」的 per-init 令牌(teardownDone/generation),不能用 hook/组件级的 mountedRef** —— 后者在 re-init/remount 后被新轮次置回 true,放过了旧轮次的迟到回调。同组件多个异步回调要统一用同一 per-init 令牌(本例是补齐漏用 teardownDone 的最后一处)。R1-R23/R25-R33/R35-R84 共 82 修 + R24/R34 DEFER。

## R85 — terminal drag-drop async 任务 await 后不复查 disposed,向旧 session 误注入 (P2)

- **文件**: `src/panels/Terminal/useTerminalDragDrop.ts:88` onDrop 的 fire-and-forget async 任务
- **问题**: 文件 drop 的 async 任务 `getPathForFile 循环 → terminal.write → focus`,各 await 后不复查本次 effect 的 `disposed`(line 46,cleanup 置位)。effect deps 含 sessionId,用户拖文件后**立刻关闭/切换 terminal panel**(effect cleanup 或以新 sessionId re-init)时,迟到任务仍用闭包捕获的**旧 sessionId** 调 `coApi.terminal.write` + 旧 `focus()`:旧 session 若仍存活 → **被意外注入拖放路径输入**;若已关闭 → 弹对已死实例的误导性 write_failed 反馈。
- **修复**: getPathForFile 循环后(write 前)`if (disposed) return`(丢弃迟到任务,不向旧 session 写);terminal.write 后(focus 前)再 `if (disposed) return`(write IPC 期间 cleanup → 不 focus 旧实例、不弹误导反馈)。复用 effect 的 disposed(per-effect)。
- **测试**: drag-drop.spec +1(S19/R85):deferred getPathForFile 使 drop 在途 → unmount(disposed=true)→ resolve path → 断言 terminal.write 与 focus 均未调用。中和(去两处 disposed 检查)→ write 被调确认回归。
- **沉淀**: 迟到回调族第四例(R79 effect / R81 start-gen / R84 search hotkey / 本处)。**effect 内 fire-and-forget async(尤其捕获 sessionId/id 等实例标识 + 调副作用 write/focus)必须在每个 await 之后、每个副作用之前复查 disposed/generation** —— re-init/unmount 后旧任务的捕获值已失效,继续执行 = 向错误实例注入。本仓 effect 异步守卫统一用 per-effect `disposed` 或 per-init `teardownDone`。R1-R23/R25-R33/R35-R85 共 83 修 + R24/R34 DEFER。

## R86 — MCP tool 先暴露给 main 再登本地表,刚注册首次调用 NO_SUCH_TOOL (P2)

- **文件**: `src/plugins/registries/PluginMcpRegistry.ts:101` register()
- **问题**: 注册顺序是先 `await this.upstream.register(...)`(把 tool 元数据暴露给 main)、resolve 后才 `this.entries.set(name, {invoke})` 写 renderer 本地可执行表。main 一旦完成 register,外部 MCP client 即可 `tools/call`;若该调用早于 renderer 的 await continuation 执行到 entries.set,`invokeLocal` 命中 `entries.get(name)===undefined` → 返回 **NO_SUCH_TOOL** = 「刚注册成功但首次调用失败」竞态。
- **修复**: 调换顺序 —— 先 `entries.set`(本地可执行表就位)再 `await upstream.register`(对外暴露)。这样 upstream.register resolve(main 暴露)时本地表已可执行,无 NO_SUCH_TOOL 窗口。upstream.register 用 try/catch 包裹,失败 `entries.delete` 回滚,保持原「upstream 失败不在本地残留、允许重试」语义(原 line 107 注释承诺)。
- **测试**: registry.spec +2(R86):(1)deferred upstream.register 内调 invokeLocal 模拟 main 暴露即被外部调用 → 断言返回 {echoed:'hi'} 而非 NO_SUCH_TOOL;(2)upstream.register reject → invokeLocal NO_SUCH_TOOL(已回滚)+ 重试第二次成功。中和(还原 upstream-first 顺序)→ 测试 1 NO_SUCH_TOOL 确认回归。
- **沉淀**: **「对外暴露(注册到中心/server)」与「本地准备好处理」之间的顺序:必须先准备好本地处理能力,再对外暴露**。反序则暴露后、本地就绪前的入站请求落空。与 R74(unregister→register 串行)同文件同主题:跨 renderer↔main 的 register/unregister 生命周期边界,凡「暴露」动作都要确保本地侧已 ready(R86 是 register 方向,R74 是 unregister→register 顺序)。upstream-success-then-local 的"失败可重试"语义可用 try/catch 回滚保持。R1-R23/R25-R33/R35-R86 共 84 修 + R24/R34 DEFER。

## R87 — explorer 持久化写无串行,旧 snapshot 在新之后落盘回滚 UI 状态 (P1)

- **文件**: `src/lib/persist/explorer-persist.ts:407` writeNow()(debounce persist + 关窗 flush 共用)
- **问题**: writeNow 各自 `snapshotFromStores()` 后裸 `await api.write(snap)`,无序列化/代际。两个写入口并发:debounce 自动写(store 变化)与关窗 flush(`activeFlush`)可提交不同时间点的 snapshot。慢盘/IPC 下,旧 snapshot 的 `api.write` 可能在新 snapshot 之后才进入 main 的文件 mutex;main 只互斥**不判新旧** → 旧窗口段覆盖新窗口段 → 刚打开/关闭的 tab、expandedPaths、workspace UI 状态被回滚。
- **修复**: writeNow 改**单飞写链**:`writeChain = writeChain.then(...)` 串行化(同窗口一次只一个 api.write 在途);`snapshotFromStores` 在链节**执行时**(而非入队时)读 → 每次写的都是当下最新态,旧写不可能携旧数据后落;`pendingWrite` 合并冗余写。writeNow 返回链尾 promise → flush(activeFlush)仍能 await 到最终写完成。
- **测试**: persistence-layer.spec +1(R87):deferred api.write → setRoot('/a') debounce 触发写#1(在途)→ setRoot('/b') + flush → 断言此刻 api.write 仍只调 1 次(#2 排队未并发)→ 放行 #1 → #2 执行读最新 → 断言最终落盘 root='/b'。中和(还原裸 await 无串行)→ #2 与 #1 并发(length 提前到 2)确认回归。
- **沉淀**: 「读快照 → 异步写盘」的多入口并发(自动写 + 显式 flush)若不串行,慢写乱序落地 = 旧覆盖新。**同一持久化目标的所有写入口必须共享单飞链,且快照在链节执行时读取(非入队时)**,保证「最后落盘 = 最新态」。与 R61(PluginDataStore 写写串行)、R15(IpcPermissionStore)同族,本例是 explorer 会话持久化维度;且补「执行时重读快照」使串行天然 always-latest。R1-R23/R25-R33/R35-R87 共 85 修 + R24/R34 DEFER。

## R88 — agent auth main 端超时 resolve denied 不通知 renderer,失效弹窗滞留 + 阻塞后续 (P2)

- **文件**: `electron/main/services/agent-auth.service.ts:66` 超时分支(根因)/ 修复落在 `src/stores/agent-auth.store.ts`
- **问题**: agent auth 的 5min `setTimeout` 只在 main 端把 pending resolve 为 `denied`(外部 agent 收到拒绝)+ 删 main pending,**不通知 renderer**。renderer 的 `ensure()` 设了 store.pending + Modal 弹窗,等用户 grant/deny;main 超时后这条 renderer pending 既不清、Modal 不关。后果:(1)用户离开超过 timeout 回来仍看到**过期授权弹窗**;(2)`ensure` 有 `if (pending !== null) return denied`,新 agent auth 请求被**立即拒**,直到用户手动点掉失效旧弹窗。
- **修复**(renderer 端同 TTL 本地超时,codex 提供的两方案之一,自包含无需新 IPC channel):store 加与 main `PROMPT_TIMEOUT_MS` 对齐(5min)的本地 `setTimeout`,ensure 设 pending 时启动;过期且仍是本请求 → deny + 清 pending(与 main 决定一致),Modal 关闭、后续请求不再阻塞。grant/deny/_resetAgentAuthForTest 都 `clearPendingTimer()` 防误触/泄漏。
- **测试**: auth-store.spec +2(R88):fake timers 推进 5min → ensure resolve 'denied' + pending 清空 + 新请求能重新挂起(不被阻塞);超时前 grant → resolve 'once' 且推进过 TTL 不再触发(timer 已清)。中和(移除本地超时)→ promise 永挂 5s 超时确认回归。
- **沉淀**: 跨进程「等待方在两端各有挂起态」时,一端(main)超时/取消必须传播到另一端(renderer)清理,否则一端结算、另一端永挂 = 失效 UI 滞留 + 单槽 pending 阻塞后续。与 R62(send-fail 清 main pending)、R73(scope cancelBySender)同主题但反向:那是 main 清 main,这是 renderer 也要响应 main 的超时。最简自包含解=两端各设同 TTL 本地超时(无需新取消通道)。R1-R23/R25-R33/R35-R88 共 86 修 + R24/R34 DEFER。

## R89 — plugin-fs scope 请求 main TTL 超时不通知 renderer,过期弹窗滞留挡队列 (P2,R88 同型)

- **文件**: `electron/main/services/scope-request-correlator.ts:123` _sweep(根因,TTL=DEFAULT_TTL_MS=300_000)/ 修复落在 `src/plugins/permissions/promptStore.ts`
- **问题**: 与 R88(agent-auth)完全同型,plugin-fs scope 维度。main 的 ScopeRequestCorrelator 5min TTL sweep 只 reject main pending(插件侧 requestScope 超时失败),**不通知 renderer**。renderer 的 `requestFsScope` 把 entry 放进 keyed Map(fsScopePending)+ FIFO 队列,currentFsScope=队首。main 超时后这条 renderer entry 既不清、Modal 不关;若它是队首,currentFsScope 永久停在它上 → 后续 scope 请求 append 到队列却**永不显示**(都在插件侧超时)。`ping()` keepalive 也无任何生产调用。
- **修复**(renderer 端同 TTL 本地超时,store-only,与 R88 一致):每个 requestFsScope 挂与 main 对齐的 300s 本地 `setTimeout`;过期且仍 pending → `resolveFsScope(...,'deny')`(清该请求 + 推进队列 currentFsScope)。grant/deny(resolveFsScope)统一 `clearFsScopeTimer` 防误触/泄漏。per-requestId timer Map(fs-scope 是多请求 keyed,不同于 agent-auth 单槽)。
- **测试**: promptStore.spec +3(R89):300s 无应答 → resolve 'deny' + currentFsScope 清;队首超时 → 推进到队列下一个(r2),r2 可正常 grant(此前被 r1 永久挡住);超时前 grant → 不被超时覆盖。中和(移除本地超时)→ 2 超时测试失败确认回归。
- **沉淀**: 与 R88 共同确立模式 —— **跨进程「等待方两端各有挂起态 + 有 TTL」的所有通道,renderer 侧都须设同 TTL 本地超时自清**(main 超时不主动通知)。本仓两处此型:agent-auth(R88,单槽 pending)、plugin-fs scope(R89,keyed Map + FIFO 队列,过期队首还会阻塞后续显示)。keyed/队列型比单槽型危害更大(不仅阻塞还隐藏后续请求)。R1-R23/R25-R33/R35-R89 共 87 修 + R24/R34 DEFER。

## R90 — HookFileBroker.ingestFile stat/readFile 期间 stop/restart 后重污染已清空状态 (P2)

- **文件**: `electron/main/services/mcp-tools-hook-bridge.ts:218` ingestFile()
- **问题**: ingestFile 只在入口查 `stopped`(line 219),随后 `await stat`、`await readFile`。这两个 await 期间若 stop()(清空 pending/buffered/processed)甚至 stop→start restart,迟到的 ingestFile 恢复后仍会 `processed.set` / 匹配 `pendingByKey` / `buffered.push`,**重污染已清空(或新一代)的 broker 状态** → 后续 `await_stop_hook` 误消费上一代 hook 事件。与 R81(同 broker 的 start() await 后未复查)同源,但在 ingest 路径。
- **修复**: 加 `ingestGen`,stop() 时 `+1`(invalidate 所有在途 ingest)。ingestFile 入口 `const myGen = ingestGen`;`await stat` 与 `await readFile` 之后各 `if (stopped || myGen !== ingestGen) return`(过期则不写任何共享状态)。restart 场景:start 不重置 ingestGen(只 stop bump),旧 ingest 的 myGen < 当前 → bail。
- **测试**: 新增 hook-broker-ingest-stop-race.spec(R90):mock node:fs/promises 使 `stat` deferred → start 经 readdir 驱动 ingestFile 挂在 stat → `broker.stop()` → resolve stat → 断言 `readFile` **未被调用**(bail 在 readFile 前)。中和(删 stat 后复查)→ readFile 被调 1 次确认回归。**测试坑**:ingestFile 内部不可直接调,经 start() 的 readdir 循环驱动,需同时 mock node:fs(watch)+ node:fs/promises(mkdir/readdir/stat/readFile/unlink),用 deferred stat 暂停 await。
- **沉淀**: 同一组件多个异步路径(start R81 / ingest R90)都须 per-lifecycle generation 守卫 —— 补齐一处不够,凡「await 后写共享状态」的方法都要复查代际。stop/teardown 必须 bump generation 使所有在途异步失效(不只设 stopped 布尔,因 restart 会重置布尔但 generation 单调)。迟到回调族(R79/R81/R84/R85/R90)在 main 服务维度的又一例。R1-R23/R25-R33/R35-R90 共 88 修 + R24/R34 DEFER。

## R91 — revokeAndKillAgentSessions 不结算 pending 授权请求,撤销后迟到 respond 仍放行 (P1,安全)

- **文件**: `electron/main/services/agent-auth.service.ts:165` revokeAndKillAgentSessions()
- **问题**: 撤销时 rotate token + forceKill agent session,但**不结算 pending 授权请求**(pending Map)。撤销前卡在授权等待中的请求,若随后收到 renderer **迟到的** `respond('session')`,`resolveAgentAuthRequest()` 仍按旧 requestId 命中 pending → settle('session') 放行 → 撤销后那次 MCP tool call 仍执行一次。违反「用户点撤销/终止 agent 即时生效」的安全边界(rotate token 只挡新调用,挡不住已在授权门口等待的那一个)。
- **修复**: revokeAndKillAgentSessions 开头同步把所有 pending 结算为 'denied' 并清空(`entry.settle('denied')` 含 clearTimeout)。清空后迟到 respond 在 resolveAgentAuthRequest 找不到 pending 条目 → no-op,无法复活已撤销的授权。
- **测试**: agent-auth-service.spec +1(R91):requestAgentAuth(in-flight)→ revokeAndKillAgentSessions → 断言该请求 resolve 'denied';再 resolveAgentAuthRequest(oldId,'session') → 不抛 + 请求仍是 'denied'(未被迟到 session 覆盖)。中和(移除 pending 结算)→ 撤销不 deny 确认回归。
- **沉淀**: **撤销/吊销安全动作必须同时终结「正在等待授权决定」的 in-flight 请求**,不能只 rotate 凭据(凭据轮换挡新请求,挡不住已发出、等待 respond 的旧请求 —— 它持旧 requestId,迟到 respond 仍匹配放行)。与 R75/R76(token 撤销传播到长连接)、R88/R89(超时传播)同主题:状态变更(撤销)必须覆盖所有「半途挂起」的等待者。安全相关竞态:in-flight 授权请求是撤销的盲区,必须显式 deny。R1-R23/R25-R33/R35-R91 共 89 修 + R24/R34 DEFER。

## R92 — revoke 并发时先发迟到失败用旧快照回滚,覆盖后发成功撤销 (P1)

- **文件**: `src/shell/StatusBar.tsx:52` handleRevokeAgentTerminals()
- **问题**: revoke 无 in-flight 闸门/代际。流程:capture `wasGranted`(调用开始快照)→ revoke()(sessionGranted=false)→ await revoke IPC → 失败则 `if (wasGranted) setState({sessionGranted: true})` 回滚。两次 revoke 并发(快速点两次/程序触发)时:A 捕获 wasGranted=true,B 后发成功撤销;若 **A 的 IPC 在 B 成功之后才迟到失败**,A 的 catch 用其旧 wasGranted=true 把 sessionGranted 翻回 true → renderer 误以为本轮仍已授权,后续 agent auth 被**无提示放行**,与 main 已撤销/旋转 token 的真实态不符(安全相关)。
- **修复**: 模块级 `revokeGen` latest-guard。每次 revoke `const myGen = ++revokeGen`;catch 开头 `if (myGen !== revokeGen) return`(更晚的 revoke 已把状态正确置为 revoked,先发的迟到失败不得回滚/报错)。
- **测试**: status-bar.spec +1(R92):revoke mock 第一次 deferred(将失败)、第二次 ok;点两次按钮(A 在途、B 成功)→ 迟到 rejectFirst() → 断言 sessionGranted 保持 false(A 未覆盖 B)。中和(去 myGen 守卫)→ A 回滚成 true 确认回归。
- **沉淀**: **「乐观改状态 → await → 失败回滚到调用前快照」的操作,并发时必须 latest-guard**:迟到失败者持的是过期快照,回滚会覆盖更晚操作的正确结果。与 R27/R28(createLatestGuard)、R43(commit token)同族。本例叠加安全维度:错误回滚把「已撤销」翻回「已授权」。凡「capture 旧值 → 异步 → 失败 restore 旧值」都要确认 restore 时自己仍是最新轮次。R1-R23/R25-R33/R35-R92 共 90 修 + R24/R34 DEFER。

## R93 — shell-stream AsyncIterator 单 resolver 被并发 next() 覆盖致先发永挂 (P2)

- **文件**: `electron/preload/plugin-shell-stream.preload.ts:116` chunks AsyncIterator
- **问题**: chunks 的自定义 AsyncIterator 用**单个** `chunkResolver` 暂存等待者。当队列空时连续两次 `next()`(插件/封装库预取或并发读 stream),第二次 `chunkResolver = resolve` **覆盖**第一次 → 先发 next() 的 Promise 永久不 resolve(消费方挂死);后续 chunk/exit 也只能唤醒最后一个等待者。
- **修复**: `chunkResolver`(单)→ `chunkResolvers` **FIFO 队列**。next() 队列空时 push 等待者(不覆盖);chunk 到达 `shift()` 唤醒队首;exit / synthesizeExit / return() 用 `resolveAllChunksDone()` 把所有 pending 等待者 resolve 为 done。不变量:chunkQueue 与 chunkResolvers 不同时非空(next 先查 queue 命中即返)。
- **测试**: 新增 shell-stream-concurrent-next.spec(R93):捕获 handler + 从 invokeCalls 取 streamId;并发两 next() → 两 chunk 按 FIFO 各自 resolve([97]/[98]);exit 唤醒所有 pending 为 done。中和(模拟单 resolver 覆盖)→ 先发 next 永挂 5s 超时确认回归。
- **沉淀**: **自定义 AsyncIterator/Promise-bridge 的等待者必须用队列,不能用单槽** —— 单槽假设「同一时刻只有一个 next() 在等」,但 async 消费方完全可以并发拉(预取、Promise.all、封装库),后者覆盖前者 = 先发永挂 + 唤醒错位。与 R40(协议 URL 单槽→FIFO)、R39 同主题:任何「单槽暂存待消费项/等待者」遇并发都要升级 FIFO。R1-R23/R25-R33/R35-R93 共 91 修 + R24/R34 DEFER。

## R94 — scoped-app execStream 权限等待期间取消后仍 spawn 子进程 (P2)

- **文件**: `src/plugins/scoped-app.ts:216` execStream()
- **问题**: execStream **急切** start()(`const done = start()`);start() 先 `await ensurePerm(shell)`(缺权限时挂在权限弹窗)再 `coApi.pluginShellStreamRaw.execStream()` spawn。chunks 的 `return()`(消费者提前 break/return)只 `await iterator?.return?.()` —— 但权限等待期间内层 iterator 尚为 null,return() 跳过 abort。于是权限 resolve 后 start() 仍执行 execStreamRaw **真的 spawn 子进程**:已取消消费的命令迟到执行,无人读 chunks,子进程挂到 timeout(最长 30min)= 资源泄漏 + 意外命令执行。
- **修复**: 加 execStream 作用域 `cancelled` 标志。return() 置 `cancelled = true`;start() 在 `await ensurePerm` 之后、真正 execStreamRaw 之前复查 `if (cancelled) return cancelledStream`(立即终止的合成 stream:chunks 立刻 done、done 收敛 {exitCode:null}),不 spawn。
- **测试**: scoped-app-shell-stream-early-break.spec +1(R94):自定义 store 的 get() 返回可控 pending(模拟权限弹窗)→ execStream 急切 start 卡在 store.get → chunks.return() 取消 → resolve store.get(grant shell)→ 断言 coApi.pluginShellStreamRaw.execStream 未被调用 + done 收敛。中和(去 cancelled 复查)→ 取消后仍 spawn 确认回归。
- **沉淀**: **「权限/前置 await 之后才真正执行副作用」的操作,前置 await 期间的取消必须在副作用执行前复查** —— 取消发生在 await 中(此时副作用尚未启动、清理钩子无对象可清),不复查则 await 完成后照常执行已取消的副作用。与 R79/R85(effect 异步取消)、R71/R72(投递前复查)同族:async 操作每个 await 后、每个副作用前都要复查取消/代际。本例副作用是 spawn 子进程(资源 + 安全)。R1-R23/R25-R33/R35-R94 共 92 修 + R24/R34 DEFER。

## R95 — 并发同名 register await 同一 unregister 后双 set,失败者回滚删成功者 entry (P1,R74/R86 后续)

- **文件**: `src/plugins/registries/PluginMcpRegistry.ts:90` register()
- **问题**: register() 只在 `await pendingUnregister`(R74)**之前**检查一次 `entries.has(name)`。两个并发同名 register 都过了首次 has() 检查(此刻谁都没 entries.set),然后都 `await` 同一个 pending unregister;await 后**同时继续**:二者都 entries.set + 并发 upstream.register。失败者的 catch `entries.delete(name)`(R86 回滚)会删掉**成功者**刚写入的本地 entry → 外部 tools/call 得 NO_SUCH_TOOL(本地表被误删)。注:无 pendingUnregister 时不发生(register 同步跑到 upstream.register,首次 has 已挡住第二个);仅「都 await 同一 unregister」才暴露。
- **修复**: `await pendingUnreg` 之后**重新检查** `entries.has(name)`,占用则抛 TOOL_NAME_TAKEN。先恢复者 set entry(其后到 upstream.register 间无 await,同步占位),后恢复者复查命中 → 抛,不进入 set/upstream → 无双 set、无 cross-delete,只一个注册。
- **测试**: registry.spec +1(R95):deferred unregister 使 dispose 后两个并发同名 register 都 await 同一 pending → resolve → 断言恰好一个 'ok' 一个 TOOL_NAME_TAKEN + 成功者 invokeLocal 仍可用(未被回滚删)。中和(去 await 后复查)→ 双 set/互踩确认回归。
- **沉淀**: **TOCTOU 经典:在 await 之前做的唯一性检查,await 之后必须复查** —— await 期间(此处等同一 unregister)多个调用者可同时通过旧检查,恢复后并发写同一资源。R74(unregister→register 串行)+ R86(local-first + rollback)叠加引入的并发窗口,需 R95 的 await-后-recheck 收口。「check → await → act」三段式,act 前必重新 check(与 R75/R81/R90 generation 复查同族,本例是 has-key 唯一性复查)。同一文件 R74/R86/R95 三连修才补全 register/unregister 生命周期的全部竞态窗口。R1-R23/R25-R33/R35-R95 共 93 修 + R24/R34 DEFER。

## R96 — terminal resize 在 IPC 确认前更新 lastSize 且忽略失败,同尺寸不重试致 DOM/PTY 长期不一致 (P2)

- **文件**: renderer `src/panels/Terminal/useTerminal.ts:145` fitAndResize + main `electron/main/services/terminal.service.ts:467` resize + `electron/main/ipc/terminal.ipc.ts` resizeHandler
- **问题**: 两层:(renderer)fitAndResize 在 `coApi.terminal.resize` **成功前**就 `lastSize.current = {cols,rows}` 且 `void` 忽略结果;(main)service.resize `serializePerKey` fire-and-forget 恒返 true,PTY resize 失败只 warnOnce、不传播。合起来:前端认为该 cols/rows 已同步,即便 PTY resize 实际失败,后续相同 cols/rows 因 lastSize 去重**不再重试** → xterm DOM 与 PTY 尺寸**长期不一致**(TUI 换行/光标错乱),直到下次不同尺寸 resize。
- **修复**(镜像 R12 interrupt 的 fire-and-forget→await-propagate):(1)main service.resize 改 async,在 R17 串行链中等本次 resize 真实结果返回 true/false(链尾仍 void 吞错保串行);(2)resizeHandler 改 async,await + 失败 throw → IPC 返回 ok:false;(3)renderer fitAndResize 乐观置 lastSize(阻在途重复)但 `.then` 失败(ok:false/reject)时回滚到 prev(latest-guard:仅当仍是本次 target),使同尺寸可重试。
- **测试**: resize-gating.spec +1(R96 renderer:resize ok:false → lastSize 回滚 → 同网格重试再发)+ multi-window-routing.spec +1(R96 main:SessionManager.resize reject → service.resize resolves false / 成功 true / 不存在 false)+ 更新 isolation/resize-gating mock 为 async。中和(renderer 去回滚 / main 去传播)分别确认回归。
- **沉淀**: **「乐观更新去重键 → 异步确认」必须在确认失败时回滚去重键,否则失败的乐观值永久抑制重试**(与 R92 失败回滚、R87 单飞同族)。且 fire-and-forget 的写操作若其失败会导致前后端状态分歧,必须把真实结果传播到调用方(R12 interrupt / R4 同款)—— 「恒成功」的 IPC 让 renderer 无法感知真失败。resize 是 R12/R4 之后此文件第三个 fire-and-forget→propagate 转换。R1-R23/R25-R33/R35-R96 共 94 修 + R24/R34 DEFER。

## R97 — useExternalFileSync 在途读只按 tabId 回写,close+reopen 同路径致迟到读覆盖新 tab (P1,R79 后续)

- **文件**: `src/panels/Editor/useExternalFileSync.ts:57` settle
- **问题**: 外部文件同步的在途 readFile 只用 tabId 回写(reloadFromDisk),未校验读发起时的 tab **实例**是否仍在。`tab.id === filePath`(createTab 不变量):clean tab 触发外部变更读取后,用户**关闭该 tab 并重新打开同一路径**会得到**同 id 的新 tab 对象**;旧读迟到 resolve 时命中新 tab 的同 id → reloadFromDisk → 新打开的 tab(可能已是更新内容)被旧磁盘快照覆盖,用户随后编辑/保存把较新内容回退。R79 的 cancelled 只防 effect 卸载(deps=[]),不覆盖同一 effect 内 tab 的 close/reopen。
- **修复**: readAndApply 发起读取时捕获当前 tab 对象引用 tabRef;settle 落地前重取 live tab(by id),仅当 `live === tabRef`(同一实例)才 reloadFromDisk,否则丢弃。store 更新用 `slice()`+只替换变更项(updateContent/reloadFromDisk/switchTab 都如此),未变 tab 保留对象 identity → close+reopen(createTab 新对象)/被更新的 reload 替换/变 dirty 都会让 live !== tabRef,精确区分。
- **测试**: external-file-sync-out-of-order.spec +1(R97):deferred readFile 在途 → 把 storeMock.tabs 换成同 id 的新对象(模拟 close+reopen)→ resolve 旧读 → 断言 reloadFromDisk 未调用(新 tab 不被覆盖)。中和(去 identity 复查)→ 覆盖确认回归。
- **沉淀**: **按「稳定业务 key」(此处 tab.id===path)回写异步结果时,key 可能在 await 期间被同 key 的新实例复用 → 必须额外捕获并复查「实例 identity」(对象引用 / epoch / 实例 token)**。R79(effect 取消)+ R97(实例复用)合起来覆盖 useExternalFileSync 在途读的两类迟到危害:跨 effect(卸载)与同 effect 内(同 path 重开)。与 R84(per-init teardownDone)、R90(ingestGen)同族:稳定 id 不足以判「还是不是同一个」,需实例级令牌。R1-R23/R25-R33/R35-R97 共 95 修 + R24/R34 DEFER。

## R98 — plugin-mcp invoke bridge unsubscribe 后在途 invokeLocal 仍 replyInvoke (P2)

- **文件**: `src/plugins/plugin-mcp-invoke-bridge.ts:31` startPluginMcpInvokeBridge
- **问题**: 返回的 unsub 只调 `api.onInvoke` 的 unsub(停后续 INVOKE 投递),但已进入的 `registry.invokeLocal(...)` 是异步的;其 `.then/.catch` 在 bridge 卸载/HMR/重启/owner 清理之后仍**无条件** `api.replyInvoke(...)` → 过期结果回写 main:完成已被取消的 pending 调用,或旧 registry 的结果晚到污染新生命周期的同 requestId。
- **修复**: 加 `active` 标志。返回的 unsub 置 `active = false` 后再调原 unsub;`.then/.catch` 回写前 `if (!active) return`,过期结果直接丢弃。
- **测试**: invoke-bridge.spec +1(R98):deferred invokeLocal 在途 → unsub() → resolve 迟到结果 → 断言 `api.replies` 为空(不回写)。中和(去 active 复查)→ 回写确认回归。
- **沉淀**: 迟到回调族(R79/R81/R84/R85/R90/R94/R97/本处)在 renderer↔main 反向调用桥维度。**「订阅 + 异步处理 + 回写」的 bridge,其 unsubscribe 必须同时失效在途处理的回写**(只退订事件源不够 —— 已进入处理的 in-flight 仍会完成并回写)。统一解=active/generation 守卫,回写前复查。与 R85(drag-drop async)、R97(实例复用)同形:effect/bridge teardown 必须门控所有在途异步的副作用回写。R1-R23/R25-R33/R35-R98 共 96 修 + R24/R34 DEFER。

## R99 — plugin-fs scope-request bridge unsubscribe 后在途 requestFsScope 仍 _scopeDecision (P2)

- **文件**: `src/plugins/permissions/usePluginFsScopeRequests.ts:28` startPluginFsScopeRequestBridge
- **问题**: 与 R98 同型(fs-scope 授权桥)。返回的 unsub 只调 `coApi.pluginFsRaw.onScopeRequest` 的 unsub(停后续 scope 请求投递),但已进入的 `usePermissionPromptStore.requestFsScope(...)` 是异步的(等用户在弹窗点授权/拒绝);其 `.then` 在 bridge 卸载/HMR/重启后仍**无条件** `coApi.pluginFsRaw._scopeDecision(...)` → 旧生命周期的授权/拒绝晚到 main:完成已取消/已过期的 scope pending,或在新 bridge 已启动后产生过期授权回写(同 requestId 串扰)。`.catch` 的 notify.error 同理会弹过期 toast。
- **修复**: 加 `active` 标志。返回的 unsub 置 `active = false` 后再调原 unsub;`.then`(回传决定前)与 `.catch`(弹 toast 前)各 `if (!active) return`,过期结果直接丢弃。注意 `.then` 块须 `return coApi.pluginFsRaw._scopeDecision(...)`(R98 是表达式箭头自带 return,本处改成块体后必须显式 return),否则 _scopeDecision 的 reject 不再沿链传到 .catch → A126 失败反馈回归。
- **测试**: scope-decision-feedback.spec +2(R99):deferred requestFsScope 在途 → unsub() → resolve 迟到决定 / reject 迟到失败 → 断言 `_scopeDecision`、`notify.error` 均未调用。中和(unsub 不置 active=false)→ 两测试均失败确认回归。原有 A126 三测试(含 _scopeDecision reject → notify.error)保持绿,验证 return 链未断。
- **沉淀**: 迟到回调族「订阅 + 异步处理 + 回写,unsub 必失效在途回写」第二处反向桥实例(R98 是 plugin-mcp invoke,本处是 plugin-fs scope)。**同族修复改 then 表达式箭头为块体时,务必保留 return 以维持 promise 链**(否则下游 catch 接不到上游 reject,静默回归既有反馈逻辑)。R1-R23/R25-R33/R35-R99 共 97 修 + R24/R34 DEFER。

## R100 — serialize-per-key chains Map 链排空不删 key 单调增长内存泄漏 (P2)

- **文件**: `src/lib/serialize-per-key.ts:18` runSerialPerKey(renderer)+ `electron/main/services/serialize-per-key.ts:21` serializePerKey(main)
- **问题**: 两个串行锁工具把每个 key 的 settled tail promise 永久留在 chains Map,链排空(该 key 无在途/排队任务)后从不删除。`chains.set(key, settled)` 后无回收 → Map 随**用过的** key 单调增长:editor saveChains 按 tabId(长会话打开/保存大量文件)、PluginDataStore writeChains 按 pluginId(大量插件数据 key)。已完成的串行锁条目无法回收 = 并发控制 Map 的内存泄漏。同型工具 `atomic-write.ts` 的 withPathLock **已有**该清理(L46-49),这两个提炼版漏了。
- **修复**: 照 withPathLock:`chains.set(key, settled)` 后 `void settled.then(() => { if (chains.get(key) === settled) chains.delete(key); })`。链排空且仍是尾部才删;新任务在 cleanup 微任务前入队会把 chains.get(key) 换成新尾 → !==settled → 不删,锁链保持完整保序。renderer 版需先把内联的 `result.then(...)` 尾抽成具名 `settled` 常量才能在比较与 set 里复用同一引用。
- **测试**: 新增 serialize-per-key-cleanup/runserialperkey-cleanup.spec(renderer 4 例)+ serialize-per-key.test +3(main):成功/失败排空后 `chains.has(key)===false`、cleanup 前新任务入队不误删且保序、多 key 各自回收。中和(去 cleanup)→ 7 测试全失败确认回归。
- **沉淀**: 第三个并发控制 Map 的「单调增长」缺口(前有 watcher 池有界化等)。**凡按动态 key(path/tabId/pluginId/requestId)建 promise 链/锁/pending 的 Map,排空后必须删 key**,否则长会话内存泄漏;统一解=「settled 后复查仍是尾部再 delete」(同 atomic-write withPathLock)。这是泄漏类(非严格 race),但与 race 同源于「异步链生命周期管理」——提炼通用工具时易漏掉原始实现里已有的清理分支(withPathLock 有、两个提炼版无)→ **提炼 helper 必比对原实现是否完整搬运所有边界处理**。R1-R23/R25-R33/R35-R100 共 98 修 + R24/R34 DEFER。

## R101 — 三处 inline 串行锁副本漏排空回收(installLocks/lifecycleLocks/IpcPermissionStore.chains)单调增长内存泄漏 (P2,R100 同族 + 家族清扫)

- **文件**: `electron/main/services/plugins.service.ts:485` withInstallLock + `src/plugins/PluginManager.ts:126` withLifecycleLock + `src/plugins/permissions/IpcPermissionStore.ts:126` runExclusive(codex 报 installLocks 一处,按「修一族必 grep 所有兄弟」清扫出另两处同型)
- **问题**: 三者都是 `withPathLock`(atomic-write.ts)「同 key 串行 + 返回结果 + 链尾吞错」的 inline 副本,但都**漏抄**了 withPathLock 的排空回收分支(L46-49)→ chains/installLocks/lifecycleLocks Map 随用过的 key(插件 id / pluginId)单调增长:反复安装/更新/失败尝试不同插件、对不同插件做 enable/disable/reload/uninstall、变更不同插件权限,都让已完成的串行锁条目永不回收 = 并发控制 Map 内存泄漏。root cause 与 R100 同:提炼/复制 lock 时漏掉原始实现已有的清理。
- **修复**: **收口到共享 helper 消除漂移**。给 main `serialize-per-key.ts` 加返回结果版 `runSerialPerKey`(镜像 renderer 版,含 R100 清理);三处 lock 全改为一行委托:withInstallLock→`runSerialPerKey(installLocks,...)`、withLifecycleLock→`runSerialPerKey(this.lifecycleLocks,...)`、runExclusive→`runSerialPerKey(this.chains,...)`(chains 类型 `Promise<void>`→`Promise<unknown>` 适配)。三者语义逐字一致(`prev.then(fn,fn)`+尾吞错+返回 result),委托行为保持。
- **测试**: main serialize-per-key.test +5(runSerialPerKey 结果/保序/吞错/排空回收/失败排空)+ ipc-permission-store.spec +1(grant 两 pluginId 后 chains.size===0)+ plugin-manager.spec +1(enable 两 id 后 lifecycleLocks.size===0)。中和(去共享 helper 清理)→ 8 测试横跨三处委托全失败确认回归;既有 R15/生命周期/安装行为测试保持绿,验证委托未改语义。
- **沉淀**: R100 的家族扩展。**lock/锁链/pending 的实现一旦有多份副本(withPathLock 1 + 3 inline),清理分支极易只在部分副本里有 → 修复不是逐份补,而是收口到单一共享 helper 让漂移不可能再生**。codex 报一处时主动 grep `new Map<string, Promise` 全仓清扫同族(本次找到 11 个 Map,3 个真漏、resizeChains 按 live session 有界非泄漏、其余已删),一轮修净整族而非等 codex 逐个报。R1-R23/R25-R33/R35-R101 共 101 修(R101 含 3 处)+ R24/R34 DEFER。

## R102 — 权限编辑弹窗持有已卸载插件的 stale target 仍可写 ghost 权限 (P1,R50 同族)

- **文件**: `src/plugins/settings/PluginsTabContent.tsx:560` setPermEditTarget(p) + `src/plugins/permissions/PermissionEditorModal.tsx:88` save
- **问题**: 「权限」按钮把 `permEditTarget` 固定为点击瞬间的 `PluginListItem`。PluginsTabContent 每 1s 轮询 `mgr.listAll()` 刷新 `plugins`,但弹窗打开期间该插件被**另一窗口/操作卸载**后,permEditTarget 仍是旧 item,弹窗保持打开且 Save 仍调 `store.grant/deny(pluginId)` → 把已卸载插件的 ghost 权限写回 `_permissions.json`;同 id 日后重装会意外继承非用户当前意图的授权。与 R50(快捷键编辑弹窗持有已移除 command 仍写 override)同型。
- **修复**: 两层守卫,镜像 R50。(1)父层 effect:`plugins` 变化时若 `permEditTarget.id` 不在 live 列表 → `setPermEditTarget(null)` 自动关弹窗(覆盖 1s 轮询)。(2)modal 加 `pluginStillExists?: () => boolean` prop,`save()` 写盘前复检,缺失则 `onClose()` 中止写入(覆盖父 effect 关闭前的同帧 Save 点击);父层传 `() => plugins.some(p => p.id === permEditTarget?.id)`。prop 可选 → 无插件列表上下文的调用方(测试/独立用途)不复检。
- **测试**: permission-editor-modal.spec +2(pluginStillExists()=false→中止写盘仅 onClose / =true→正常 grant)+ plugins-tab-content.spec +1(fake timers:开弹窗→listAll 去掉该插件→advance 1s→弹窗 DOM 消失)。中和(分别去 effect 体 / 去 save 复检)→ 对应测试各失败确认两层独立回归。
- **沉淀**: 「编辑弹窗持有打开瞬间捕获的实体引用,实体在打开期间从权威列表消失(被卸载/移除/reload)→ stale 写入」族第二处(R50 命令、R102 插件权限)。统一解=**父层 effect 监听权威列表关弹窗 + 写操作瞬间再复检**(双层防同帧点击)。凡「轮询/订阅刷新的列表 + 弹窗捕获其中一项做写操作」都须查这对守卫。R1-R23/R25-R33/R35-R102 共 102 修(R101 含 3 处)+ R24/R34 DEFER。

## R103 — 卸载确认弹窗持有 stale uninstallTarget,插件被换实例后迟到确认删错插件 (P2,R102 同族/兄弟入口)

- **文件**: `src/plugins/settings/PluginsTabContent.tsx:266` onConfirmUninstall(及 uninstallTarget 弹窗)
- **问题**: 与 R102 同一组件的**兄弟入口**(我修 R102 时漏掉)。「卸载」按钮把 `uninstallTarget` 固定为点击瞬间快照,无 live 复检。弹窗打开期间该插件被另一窗口/操作卸载(轮询刷新后从 plugins 消失),或**卸载+重装同 id**(version 变=不同实例),迟到的确认仍 `mgr.uninstall(target.id)` → 删掉用户从未确认的当前新实例。
- **修复**: 父层 effect(镜像 R102):`plugins` 变化时若无「同 id + 同 manifest.version」的 live 条目 → `setUninstallTarget(null)` 自动关弹窗。用 id+version 作同一实例校验(PluginListItem 无稳定实例 token,重装通常改 version)。**不加 R102 那样的 onConfirm 二次复检**:经分析 React passive effect 在 commit 后 paint 前 flush,plugins 一变 effect 即先关弹窗,用户无从在「plugins 已变而弹窗仍开」画面上点确认,故 effect 单层已充分(与 R102 不同——那里 save 在独立子 modal,其交互可能已在途,需 save-start 复检)。
- **测试**: plugins-tab-content.spec +2(fake timers:开卸载弹窗→listAll 去掉该插件 / 改成不同 version→advance 1s→弹窗 DOM 消失)。中和(去 effect 体)→ 两测试均失败确认回归。
- **沉淀**: **修「弹窗持有 stale 实体」族(R50/R102)时必 grep 同组件所有同型弹窗入口**——本组件 permEditTarget 与 uninstallTarget 是孪生,R102 只修一个=漏兄弟(第 N 次「防御建了未传播到所有兄弟入口」族复发,这次是我自己 R102 引入的连带缺口被 codex 逮到)。同时:**防御层数要按组件结构定**——同组件自有 handler racing 自身 effect 时,passive-effect-before-paint 保证 effect 单层足够;跨组件(父 effect + 子交互在途)才需子组件再加写操作起点复检。R1-R23/R25-R33/R35-R103 共 103 修(R101 含 3 处)+ R24/R34 DEFER。

## R104 — NotificationsProvider dismiss() 不同步更新 ref,同 tick 后续同源 notify 被 dedupe 吞掉 (P2,R13 对偶)

- **文件**: `src/notifications/NotificationsProvider.tsx:92` dismiss
- **问题**: R13 已让 notify() 同步把新通知写入 `notificationsRef.current`(使同 tick 后续 notify 的 dedupe 能看到 pending 通知)。但 dismiss() 漏了对偶:它只在 `setNotificationList` 的 updater(延迟到 render)里更新 ref。同一 tick 内「dismiss(id) 后紧接同源 non-error notify」时,notify 的 dedupe 循环从**旧 ref** 仍看到那条已关闭通知(在 DEDUPE_WINDOW 内)→ 走 dedupe 分支:它的 `map(n => n.id===existing.id ? ...)` updater 在 dismiss 的 `filter` updater 之后执行,existing.id 已不在 prev → no-op,新通知既不新增也不复活 = **被静默吞掉**;且 `scheduleDismiss(existing.id)` 给已删 id 重挂 auto-dismiss timer。典型触发:一个 handler 关掉旧成功 toast 后立刻再弹同类成功提示。
- **修复**: dismiss() 里同步 `notificationsRef.current = notificationsRef.current.filter(n => n.id !== id)`,再提交 state。与 R13 notify 侧同步写 ref 对称,确保同 tick 后续 notify 读到 live ref。functional updater 仍是权威(落 ref),同步值仅为同 tick 先行可见。
- **测试**: notifications-provider.spec +1(R104):notify 成功 → 取 id → 同一 act 内 dismiss(id)+ 同源 notify → 断言新通知存在、count=1、id 与首条不同(未被吞)。中和(去同步 filter)→ 测试失败确认回归。
- **沉淀**: 「同步影子 ref + 异步 React state」模式必须**所有改变集合的入口都同步维护影子 ref**——R13 只补了 notify(增)侧,dismiss(删)侧成对偶缺口(又一个「防御未传播到所有兄弟入口」族,这次是 add/remove 一对)。凡为「同 tick 可见性」引入 ref 镜像 state 的,grep 所有 mutate state 的地方同步更新 ref。注:auto-dismiss timer 的 filter 不需同步 ref(自成 task,后续无同 tick notify)。R1-R23/R25-R33/R35-R104 共 104 修(R101 含 3 处)+ R24/R34 DEFER。

## R105 — DockReconciler originHint 兜底让迟到的较旧 user terminal 抢焦点 (P2)

- **文件**: `src/shell/dock/DockReconciler.ts:98` shouldFocus
- **问题**: `originHint === 'user' && isFirstAppearance` 让**每个**首次出现的 user terminal 都抢焦点(setActive)。两个 terminal.create 并发且 session push 乱序时,较新的 user-2 先到并聚焦后,较早请求的较旧 user-1 迟到(仍是首次出现)→ 它也走 originHint 兜底 setActive,**覆盖**已聚焦的较新终端 → 用户连续新建终端时焦点落到较旧终端,键盘输入进入非预期 PTY。
- **修复**: 兜底加「该 session 是当前快照(nextSessions)中**最新** user session」约束:`session.createdAt === max(user session createdAt)`。迟到的较旧 user session 不再抢焦点;较新的 user session 后到仍正常聚焦(last-create-wins)。显式 `pendingFocus` 路径(Cmd+T/+ 按钮的明确意图)经 `consumePendingFocus` 短路,不受此约束,始终命中。自洽实现,无需请求 token 跨进程回传。
- **测试**: addpanel-position.spec +2(R105):较新 user-2 先到聚焦→较旧 user-1 乱序后到不抢焦点(焦点经 restore 机制保持在 user-2)/ 较旧 user-1 先到→较新 user-2 后到正常聚焦。中和(去 isLatestUserSession 约束)→ 第一个测试失败确认回归。
- **沉淀**: 「时序无关兜底(originHint)」与「时序敏感乱序到达」冲突——兜底为修 IPC-vs-RPC 时序(R25)引入,但对**并发同类创建**又过宽(任一首次出现都聚焦)。修法=给兜底加「快照内最新」单调判据,用 createdAt 当请求顺序的代理(比跨进程 token 轻、自洽)。凡「首次出现即执行副作用」的兜底,遇并发多实例须再加「是否当前最新/最相关」收窄,否则迟到的旧实例抢占。R1-R23/R25-R33/R35-R105 共 105 修(R101 含 3 处)+ R24/R34 DEFER。

## R106 — 打开目录选择器仅靠异步 React busy 防重入,同 tick 并发弹多对话框 + 先选目录被作废 (P2,R8 单飞族)

- **文件**: `src/panels/Explorer/EmptyWorkspace.tsx:20` open + `src/panels/Explorer/ExplorerHeader.tsx:98` switchFolder + `src/core-plugins/WindowPlugin.ts:36` window.openFolderInNew(codex 报 EmptyWorkspace 一处,按「修一族必收口所有兄弟」三处一起)
- **问题**: 三处都用 React busy state(或无任何闸门,WindowPlugin)防重入。`setBusy(true)` 是异步的:同一 tick 双击/Enter 或程序性重复触发会在按钮 disabled 渲染落地前各自发起一次 `coApi.fs.selectDirectory()` → 弹出多个原生目录对话框;且 `workspaceRootSelectionGuard.begin()` 的 latest-wins 会让较早那次的有效选择被后发的作废(用户先选的目录被丢弃)。跨入口亦然(EmptyWorkspace 在途时触发 ExplorerHeader 切换 → 两个原生选择器)。
- **修复**: 新增共享同步单飞闸门 `src/lib/select-directory-single-flight.ts`(模块级布尔 + trySelectDirectoryLock/releaseSelectDirectoryLock)。三处发起前 `if (!trySelectDirectoryLock()) return`,finally 释放。同步置位确保同 tick 后续调用(含跨入口)立即被挡,全 app 同时只一个目录选择器。与 workspaceRootSelectionGuard 正交:闸门防「并发发起」,guard 防「过期结果落地」。React busy state 保留作 UI(aria-busy/disabled)。
- **测试**: 新增 select-directory-single-flight.spec(helper 单元:取锁/释放/同 tick N 次只 1 成功)+ empty-workspace.spec +1(锁被他处持有时点「打开文件夹」不发起 selectDirectory)。中和(去 EmptyWorkspace 闸门接入)→ 整合测试失败确认接入。注:fireEvent 每次 flush React,无法复现同 tick 双击的真并发,故整合测试改用「外部预持锁」验证组件接入闸门(等价覆盖跨入口/同 tick 并发被挡)。
- **沉淀**: 「React state 防重入」对**同 tick / 跨入口**并发无效(state 异步,fireEvent 之外的真并发在 disabled 渲染前就发起了)——凡触发**外部副作用且不可并发**(原生对话框、单例资源获取)的入口,必须**同步**单飞闸门(R8 族)。多入口共享同一外部资源(此处=原生目录选择器)→ 闸门要全 app 单例共享,不能各组件各自 busy。R1-R23/R25-R33/R35-R106 共 106 修(R101 含 3 处、R106 含 3 处)+ R24/R34 DEFER。

## R107 — uninstallPlugin 不走 per-id 锁,卸载与同 id 安装/更新跨进程交错删错版本 (P2,R101 同源)

- **文件**: `electron/main/services/plugins.service.ts:500` uninstallPlugin(+ withInstallLock 改名 withPluginMutationLock)
- **问题**: installFromGit 的 swap 走 `withInstallLock(id)` 串行化同 id 安装/更新,但 uninstallPlugin 的 fs 段(access → 元数据清理 → rm)**不走任何锁**。一个窗口卸载、另一窗口安装/更新同插件时两段交错:卸载最后的 `rm(targetDir)` 可能删掉安装刚 rename 就位的**新版本目录**,或清掉新安装应保留的元数据 →「安装成功但插件消失/状态不一致」。(此项早在 49-polish-bugfixes README L578/635 被记为 latent DEFER,本轮 codex 复审捞出,正式修。)
- **修复**: 把 withInstallLock 改名 `withPluginMutationLock`(install/update/uninstall 共用,语义更准),uninstallPlugin 的整个 fs 段包进 `withPluginMutationLock(id, async () => {...})`,与 installFromGit 的 swap 互斥串行(同 id)。id 合法性校验廉价无副作用,留在锁外快速失败。锁底层仍是 R101 收口的 runSerialPerKey(排空回收,不泄漏)。
- **测试**: plugins-enabled-mutate.test +1(R107):真实 temp dir 建插件目录 → 并发两次 uninstallPlugin 同 id → 恰一次 fulfilled(真卸载)、另一次 NOT_INSTALLED(串行后见目录已删)。中和(withPluginMutationLock 直接 fn() 不串行)→ 两次都 access 通过都 fulfill → notInstalled=0 测试失败确认回归。
- **沉淀**: 跨进程「同资源的所有 mutation 入口必须共用同一把 per-key 锁」——install/update 早有锁,uninstall 是漏网的第三类 mutation(又一「防御未传播到所有兄弟入口」族,且早被自审记为 latent DEFER)。锁命名应按**保护的资源**(plugin 目录)而非单一操作(install)命名,否则后加的 mutation(uninstall)直觉上「不是 install」就漏接。换审计者(codex)把 DEFER 的 latent 项重新提级为实修=换审计者价值再现。R1-R23/R25-R33/R35-R107 共 107 修(R101 含 3、R106 含 3)+ R24/R34 DEFER。

## R108 — HookFileBroker.start() 初始扫描期间被 stop() 打断仍创建 cleanupTimer 泄漏 interval (P1,R81/R90 同族)

- **文件**: `electron/main/services/mcp-tools-hook-bridge.ts:382` start()
- **问题**: start() 在 attach watcher 后做初始 `readdir`/`ingestFile` 存量扫描(await 处让权)。若扫描期间 stop()(stopped=true、清 watcher/timer)或又一次 start()(startGen++)插入,start() 恢复后仍无条件 `cleanupTimer = setInterval(...)`。stop() 当时看不到尚未创建的 timer → 清不掉 → 迟到的 setInterval 泄漏;在 broker 已停/重启后继续跑 stale cleanupStale,退出/重启路径残留活 timer 或污染新生命周期;新 start 情况还会用旧引用覆盖新 start 的 cleanupTimer(新 timer 引用丢失)。R81 只在 mkdir 后(attach 前)复查一次,未覆盖扫描这第二个让权点。
- **修复**: 初始扫描结束后、创建 cleanupTimer 前再复查 `stopped || myGen !== startGen`,过期则直接返回不建 timer。同时关掉本次 start 创建的 watcher 防孤儿泄漏(捕获 myWatcher;stop() 情况已关+置 null,close 幂等;新 start 覆盖了模块 watcher 引用时只关本只孤儿、不动当前 ref)。
- **测试**: 新增 hook-broker-start-stop-timer-race.spec(R108):readdir mock deferred 暂停扫描 → stop() → resolve → spy setInterval 断言**未**被调用 + watcher.close 被调;正路径(扫描无打断)断言 setInterval 调一次。中和(去 re-check)→ 负向测试失败确认回归。
- **沉淀**: 「多 await 让权点」族——一个异步 init 有 N 个 await(mkdir / readdir / ...),**每个让权点后都要复查 stopped+gen**,不能只在第一个 await 后查(R81 漏了第二个)。R90 已为 ingestFile 的 stat/readFile 两点各加复查;start() 的扫描点是同 init 内另一处。凡「init 中途让权 + 末尾创建长生命周期资源(timer/watcher/订阅)」,创建前必须再确认本次 init 仍当前。R1-R23/R25-R33/R35-R108 共 108 修(R101 含 3、R106 含 3)+ R24/R34 DEFER。

## R109 — useFsWatcher watchDir 在途时卸载/折叠,迟到的 watch 成功后留孤儿 watcher (P1)

- **文件**: `src/panels/Explorer/hooks/useFsWatcher.ts:58` watchDir 异步回调
- **问题**: watchDir(p) 是异步 IPC,发起前已乐观 `installed.add(p)`(R14)。其在途期间组件卸载(unmount 全 unwatch)或 collapse(removed 循环 unwatch + bump gen)会 fire-and-forget `unwatchDir(p)`。但 unwatch 与在途 watch 是两条独立 IPC,**main 侧可能 unwatch 先到**(此时 watcher 尚未建 → `watchers.has(p)` 假 → unwatch 立即 no-op return),随后迟到的 watch 才成功建好 watcher → **孤儿**:main 继续推 dir-changed、占 refCount/ownerPaths,反复展开后关闭/切 workspace 累积无主 fs watcher(关窗 unwatchByOwner 才兜底清)。
- **修复**: 加 cancelledRef(unmount 置真、(重)挂载复位)。watchDir 成功(r.ok)后,若 `cancelledRef.current || !installed.has(p)`(已卸载,或 collapse 未 re-expand)→ 补发 `unwatchDir(p)` 抵消孤儿。安全性依据:main 的 unwatch 是 **owner-guarded**(`!watchers.has(p)` 或该 owner `held<=0` 都 return),故对已释放/未建路径的 double-unwatch 是 no-op,补发绝不过减。re-expand 时 installed.has(p) 为真 → 不补发(现有 watch/unwatch 记账已平衡,refCount 经 collapse-unwatch 抵消 watch1、watch2 独立成立)。
- **测试**: use-fs-watcher.spec +2(R109):deferred watchDir 在途 → unmount / collapse → resolve ok → 断言 unwatchDir(p) 被调 2 次(卸载/折叠各一 + 补发一)。中和(去补发分支)→ 两测试失败确认回归。
- **沉淀**: 「异步 acquire + 独立 fire-and-forget release,两条 IPC 无序」族——release 先到会落空,acquire 后到留孤儿。renderer 侧无法保证 main 处理顺序时,**acquire 成功后复查是否仍被需要,过期则补发 release**(依赖 release 幂等/owner-guarded 才安全)。比「按 path 串行化 watch/unwatch」轻。与 R14(失败撤记账)、R37(gen 防迟到失败误删)同一 hook 的第三类在途危害:成功但已不需要。R1-R23/R25-R33/R35-R109 共 109 修(R101 含 3、R106 含 3)+ R24/R34 DEFER。

## R110 — stdio MCP 同连接多行 JSON-RPC 并行处理,有副作用工具乱序执行 (P1)

- **文件**: `electron/main/services/mcp-stdio-server.service.ts:314` sock.on('data')
- **问题**: 一个 stdio socket 一次 data chunk 含多行 JSON-RPC 时,代码对每行 `void handleLine(...)` **并行 fire-and-forget**(注释自述「简化:并行」)。各 handleLine 异步 await tool.run,完成顺序不定。`terminal.send_text` 紧跟 `terminal.press_key` 这类有副作用且必须保序的工具会乱序:Enter 先于文本写入 PTY → agent 命令输入错乱。响应按 JSON-RPC id 配对只修返回值归属,修不了**副作用顺序**。
- **修复**: 每 socket 一条 promise 链 `lineChains: Map<Socket, Promise<void>>`。data 中解析出的 lines 按接收顺序串到该 socket 链尾逐个 await;链尾 catch 后继续(单行失败/抛错不阻塞后续,各行响应仍按 id 配对发回)。socket close 时 `lineChains.delete(sock)` 防泄漏。
- **测试**: ct-b3-socket-safety.spec +1(R110):真 socket + 注入 ordered 工具(run 记录 start-n、await gate、end-n)。一个 write 发 hello + 两次 tools/call(n=1,2)→ 等 start-1 出现后断言 order 恰 ['start-1'](串行下 n=2 仍被链阻塞;并行下 start-2 已在同循环出现 → 断言失败)→ 放行 gate1 → start-2 才出现,order=['start-1','end-1','start-2']。中和(还原并行 fire-and-forget)→ 测试失败确认回归。
- **沉淀**: 「单一有序输入流(同连接/同 PTY/同会话)上的请求处理必须串行」——并行处理只在请求间无副作用顺序依赖时才安全;一旦工具有外部副作用(写 PTY/文件/状态),必须按到达顺序串行(per-连接 promise 链)。响应 id 配对 ≠ 副作用保序。这是 serializePerKey 族在「网络连接」维度的应用(key=socket)。R1-R23/R25-R33/R35-R110 共 110 修(R101 含 3、R106 含 3)+ R24/R34 DEFER。

## R111 — stdio MCP socket close 不取消在途 tool call,授权 await 后仍创建孤儿会话 (P1)

- **文件**: `electron/main/services/mcp-stdio-server.service.ts`(close 处理 + handleLine)+ `electron/main/services/mcp-tools-terminal.ts:191` create_session + `electron/main/services/mcp-host.service.ts:43` McpCallCtx
- **问题**: socket close 只清 socketCtx/socketSubject/lineChains,**不取消已进入 dispatchRpc 的在途 tool call**。create_session 在 `await ensureAuthorized()`(等用户点授权弹窗)上挂起期间,client/proxy 可能已断开;用户随后点授权 → 工具继续创建 agent terminal(autorun 副作用照跑)、把响应写回**已死 socket** → 留下无调用方的孤儿会话。
- **修复**: 给 McpCallCtx 加可选 `signal?: AbortSignal`(向后兼容,HTTP host/内部 ctx 不传即按未取消)。stdio server 每连接一个 AbortController,close 时 `abort()` + handleLine 把 `aborter.signal` 注入 ctx;create_session 在 `ensureAuthorized` 之后、`installStopHook`/`createSession` 等真正副作用之前复查 `ctx.signal?.aborted`,已取消则抛 AGENT_NOT_AUTHORIZED 不创建会话。另:dispatchRpc 返回后 `if (sock.destroyed) return` 不写响应到死 socket。
- **测试**: create-session.spec +2(授权 await 期间 signal abort→抛且不调 createSession / signal 未 abort→正常创建)+ ct-b3-socket-safety.spec +1(真 socket:tool.run 卡在 gate 时 destroy 连接→放行后 ctx.signal.aborted===true)。中和(去 tool 复查 / 去 close abort)→ 对应测试各失败确认两层独立回归。
- **沉淀**: 「跨进程 RPC 的连接断开必须取消在途、带副作用、在外部 await(用户授权)上挂起的调用」——只清连接级状态(ctx/subject/链)不够,得把**取消信号**穿到工具内、在副作用前复查。引入跨 MCP 工具边界的 cancellation contract 用**可选** AbortSignal(向后兼容、只副作用工具检查)使其contained 而非大改。与 R98/R99/R109(迟到回调失效)同源:teardown 必须门控所有在途异步的副作用,这里 teardown=socket close、在途=授权挂起的 tool call。R1-R23/R25-R33/R35-R111 共 111 修(R101 含 3、R106 含 3)+ R24/R34 DEFER。

## R112 — HTTP /mcp client 断开不取消在途 tool call,授权 await 后仍创建孤儿会话 (P1,R111 兄弟入口)

- **文件**: `electron/main/services/mcp-host.service.ts:530` createMcpHost 的 POST /mcp handler
- **问题**: R111 的 HTTP 侧孪生(我修 R111 时只修了 stdio transport,漏了 HTTP transport)。HTTP /mcp 请求在 client 断开后不取消已进入 dispatchRpc 的在途 tool call。create_session 卡在 ensureAuthorized 授权 await 时,client 断开后用户再授权仍会创建 agent terminal、最后只把响应写死连接 → 无调用方孤儿会话。
- **修复**: 复用 R111 已加的 McpCallCtx.signal 契约 + create_session 的授权后复查(已实装)。HTTP handler 每请求一个 AbortController,`req/res` 的 'close' 事件 abort → 注入 ctx.signal;dispatchRpc 返回后 `if (aborter.signal.aborted) return` 不写死连接;finally off 监听器。create_session 内的 ctx.signal 复查(R111)在此自动生效,断开后不创建会话。
- **测试**: mcp-host-reverify-on-rotate.spec +1(R112):真 HTTP host + slow 工具(run 卡 gate 后报 ctx.signal.aborted)→ POST tools/call → 进 run 后 req.destroy() 断开 → 放行 gate → ctx.signal.aborted===true。中和(close 不 abort)→ 测试失败确认接线回归。
- **沉淀**: 「同一逻辑(取消在途带副作用 call)有多个 transport 入口(stdio + HTTP)必须都接线」——R111 加了 ctx.signal 契约 + tool 复查 + stdio 接线,但 HTTP 是平行 transport,同样要接 AbortController(又一「防御未传播到所有兄弟入口」族,这次是我自己 R111 引入的连带缺口被 codex 逮到,同 R102→R103 模式)。契约层(ctx.signal)做对后,各 transport 接线是机械镜像;codex 把 stdio/HTTP 两个 transport 分两轮报,正好覆盖两入口。R1-R23/R25-R33/R35-R112 共 112 修(R101 含 3、R106 含 3)+ R24/R34 DEFER。

## R113 — settings/keybindings localStorage 跨窗口 RMW 非原子,丢更新 (P2,DEFER + 注释纠错)

- **文件**: `src/plugins/settings/values-store.ts:42` setValue + `src/plugins/keybindings/keybindings-store.ts:43` setHotkey
- **问题**: setValue/setHotkey 是 `readStored() → merge → writeStored()` 两步独立 localStorage 操作。两个 renderer 窗口并发改不同 setting/快捷键时,可能同时读到同一旧快照,各自整表写回 → 后写者覆盖前写者刚写的 key(跨窗口 lost update)。
- **既有 R6 注释错误**: 原注释声称「localStorage 读写同步、跨窗 OS 串行 → set() 内 read→merge→write 原子」。**这是错的**:Chromium 每个 renderer 进程各自缓存 localStorage 区,别窗的写经存储服务**异步**广播,本窗 readStored() 可能读不到别窗刚写的值;早期规范的 storage mutex 已废弃,无跨进程原子性。codex 复审捞出此误判(换审计者价值:自审 R6 的原子性推理是错的)。已就地把两处注释改为如实描述「缓解但不根除」。
- **处置 DEFER**(用户决策 2026-06-25,AskUserQuestion):稳健修法=把 settings/keybindings 单 key mutation 收口到主进程串行 delta 写(镜像 _enabled.json 的 setEnabledId),renderer 传 delta。但该修法**工作量大**(新 IPC + 两个 store 改造 + 测试)且**反转一个有注释的既有持久化层决策**(localStorage 轻量策略,刻意不进 explorer.json)。权衡:lost-update **低频**(需两窗近乎同时改不同 key)、**非数据关键**(设置/快捷键可重设),故暂缓,与 R24(forceKill cleanup 顺序)/R34(editor-save-vs-rename)同列 DEFER。
- **沉淀**: 「localStorage read-modify-write 跨 renderer 进程**不是**原子的」——renderer 各自缓存 + 异步广播,`写前重读` 只缩小竞态窗口不消除。需真正跨进程原子性的状态(多窗共享、并发可改)应收口到主进程串行链(setEnabledId 模式)而非 localStorage RMW。架构权衡 + 反转有注释决策的项 → 停问 user 再定(topic-54 沉淀复用)。R1-R23/R25-R33/R35-R112 共 112 修 + R24/R34/R113 DEFER。

---

## 收敛结论(2026-06-25)

codex(gpt-5.5 high,read-only,经 Continuo MCP 终端)在第 N 轮全仓复审后输出 `• 未发现问题` + `###CODEX-DONE###`,race-condition / 并发方向**收敛**。

- **总计**: R1-R23 + R25-R33 + R35-R112 = **112 处修复**(R101 含 3 处、R106 含 3 处);R24(forceKill cleanup 顺序)、R34(editor-save-vs-rename)、R113(localStorage 跨窗口 RMW 非原子)三项 **DEFER**(架构权衡 / 反转有注释决策,经用户决策或刻意保留)。
- **验证**: 全量 test 3338(起)→ 3861 PASS(+523,均带回归测试 + 中和验证);typecheck(4 tsconfig)+ lint 全绿。**未 commit**(分支 feat/cross-platform-p0,user 自管)。
- **最高频族**(贯穿全程):
  1. **迟到回调/teardown 不失效在途副作用**(R79/R81/R84/R90/R94/R97/R98/R99/R108/R109/R111/R112):订阅+异步处理+回写的桥/effect,unsub/close/卸载必须门控所有在途异步的副作用(active/gen/cancelled/AbortSignal 守卫);多让权点须每点复查。
  2. **send-fail-abort 广播族**(R62-R72):main 进程 check-alive→fan-out send 每处 per-send try/catch。
  3. **同步单飞 / per-key 串行**(R8/R100/R101/R106/R107/R110):React state 防重入对同 tick/跨入口无效,须同步闸门;同资源所有 mutation 入口共用同一 per-key 锁;有序输入流(连接/PTY)请求必串行;锁 Map 排空必回收(防内存泄漏)。
  4. **stale 实体 / 最新优先**(R50/R102/R103/R105):弹窗持有打开瞬间捕获的实体,实体从权威列表消失须关闭+写前复查;时序无关兜底遇并发须加「快照内最新」收窄。
  5. **跨进程影子状态对偶**(R104/R113):同步影子 ref + 异步 state 须所有 mutate 入口同步维护;localStorage 跨 renderer RMW 非原子。
- **核心方法学沉淀**: **修一族必 grep 所有兄弟入口**——多处自引入连带缺口(R102→R103、R111→R112)被 codex 逮到;**收口到单一共享 helper 消除漂移**(R100/R101 锁副本、R106 单飞闸门);**换审计者把自审 DEFER/误判提级**(R107 latent DEFER 提为实修、R113 揪出 R6 错误原子性推理);**架构权衡 + 反转有注释决策项停问 user**(R113)。
