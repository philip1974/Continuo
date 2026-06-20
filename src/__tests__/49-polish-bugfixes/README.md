# topic 49 · 打磨阶段缺陷修复(P1 批次)

进入打磨阶段后,对插件 / 终端 / marketplace / 窗口生命周期做子系统审计,修复 5 条
用户可感知或会造成资源/数据损失的 P1 缺陷。每条都先写本目录下的可执行规范,再改实现。

## 行为契约

### #1 终端自然退出不丢最后一段输出 — `terminal-exit-flush.spec.ts`
- PTY 自然退出时,仍卡在节流(flush)窗口里的最后一段输出**必须先发**给 renderer,
  再发 `terminal:exit`(顺序: `terminal:data` 在 `terminal:exit` 之前)。
- 退出时若无 pending 输出,则不发多余的 `terminal:data`。
- 根因: `cleanupSessionLocal` 旧实现直接 `clearTimeout(flushTimer)` 而不触发 flush,
  命令最终结果 / exit banner 被丢弃。

### #3 窗口关闭立即结束 await_stop_hook 等待者 — `stop-hook-window-close.spec.ts`
- `broker.cancelByWindow(windowId)` 取消该窗口所有 pending 等待者(reject),返回取消数量;
  其他窗口的等待者不受影响;无匹配返回 0 不抛。
- 窗口关闭清理(`makeWindowClosedCleanup`)对关闭的窗口 id 调一次 stop-hook 取消器。
- 根因: 旧实现窗口关闭只摘 metadata + kill PTY,等待者要挂到 `timeout_sec`(最长 600s)
  才靠自身 timer 自愈。

### #4 renderer reload 清理残留 MCP stub — `plugin-mcp-reload-cleanup.spec.ts`
- main frame 的全页(非同文档)导航(reload / HMR full reload)→ 摘掉该 wc 的所有 stub。
- reload 后重注册同名 tool 不再撞 `TOOL_NAME_TAKEN`。
- 同文档导航(hash / pushState)与子 frame 导航**不**摘 stub。
- 根因: 旧实现只监听 `webContents 'destroyed'`,reload 时 wcId 不变但 renderer registry
  被清空重建,main 端旧 stub 残留 → 调用 reject `NO_SUCH_TOOL`、重注册撞名。

### #2 + #5 插件安装/更新原子化 — `install-atomic-overwrite.spec.ts` + `marketplace-tab` 回归
- `installFromGit` 用 staging + rename 原子落位:`overwrite=true` 替换旧版本;
  `overwrite!=true` 且已存在仍抛 `EEXIST`;clone 失败保留旧版本且 baseDir 无
  `.installing` / `.old` 残留;全新安装写入目标目录。
- marketplace「更新」改为 `installFromGit(url, overwrite=true)`,**不再先卸载** ——
  旧实现卸载成功但重装失败会丢插件(审计 #2),且原子覆盖保留 `_enabled`/`_permissions`。
- 根因 #5: 旧实现 `access(targetDir)` 后 `cp`,并发同 id 互相覆盖、`cp` 中途失败留半个
  目录 → 永久 `EEXIST`。

## P2 批次(资源/边界/体验)

### P2-A shell-stream ABORT 升级 SIGKILL — `shell-stream-abort.spec.ts`
- ABORT 对吞掉 SIGTERM 的子进程在 1s 后升级 SIGKILL(exit signal `SIGKILL`)。
- ABORT 后立即清 `active` 表 → 同 streamId 可再次 START。
- 根因: 旧实现 ABORT 只发 SIGTERM、不清表不升级,子进程吞信号会挂到 timeout(最长 30min)。

### P2-B readGitBlob 超时 + 字节上限 — `read-git-blob-bounds.spec.ts`
- 正常读取 blob 内容;超过 `maxBytes` → reject(不无界累积);不存在的 sha → reject。
- 根因: 旧实现无 timeout、stdout 无上限,超大 blob / git 卡死会让 Promise 永不 resolve + 内存涨。

### P2-C notifications 底层数组硬上限 — `notifications-cap.spec.tsx`
- error 突发超过 `MAX_NOTIFICATIONS` → 底层数组截断到上限,保留最新、丢最旧(并清其 timer)。
- 根因: error 级不 dedupe + 存活 15s,显示层只 slice 可见区,底层数组会无界堆积。

### P2-D AccountChip 非交互 — `account-chip-not-button.spec.tsx`
- 账户菜单未实现前,chip 渲染为非 `button` 元素(有 title tooltip,无 button 角色)。
- 根因: 旧实现是带 hover/focus-ring + `aria-label` 的空 onClick `<button>`,向屏幕阅读器
  谎报可点;同时移除已 orphan 的 `shell.iconbar.account_aria` i18n key(en/zh/ko)。

## P2 批次(子系统二次审计 follow-up)

### P2-E popout 判定收紧 — `popout-url-detection.spec.ts`
- 主进程 `isPopoutUrl(url)` 用 `URLSearchParams.get('popout')==='1'` 精确判定,
  与 renderer `src/lib/popout-mode.ts` 同语义。
- 根因: 旧实现 `getURL().includes('popout=1')` 裸子串匹配,workspace 路径或其它
  query 值里恰好含 `popout=1` 的普通主窗会被误判成 popout 子窗(`setMenu(null)` +
  禁 Cmd+R)。

### P2-F atomicReplace 泄漏 trash 可被回收 — `electron/main/__tests__/trash-sweep.test.ts` T20bis.e
- `trashPathFor(finalPath, unique)` 产出的 trash 名以 `TRASH_PREFIX`(`.trash-`)开头
  且落在同父目录,`sweepStaleTrashInDir` 按前缀匹配能命中。
- 根因: 旧实现 trash 名是 `${finalPath}.trash-...`(后缀形式 `foo.json.trash-...`),
  不以 `.trash-` 开头,sweep 永远漏掉。rename 回滚失败(line 489)泄漏的 trash 会
  永久驻留插件目录。旧测试只用字面量 `.trash-old` 掩盖了这个 bug。

### P2-G before-quit 不重复 flush 同窗 — (index.ts `wireWindowCloseFlush`)
- close handler 除局部 `flushed` 外,也查 `flushedOnQuit.has(win.id)`。
- 根因: Cmd+Q 时 `before-quit` 已 flush 本窗并写 `flushedOnQuit`,但 close 闭包的
  局部 `flushed` 不会被它更新 → `app.quit()` 触发 close 时对同窗重复 flush
  (多一次 IPC 往返 + `preventDefault` 二次阻塞退出)。lifecycle 类改动,
  靠逻辑审计 + 全量 suite 回归,不单测 Electron app 生命周期。

## P2 批次(第二轮子系统审计 — preload/persistence)

### P2-H execStream START reject 不再永久挂起 — `shell-stream-start-reject.spec.ts`
- preload `execStream` 把 `ipcRenderer.invoke(START)` 的 rejection 转成本地合成 exit
  (`{exitCode:-1}`),终止 chunk 迭代器并 resolve `done`。
- 根因: 旧实现 `void ipcRenderer.invoke(START, ...)` 丢弃 rejection。主进程在 spawn
  任何进程之前就 reject(`streamId already active` 是同步 throw,或 handler 在 emit
  'exit' 前抛错)时,永远不会回 'exit' 事件 → `done` 与 `for await (chunks)` 永久
  挂起,插件死锁。

### P2-I explorer.json 损坏保留快照 — `explorer-corrupt-preserve.spec.ts`
- `loadExplorer` 区分"文件不存在"(→默认,不保留)与"存在但无法解析"(→写一次性
  `.corrupt` sidecar 后返 null,`flag:'wx'` 不覆盖更早备份)。
- 根因: 旧实现对 ENOENT 与损坏都返 null,运行期写路径
  `(await loadExplorer()) ?? defaultExplorerV3()` 会在下一次窗口关闭/布局写时把整个
  explorer.json 静默覆盖成默认值 → recentRoots/pinned/所有 window 段不可恢复丢失。
  迁移路径(`migrateExplorerFileToV3`)对损坏文件特意 skip 不动,运行期写路径却没有
  同等保护,二者不一致。

## P1/P2 批次(第三轮子系统审计 — 编辑器/MCP)

### P1-J saveFile 写盘 await 期间并发编辑不丢 dirty — `save-race-dirty-preserve.spec.ts`
- `markSaved(id, savedContent)` 接收已写盘快照,仅当当前内容仍等于已写内容时才清
  dirty;否则把 originalContent 推进到已写内容但**保留 dirty=true**。`saveFile` 把
  写入的 `tab.content` 快照传进去。
- 根因: 旧 `markSaved(id)` 读 store **当前** content。saveFile 在 await writeFile
  期间用户继续键入(content S1→S2、dirty=true),resolve 后 markSaved 把
  originalContent=S2、dirty=false → 磁盘 S1、内存 S2、UI 显示已保存 → S2 增量既没
  落盘又不再触发 autosave,**静默丢失**。Markdown 2s autosave 高频 + IPC 写盘延迟
  易复现。旧单测只覆盖顺序场景,无并发盲区。

### P2-K stdio close() 有活动连接也不挂起 — `stdio-close-no-hang.spec.ts`
- `close()` 先遍历 `clients` 调 `sock.destroy()`(并清 `socketCtx`)再 `server.close()`。
- 根因: 旧实现只 `clients.clear()` 不 destroy socket,而 `server.close(cb)` 的回调要
  等所有现存连接关闭才 fire → 有活动客户端时回调永不触发 → close() promise 永久
  挂起,`unlink` 在挂起的 await 之后也执行不到 → socket 文件残留。

## P1/P2 批次(第四轮子系统审计 — marketplace/fs 安全)

### P1-L 插件 id 路径穿越防御 — `plugin-id-traversal.spec.ts`
- `isSafePluginId(id)` 在原正则基础上显式拒 `.`/`..`,`installFromGit` 校验改用它。
- 根因: 旧正则 `^[a-z0-9._-]+$` 允许纯点段,`manifest.id='..'` 通过校验 →
  `path.join(baseDir,'..')` 解析到 baseDir 父目录;overwrite 安装(marketplace「更新」
  路径直接传 `overwrite=true`)随即 rename 覆盖/挪走父目录 = 路径穿越。社区插件
  `verified` 仅徽章不阻止安装。与 fs `renameEntry` 拒 `.`/`..` 同款防御。

### P2-M atomicWriteFile 去掉 .backup 数据丢失窗口 — `atomic-write-no-backup-window.spec.ts`
- 用户文档原子写简化为「写 tmp+fsync → rename(tmp→path)」,移除覆盖前的
  `rename(path→.backup)` 预备份步骤。
- 根因: 旧实现在 rename 之前先把原文件挪成 `.backup`,在「原文件已挪走 / tmp 未就位」
  之间留了**进程崩溃 → path 不存在**的数据丢失窗口,且无任何启动期 `.backup` 恢复逻辑。
  `rename(tmp→path)` 本身就是 POSIX/Windows 原子替换:原文件直到替换那刻始终完好、
  rename 失败也不动原文件 → 预备份多余且有害。

## P2 批次(第五轮 — 跨切面资源生命周期复查)

### P2-N fs watcher 池 owner-aware 释放(硬关窗不泄漏) — `explorer-watch/watch-pool.spec.ts`
- `createWatcherPool` 增 `ownerId` 追踪 + `unwatchByOwner(windowId)`;`fs.ipc` 的
  WATCH/UNWATCH 改 `safeHandleWithCtx` 记录发起窗口;`index.ts` 的 `win.on('closed')`
  调 `releaseFsWatchersForWindow(win.id)`。顺带修 LRU:重复 watch 已存在 path 刷新其
  在 `order` 中的位置(P3,避免热点目录被误驱逐)。
- 根因: 全局单例 watcherPool 被所有窗口共享、按 path 引用计数,释放只依赖 renderer
  `useFsWatcher` 的 unmount cleanup。窗口**硬关闭/崩溃/webContents destroyed** 时
  React cleanup 不保证执行,旧 `win.on('closed')` 只清 terminal 不解绑 fs watcher →
  该窗持有的 watcher 引用永久驻留,长会话单向累积触顶 `MAX_WATCHERS=64`,把活跃窗口
  的 watcher LRU 踢掉 → 活跃窗漏文件变更更新。

## P1/P2 批次(第六轮 — 完整性扫描:shell.service / 工作区切换)

### P1-O execShell SIGKILL 升级真正生效 — (shell.service.ts,逻辑修复)
- 超时 grace 后的强杀判定改用本地 `exited` 标志(在 'close'/'error' 置位),替代 `child.killed`。
- 根因: `child.kill('SIGTERM')` 一旦成功**发出信号**就把 `child.killed=true`(Node 语义:
  killed=信号已发送,非进程已退出),旧 `if (!child.killed) child.kill('SIGKILL')` 恒假 →
  SIGKILL 永不执行,吞掉 SIGTERM 的子进程超时后永远不被强杀,挂在后台。代码里原有的死
  变量 `killed` + `void killed` 印证本意就是想用本地标志。

### P2-P execShell 按字节封顶 + 无跨 chunk UTF-8 乱码 — `shell-exec-cjk-bytes.spec.ts`
- 输出改为收集 `Buffer[]` 按 `byteLength` 封顶,最后 `Buffer.concat` 一次性 decode。
- 根因: 旧实现用 `string.length`(UTF-16 code unit)当字节封顶(CJK 实际字节量可达上限
  3x),且对每个 data chunk 单独 `toString('utf-8')`,多字节 UTF-8 序列被切到两 chunk 时
  边界产生替换字符(乱码)。CJK 重项目尤其明显。

### P2-Q 切 workspace 保留 root 外的脏 tab — `switch-root-keep-dirty-tab.spec.ts`
- `getStateAfterClosingTabsOutsideRoot` 的保留判定改为 tab-aware 的 `keep(tab)`:
  untitled 草稿与 **dirty(未保存)tab** 一律保留,只关 root 外的 clean 文件 tab。
- 根因: 旧实现只按 `filePath` 位置判定,落在新 root 外的脏真实文件 tab 被直接关闭、
  未保存编辑静默丢失(untitled 因 filePath=null 被保护,真实路径脏 tab 不受保护)。
  与 issue-45 drag-folder 切根同源场景,脏 tab 保护缺口此前未覆盖。

### P2-R plugin-data 原子写 + 损坏降级 — `plugin-data-corrupt-degrade.spec.ts`
- `plugin-data:save` 改用 `atomicWriteJson`(temp+fsync+rename);`plugin-data:load`
  对 JSON 解析失败保留 `.corrupt` 快照后降级返回 `{}`(不再 rethrow)。
- 根因: 旧 save 用 `fs.writeFile`(truncate-then-write)非原子,崩溃/掉电截断 data.json;
  旧 load 对 parse 失败只放行 ENOENT、其余 rethrow → IPC 永久 reject,该插件持久化数据
  "假死"丢失。本仓所有其它持久化(explorer/settings via atomicWriteJson、hook-bridge
  copyFile 备份)都 crash-safe,唯独这条被遗漏。

## P1 批次(第七轮 — 编辑器自动保存 / fs rename)

### P1-S 切走/卸载 markdown tab 不丢自动保存 — `autosave-tab-switch-flush.spec.tsx`
- `useAutoSave` 改为每个 tab 一个 scheduler(绑定调度时捕获的 `tabId`,经新
  `saveTab(id)` 保存);切走该 tab(scheduler 身份随 tabId 变)或组件卸载时
  `scheduler.flush()`(而非 `cancel`)→ 用捕获的 tabId 把防抖窗口内的 pending
  编辑立即落盘。`makeAutoSaveScheduler` 新增 `flush()`(有 pending 才执行,否则 no-op)。
- 根因: 旧实现把保存绑定到"当前 active tab"(`saveActive`),并在内容/脏态变化的
  effect cleanup 里 `cancel` pending。markdown 防抖每次按键重置 → 连续输入期间保存
  从未触发;2s 内切到别的 tab 时 cleanup `cancel` 掉 pending → 该 tab 的**整段未保存
  编辑静默丢失**(editor content/dirty 不持久化,"MVP 不做 hot exit",关窗即没)。
  且若改成 cleanup flush 又会因 active 已切走而保存**错的** tab —— 必须按捕获的
  tabId 保存。旧 `use-auto-save.spec.tsx` "卸载时 cancel" 把该 bug 固化成预期,本轮
  翻成 "卸载时 flush"。

### P1-T renameEntry 拒绝静默覆盖已存在目标 — `rename-no-silent-overwrite.spec.ts`
- `renameEntry` 在 rename 前校验目标:已存在且与源不是同一 inode → `FS_EEXIST`;
  大小写不敏感盘上 `File.txt→file.txt`、改回同名等"改名到自身"(同 inode)仍放行。
- 根因: POSIX `rename(2)` 原子覆盖既有文件/空目录。旧 `renameEntry` 只校验源存在就
  `rename(old,new)` → Explorer 把文件 A 改成已存在文件 B 的名字时 B 被**永久覆盖丢失**
  (无回收站、无确认)。同模块 `moveEntry` 早有 dest-exists 拒绝(`FS_EEXIST`),
  rename 这条路漏了;`mutate-actions.spec.ts` 注释"撞名由 IPC 层判定"也印证本意应在此拦。

### P1-U 多窗口并存不互相覆盖窗口段 — `multi-window-no-cross-clobber.spec.ts`
- `snapshotFromStores` 只输出本窗段(`windows:[myEntry]`),**不**携带 prevSnap 里
  其它窗口的陈旧段。保留其它窗口最新段由 main 的 `explorer:write` 在 file-mutex 内
  重读磁盘 + `mergeWritableIntoFull`(对 writable 没有的 windowSeq 走
  `else merged.push(cur)`)完成。
- 根因: `lastSnap` 本窗启动时读盘一次、之后只被自己写的内容更新、**从不重读磁盘**。
  窗口 A 启动时拿到的 B 段是当时快照;之后 B 改 root/tabs/expanded 写盘;随后 A 因
  任意 store 变化落盘时 `snapshotFromStores` 把陈旧 B 段一并写回 → merge 用陈旧 B
  覆盖磁盘 B 最新段 → **B 的最新工作区/标签页/展开状态被静默回退**(跨窗状态丢失,
  normal-path 触发:同时开两个窗口用)。旧 `persistence-layer.spec.ts` "新窗 write
  保留主窗段" 把 renderer 携带他窗段固化成预期,本轮翻成 "只写自己段"。
- 遗留(留档不修): **全局段 `pinned`/`recentRoots` 的跨窗 last-writer-wins** 仍在
  (`mergeWritableIntoFull` 对全局字段 `...writable` 整体覆盖)。各 renderer 独立
  hydrate 后全局段会发散,A pin 一个文件、B(持陈旧全局段)随后落盘会覆盖掉。属
  架构级(需 main-owned 全局态或带 tombstone 的并集合并,无法用简单 union 处理 unpin),
  且严重度低于窗口段(pin/recent 是便利项、可恢复、owning 窗下次写会回填),DEFER
  到独立 topic。

## P1/P2 批次(第八轮 — shell/MCP-stdio/marketplace 并发)

### P1-V execShell 写 stdin 无 'error' 监听不再崩溃整个 main 进程 — `shell-service.spec.ts`
- `execShell` 写 `child.stdin` 前挂 `'error'` 监听吞掉 EPIPE,并 try/catch 同步
  `write`/`end`。
- 根因: 子进程不读 stdin / 写入前就退出时,向已关闭管道写会在 `child.stdin`
  (独立 emitter)上发 `'error'`(EPIPE)。该事件无监听者会上抛为 uncaughtException;
  `electron/main` **没有任何 `process.on('uncaughtException')` 兜底** → 一次 EPIPE
  崩溃整个主进程(所有窗口 + 未保存状态全丢)。任何持 `shell` 权限的插件用 `input`
  跑一个不读 stdin 的命令(如 `sh -c 'exit 0'`)即可触发。旧代码只在 `child` 上挂
  `'error'`,漏了 `child.stdin` 这个独立流。

### P2-W stdio MCP 连接绑定窗口关闭后不永久失效 — `stdio-stale-window-binding.spec.ts`
- 新增纯 helper `resolveStdioCallOwnerWindow(ownerWindowId, {isWindowAlive})`:
  绑定窗口存活才返回它,死/未绑定返回 null → dispatch 走 fallback 到当前活窗。
- 根因: `socketCtx` 在 `_continuo/hello` 时把 socket 一次性绑到某 windowId;窗口关闭
  清理(revokeWindowTokens/cancelByWindow)不触碰 socketCtx,而 proxy 进程没退、
  socket 仍连着。旧 dispatch 直接用陈旧 windowId 构造 ctx(非 null)→ 跳过 fallback
  分支 → `BrowserWindow.fromId(deadId)=null` → 所有 tools/call 撞 TERMINAL_NO_WINDOW/
  SESSION_NOT_FOUND,该 proxy 连接对所有工具**永久损坏**(即使别的窗口活着)。

### P2-X update/reviews store 并发 refresh 不被过期结果覆盖 — `marketplace-update-store/update-store.spec.ts`
- `useUpdateStore.refresh` / `useReviewsStore.refresh` 各加单调 `gen` 守卫:捕获本次
  代际,async 完成后仅当仍是最新代际才落库,否则丢弃过期结果(mirror settings.store)。
- 根因: 启动时各触发一次 refresh,MarketplaceTab 更新插件成功后又调 refreshUpdates。
  并发时各自 set loading/checking,**谁后 resolve 谁覆盖** `available`/`byPid`;慢的
  网络请求后返回会用过期数据覆盖更新结果(角标 stale)。入口无 in-flight/gen 守卫。
  用 gen(非 in-flight 丢弃)是因为 post-update refresh 必须能让最新结果赢。

## P1/P2 批次(第九轮 — 插件生命周期并发 / 终端 overflow / 撤销强杀)

### P1-Y PluginManager enable/disable/reload/uninstall per-id 串行锁 — `plugin-manager/plugin-manager.spec.ts`
- 新增 `withLifecycleLock(id, fn)`(复用 plugins.service `withInstallLock` 同款 Promise
  链锁),把四个生命周期方法的 body 抽成 `*Locked` 私有实现、public 方法只负责加锁。
  `uninstall` 内部走 `disableLocked`(非 public disable)避免对同 id 重入锁自死锁。
- 根因: 生命周期方法是 async 且含多个 await 让权点(权限 prompt / `_registerPlugin` /
  `_activate` / IPC),却**无 per-id 串行**。reload 由 mtime watcher **每 2s**
  fire-and-forget 触发 + 用户在 Plugins/Marketplace 手动操作 → 同 id 极易并发。两次
  reload 交错时:先发的 `activateEntry` resume 后用旧 token 覆盖
  `entry.pluginFsToken` → **新 token 永不 `_unregisterPlugin`(IdentityRegistry entry +
  已 grant path-scope 永久驻留)** + 留双激活僵尸实例 + panel/command/MCP-tool 重复贡献。
  回归测试经验证:去掉锁 `regs-unregs` 从 1 变 2(泄漏一个 token)即 FAIL。

### P2-Z terminal overflow 后流静默仍补发 overflow-recovered —(terminal.service.ts,逻辑修复)
- throttle reset interval 内增:若 `overflowNotified` 且本窗速率已 ≤ 阈值,清标志并
  `safeSend('terminal:overflow-recovered')`。
- 根因: `overflow-recovered` 旧实现**只在下一个低于阈值的 chunk 到达时**发送
  (handleChunk)。PTY 突发超 2MB/s 进 overflow 后若流恰好静默(命令输出完等输入),
  没有新 chunk → recovered 永不发 → renderer 永久卡在 overflow 指示,直到下次有输出。
  唯一周期回调 throttleInterval 只 reset `bytesPerSecond` 不碰 overflow 状态机。
  (timer/lifecycle 类,无 PTY 外的纯 seam,靠逻辑审计 + 全量 suite 回归,同 P2-G。)

### P2-AA 撤销 agent 授权用 forceKill 立即强杀 — `agent-auth-service/agent-auth-service.spec.ts`
- `revokeAndKillAgentSessions` 把 `termService.kill(id)`(先 Ctrl+C、3s grace 后 SIGKILL)
  改为 `termService.forceKill(id)`(立即 SIGKILL)。
- 根因: 用户**显式撤销** agent 授权是安全动作。旧软杀给吞 SIGINT / 正在跑破坏性命令的
  agent 子进程最长 **3s grace 继续运行**。token 已 rotate 挡住新 MCP 调用,但已在跑的
  本地子进程不受 token 影响,必须立即强杀(与 index.ts before-quit 特意用 forceKill
  防 agent 长任务孤儿化同源理由)。

## P1/P2 批次(第十轮 — 编辑器外部重载 / Explorer 批量操作一致性)

### P1-Z 外部修改 markdown 后 Milkdown 视图拿到新内容 — `milkdown-external-reload-epoch.spec.ts`
- `EditorTab` 加 optional `reloadEpoch`,仅 `reloadFromDisk`(外部进程改文件后同步)递增
  (用户输入 `updateContent` / 保存 `markSaved` / dirty-skip / 内容未变-skip 都**不**动它)。
  EditorPanel 的 Milkdown `key` 并入 epoch:`${id}-${effective}-${reloadEpoch}`。
- 根因: MilkdownEditor 的 `defaultValue` 只在 mount 时读,视图靠 key remount 刷新。
  旧 key=`${id}-${effective}` 不含内容 → 外部进程/agent/git 改文件时
  `useExternalFileSync→reloadFromDisk` 更新了 store content,但 id/effective 都没变 →
  Milkdown 不 remount,仍显示旧内容。用户随后在 Milkdown 里编辑,序列化基线是旧内容,
  Cmd+S/autosave 写盘时**静默覆盖磁盘上的外部新版本**(数据丢失)。CodeEditor 有
  `[value]` 同步 effect 把外部 content 推进编辑器,Milkdown 没有等价机制。不能把 content
  直接并入 key(每按键 remount)也不能用 originalContent(markSaved 也推进它 → autosave
  后光标跳),故需"仅外部重载递增"的专用计数。

### P2-BB Explorer 批量 move/paste 中途失败仍刷新已成功项 — `FolderTree.tsx`
- `onDropItems`(多选拖动)和 `onPaste`(cut/copy 粘贴)用 try/finally:循环内首错仍
  `notify.error` + 中止剩余项(设计选择),但在 finally 里刷新已成功项涉及的 destDir +
  源父目录(`movedAny`/`okAny` 守卫只在真有成功项时刷)。cut 剪贴板仅全成功才清。
- 根因: 旧实现循环内首错直接 `return`,跳过了循环**之后**的 `refreshParent(destDir)` +
  源父目录 invalidate。已成功移动的文件因此在树上既不在源目录消失、也不在目标目录出现
  (直到手动刷新),而其 editor tab 路径已被 `renamePath` 改向新位置 → **树/tab/磁盘三者
  不一致,已移动文件在 UI 上凭空消失**。对照 `mutate-actions.removeItems` 累积
  successParents 循环后无条件刷新的正确模式,这两个内联循环漏了。(UI 一致性修复,
  无纯函数 seam,靠逻辑审计 + typecheck + 全量 suite 回归。)

## P2 批次(第十一轮 — 对抗复审 + i18n 多窗口)

> 第十一轮先对前 7~10 轮的 11 处改动做对抗性复审:10 处确认正确(多处是真修复),
> 仅 autosave 一处需补强(下方 P2-DD)。另对剩余子系统(dock/i18n/restore/title-status)
> 扫描,发现 2 条 i18n 多窗口 P2。

### P2-DD autosave 运行中禁用应取消已排队保存 —(useAutoSave.ts,补强第七轮改动)
- schedule effect 在 `!enabled` 分支补 `scheduler.cancel()`。
- 根因: 第七轮把 schedule effect 的 `return () => cancel()` cleanup 删掉(改用按
  tabId 的 flush effect 落盘),副作用是"运行中关掉 markdown autosave 设置不再取消
  已排队的那次保存"。非数据丢失(只多写一次合法内容),但弱化了"禁用即停"契约。
  对抗复审发现,补回 disable→cancel(切 tab 落盘仍由 flush effect 负责,不受影响)。

### P2-EE macOS dock 右键菜单随 locale 切换重建 —(index.ts,逻辑修复)
- 抽 `setDockMenu()`,启动 + `rebuildAppMenu`(setLocale 后被调)都调用。
- 根因: dock 菜单(`app.dock.setMenu`)的标签是 locale 依赖的,但只在启动设置一次;
  `rebuildAppMenu` 只 `Menu.setApplicationMenu` 重建 application menu,漏了 dock 菜单 →
  macOS 切语言后右键 dock 图标两项标签永久停留旧语言。(darwin-only,无 PTY 外 seam,
  逻辑审计 + 全量回归。)

### P2-FF settings values-store 跨窗口 storage 同步 — `settings-cross-window-sync.spec.ts`
- values-store 监听 `storage` 事件(只在别 document 改 localStorage 时 fire),同 key
  就 `readStored()` 重读 → 各窗 values 收敛一致。
- 根因: values-store 用 localStorage 持久化但 zustand 内存只在本窗启动读一次、不随别窗
  写更新。多窗口下 A 改 `general.language=zh` → 写 localStorage + 经 settings 广播更新
  `useSettingsStore.locale=zh`,但 B 的 values-store 内存仍 en → `LanguageFromSettings`
  的 values→store 协调 effect 拿 B 陈旧 value(en)把刚广播来的 zh **又改回 en 并广播** →
  两窗 locale 反复互斗翻转。两个真相源(广播驱动的 store vs 各窗本地 localStorage values)
  无跨窗同步。storage 监听让 values 跨窗一致(设置均 app 级全局,跨窗一致也更符合预期),
  且各窗收敛同值后多次 setStoreLocale 都是同 locale 幂等,无震荡。

## P2 批次(第十二轮 — 最终收敛确认 + watcherPool 跨窗修复)

> 第十二轮做最终收敛确认:对抗复审第十一轮 3 处改动(dock menu / settings storage 同步 /
> autosave 禁用取消)**均无回归**;完整性兜底扫描(启动关闭顺序 / IPC 永挂 / swallow
> error / listener-timer 泄漏 / 异常路径 promise 永不 settle)只发现 1 条新 P2(下方),
> 修复后 agent 确认**未发现其它新可修 P1/P2,打磨阶段收敛**。

### P2-GG watcherPool LRU 驱逐清 owner 记账,避免跨窗口误杀 watcher — `explorer-watch/watch-pool.spec.ts`
- LRU 驱逐某 path 时新增 `purgeOwnerAccounting(oldest)`:从**所有** owner 的 ownerPaths
  里清掉该 path 记账。
- 根因: 第五轮 P2-N 给 watcherPool 加 owner-aware 释放(ownerPaths 按窗口记账 +
  unwatchByOwner 关窗批量释放)时,LRU 强制驱逐分支只 `watchers.delete(oldest)` + close,
  **没同步清 ownerPaths**。同工作区开两窗 + 单窗展开 >64 目录触发驱逐后:窗口 A 被驱逐的
  /p0 仍残留在 ownerPaths{A};窗口 B 重建 /p0 的 watcher(refCount=1,owner=B)后,A 关窗
  `unwatchByOwner(A)` 按陈旧记账对 /p0 `decrementRef` → **把 B 的活跃 watcher 减到 0 并
  close** → B 的 Explorer 对该目录增量刷新静默失效(树停留陈旧需手动刷新)。是 P2-N
  owner-aware 改动自身引入的跨窗回归。回归测试经验证:去掉 purge 即 FAIL。

## 已审计但不修(留档)
- pruneLRUClosed 基数用 `windows.length`(含活跃窗)而非 `closed.length`:逻辑确实错,
  但生产 `LRU_MAX_CLOSED=Infinity` 短路成死代码,且"修复"需翻改现有绿测 T7 的断言
  (`[1]`→`[1,2]`)——该断言可能编码了原始意图,无作者确认下不武断改语义。
- mcp hook `cc_unknown_*` windowId=null 通配匹配:改成不匹配会让 `CONTINUO_WINDOW_ID`
  合法缺失的降级场景下 stop-hook 永不触发,属有意 fallback,不动。
- 跨进程 explorer.json 写竞态:已由 `app.requestSingleInstanceLock()` 兜底(第二实例
  直接退出),非真实暴露面。
- renderer 安装/卸载 async 后 setState-on-unmounted:React 19 已移除该警告且为优雅
  no-op,加 mountedRef 属过度设计,跳过。
- MCP stdio fallback 无 token 授予「第一个主窗」tool 权限 + rotateToken/revoke 不断开
  stdio 连接:unix socket 靠 0600 文件权限(用户信任域)鉴权,与 HTTP 网络面的 token
  体系不同;改写 stdio auth 语义有破坏 Claude Code 默认 stdio 集成的高风险,属需独立
  设计的安全议题,不在打磨 pass 内贸然重写。
- 用户主动关 terminal panel → `terminal.remove` 被调两次(第二次 no-op)、CodeEditor
  外部 reload non-dirty tab 时光标重置:P2/P3 体验项,非数据丢失/资源泄漏,本批不动。
- 全局命令快捷键(useCommandHotkeys)匹配即无条件 preventDefault,理论上会吞掉输入框
  原生按键。但 xterm 内部就是 textarea,naive「target 是 textarea 就跳过」会连带破坏
  Find-in-Terminal(mod+f);正确修法是把 preventDefault 决策下放到命令(`cmd.fn` 返回
  handled),属 SDK 命令契约变更而非打磨补丁,有破坏既有终端快捷键的高风险,DEFER。
- marketplace fetch 无超时/响应体大小上限、index 未逐项 schema 校验、atomic-write 父目录
  未 fsync、通知 dedup 不重置动画、KeybindingCaptureModal 无法 Enter 保存、Modal 焦点
  恢复指向已卸载元素、Quick Open 切 root 后短暂 stale 列表:均 P3 健壮性/体验项,
  非数据丢失/安全/资源泄漏,本打磨批次不展开。
- 插件禁用/卸载时其已打开的 Dockview 面板不被关闭(变惰性僵尸面板,fs token 已吊销):
  真实 P2,但修复需 PluginManager 持 dock API 引用 + 按 panel-type 枚举关闭存量面板,
  属架构级跨层改动;dock 层刚修过 StrictMode 崩溃(topic 47)较脆弱,贸然改风险大于
  僵尸面板本身(面板惰性化不崩溃)。建议作为独立 topic 设计,本打磨 pass DEFER。
- enabled.json 的 read-modify-write 竞态(并发 enable/disable 后写覆盖前写):当前是用户
  串行 UI 操作,P3;若未来加批量启用/自动化触发再升级处理。
- read_output 缺 `deps.has()` 存在性检查:**经核实非 bug** —— 读"已退出但保留"的 session
  输出缓冲必须不查 PTY 存在性(否则破坏 kill 后仍可读缓冲的契约),owner-check +
  底层 readOutput 的 NOT_FOUND 映射已保证与其它 per-session tool 错误码一致。
- (第七轮验证否决)**plugin scope grant 路径非规范化**:`check()` 比较的是 canonical
  realpath probe vs 字面 scope,非规范 scope 一律 **fail-closed**(拒绝访问),不是越权
  逃逸;realpath-on-target 本身已挡住 symlink target 逃逸。审计 agent 方向报反,非安全 bug。
- (第七轮验证降级)**request-scope pending Promise 不在 webContents 销毁时取消**:有
  5min TTL + ping keepalive 自愈,且**等待者就是已死的请求方 renderer 自己**(非跨进程
  挂起,区别于 stop-hook #3 的外部 MCP 等待者),仅 ≤5min 内存滞留,P3 留档不修。
- (第八轮 pre-existing)**autosave × "放弃修改" 语义冲突**:md 自动保存 tab 关闭弹"放弃"
  对话框时,若停留 >2s,仍在跑的 2s 防抖 autosave 会把待放弃内容写盘。但 `confirmDiscard`
  调 `closeTab` 先移除 tab,随后切走的 flush `saveTab(removedId)` 返回 TAB_NOT_FOUND **不
  写盘**(第七轮 flush 改动经核实未引入此回归)。残留的仅是"对话框开着时定时器触发保存"
  的既有窄场景;且数据模型不保留 session 前快照,autosave 文件的"真正放弃"本不可实现,
  属产品语义限制,不冒险再动编辑器保存。
- (第八轮)**StatusBar MCP copy 反馈 setTimeout 不跟踪**(快速连点中途打回 idle)+
  **DockReconciler 模块级 previousCustomTitlesRef 跨 remount 残留**(`[需验证]`):均 P2/P3
  纯 UI 反馈/标题刷新瑕疵,非数据丢失/资源泄漏,本批不展开。
- (第九轮)**MCP register 的 pluginId 由 renderer 自填、main 不与 token 反查绑定**:
  scoped-app 正常路径用闭包 pluginId 不可伪造;`owner.pluginId` 仅用于展示/listRegistered,
  invoke 路由用 requestId+wcId 不基于 pluginId 授权 → 同 realm 恶意插件至多冒名归属/抢
  tool name,无直接越权。可加固(main 端从 token 反查真实 pluginId)非可触发,DEFER。
- (第九轮)**plugins-host Blob URL 永不 revokeObjectURL**:每次 reload 为所有插件各建一个
  Blob URL 不回收,频繁 reload(2s watcher)下内存累积。已在源注释承认的 tradeoff,P2 信息性,
  靠文档卸载兜底,本批不展开(修法:reload 时 revoke 上一轮该 id 旧 moduleUrl)。
- (第九轮)**agent-auth 目标窗为 popout 时 fallback 到任意活窗、提示无来源标识**
  (`[需验证]`):confused-deputy 面,但已销毁窗的 token 在窗关闭时已 revoke、`verifyAndResolveCtx`
  先 401,实际只 popout 触发;真相源在 renderer,本批只读 main,DEFER(建议 prompt payload
  带发起窗可读标识)。
- (第九轮)**PluginManager activateEntry 覆盖 entry.pluginFsToken 前不断言为空**:正常单线程
  路径(deactivate→activate 顺序)旧 token 已撤,P1-Y 的锁已消除并发交错入口,此为纯防御
  加固(断言 `=== undefined` 或先 revoke),本批不额外加。
- (第十轮)**二进制文件可被单击打开为 utf-8 文本、编辑保存后永久损坏**:read-file 无条件
  `readFile(path,'utf-8')` 有损解码(非法字节→U+FFFD),保存写回即不可逆损坏原文件。属真实
  P2,但修复需在打开链路加 binary 探测(NUL 字节 / 扩展名 allowlist / 大小上限)+ 决定
  非文本文件的 UX(拒开 / hex 视图 / 外部程序打开),属功能性改动而非补丁,有误拦合法文本
  文件风险,DEFER 到独立 topic(同 `read-file` 无大小上限的 P3 一并处理)。
- (第十轮)**plugins-host 每次 reload 泄漏 Blob URL**(reload 全量重建所有插件 blob URL 只用
  一个、覆盖旧 moduleUrl 均不 revoke):dev-only(2s watcher + 文件改动触发),生产态无文件
  改动不触发,源注释已承认靠 GC 兜底。P2 信息性,DEFER(修法:reloadLocked 换 dirInfo 前
  `revokeObjectURL(旧)` + listPluginDirs 非匹配项不分配 blob)。
- (第十轮)**`mod+p`/`mod+shift+p` 保留热键不在命令注册表 → Keybindings UI 重绑无冲突警告 +
  运行时双触发**(`[需验证]`)+ **useColumnResize 拖拽中卸载不清 document 监听**(P3,mouseup
  自愈):均 niche/P3,本批不展开。

## P1/P2 批次(第十一轮 — 独立复审:popout 消费方 / 终端同步竞态 / init 锁 / IPC 信任)

> 本轮由独立只读审计(多 agent + Claude 亲读验证)对前 10 轮已收敛的子系统做交叉复审,
> 修 4 条真实缺陷,DEFER 若干前瞻/低危项。一条 agent 报告(revoke 清 pending)经 Claude
> 亲读判定为**误报**(README 明确记录 "pending 不变(若正在弹窗,用户仍可决定)" 是刻意设计),
> 未采纳。

### P2-AC popout 判定消费方统一走 isPopoutUrl — `popout-consumers-use-helper.spec.ts`
- `agent-auth.service`(pickMainWindow + requestAgentAuth targetWin 校验)与
  `mcp-stdio-server.service`(fallback 选窗)三处仍用裸 `includes('popout=1')`,
  统一切到 topic-49 P2-E 新建的 `isPopoutUrl`。守卫:静态断言这些消费方不再出现裸子串。
- 根因: P2-E 建了精确判定 helper 并接入 index.ts,但**漏改了三个消费方**。普通主窗
  URL 含 `popout=1` 子串(workspace 路径 / 未编码 query)时被误判为 popout → 授权弹窗
  推到错误窗口 / MCP `tools/call` fallback 路由到错误 workspace 执行(真实副作用)。
  与 P2-E 同源 latent bug,只是 3 处遗漏。

### P2-AA TerminalSessionsSync 初始 hydration 不覆盖实时推送 — `terminal-sync-late-list-no-clobber.spec.tsx`
- `listSessions()`(请求/响应)与 `onSessionsChanged`(广播)两条独立路径可乱序到达。
  加 `sawPush` 标志:一旦收到任何实时推送,订阅即权威,丢弃迟到的初始 listSessions 结果。
- 根因: 旧实现两条路径都无序写 `replaceSnapshot`、无 gen 守卫。推送先到带新会话、初始
  listSessions 后 resolve 带旧快照 → 用旧快照覆盖 → 刚创建的终端从 tab 栏短暂消失
  (自愈于下次推送)。`update/reviews store` 早有 gen 守卫,此 hydration 路径漏了。

### P1-AB PluginManager.init() 激活走生命周期锁 — `plugin-manager/plugin-manager.spec.ts`
- `init()` 的激活循环旧实现直接调 `activateEntry` **不走** `withLifecycleLock`,改为
  `withLifecycleLock(entry.id, () => activateEntry(entry))`,与 enable/reload 一致。
- 根因: P1-Y(第九轮)给 enable/disable/reload/uninstall 加了 per-id 锁,但**漏了 init
  的激活路径**。`activateEntry` 在 `ensureAuthorized` 处 await 用户权限弹窗(可挂数秒),
  而 main-app 紧接 `void init()` 就接线 mtime watcher 的 `onChanged→reload`(走锁)。
  首启弹窗挂起期间被改动文件触发的 reload 拿到空锁并发执行 → 与 P1-Y 同源的 token 泄漏
  /双激活。回归测试经验证:去掉 init 锁 `regs-unregs` 从 1 变 2(泄漏一个 token)即 FAIL。

### P2-AD plugin-mcp INVOKE_REPLY 校验 senderFrame — `plugin-mcp-invoke-reply-trusted-frame.spec.ts`
- `ipcMain.on(INVOKE_REPLY)` 旧实现丢弃 `_event`、不校验 frame,补
  `defaultIsTrustedFrame(event.senderFrame)`,与同模块 REGISTER/UNREGISTER 对齐。
  顺带把 `window:id` 同步 IPC 也补上同款校验(P3 一致性,仅泄漏窗口 id 整数)。
- 根因: 不受信 frame(被注入的子 frame / 未来 iframe 插件隔离)可伪造 invoke-reply
  提前 resolve 挂起的 MCP invoke。随机 UUID requestId 是屏障,故低危,属防御纵深对齐。

### 本轮 DEFER / 误报留档
- **[误报] agent-auth revoke 不清 pending**:README + BDD 明确记录 "pending 不变
  (若正在弹窗,用户仍可决定)" 是刻意设计 —— revoke 只撤 session 授权,进行中的弹窗
  有意保留让用户自决(Modal 仍开、resolver 完好,无悬挂)。agent 误判,**未改**。
- **[DEFER] values-store 跨窗设置 last-writer-wins**:localStorage 单 blob read-modify-write,
  两窗同时改不同 key 会丢键。同 explorer 全局段 last-writer-wins(topic-49 已 DEFER)同类
  架构项,低频 + 便利数据可恢复,DEFER。
- **[前瞻] scope-decision 信任锚点绑请求方 webContents**:当前插件跑在宿主 renderer 进程内
  (与授权 UI 同 webContents + 真人点 prompt),**今天不可利用**。ADR-Plugin-5 插件真隔离
  (iframe/独立 webContents)落地前,须把决定来源改为受信宿主 frame,否则被隔离插件可拿
  自己 requestId 自批 scope。**记入隔离工作前置项**,非当前 bug。
- **[DEFER] mcp-host verifyBearer 常量时间校验是死代码**:生产走 `windowTokens.get`(非常量
  时间),带 `timingSafeEqual` 的 `verifyBearer` 仅定义+测试。256-bit token + 仅绑 127.0.0.1
  + Origin/Host 三重防线,localhost 计时攻击不现实,P2 卫生项 DEFER。
- **[DEFER] before-quit 与 per-window close 的 pendingFlushAcks 同窗 key 覆盖**:仅 Cmd+Q
  同时手动点窗口关闭按钮(≤1s flush 窗口内)才触发,无数据丢失,首个 flush 多等 ≤1s timeout
  自愈。极窄 + 无数据影响,按极简原则 DEFER。
- **[低置信] DockReconciler previousCustomTitlesRef 是 module 级单例**(应组件级):仅 DockShell
  remount 后 title 重对账,`setTitle` 幂等,无数据丢失,DEFER。

## 第十二轮(收敛轮 — 命令面板/keybindings/通知/主题/Explorer/SDK)

> 独立审计复审剩余较少触碰的表面。**未发现新的可修 P1/P2**:
> ThemeProvider、通知/toast(epoch+dedupe+cap+timer 清理)、keybindings(override 三态+
> 冲突检测+capture 拦截)、command-palette/quick-open 导航、Explorer 拖拽/重命名/剪贴板
> 部分成功刷新 —— 六大区域逐文件亲读确认闭环、干净。审计收敛。

- **[DEFER] useCommandHotkeys 无输入焦点守卫**(`src/plugins/command-palette/useCommandHotkeys.ts:41-44`):
  全局 keydown 命中即 `preventDefault` 后才调 `cmd.fn()`,而部分命令 fn 是条件 no-op
  (如 `mod+f` terminal.search.toggle 非 terminal 面板时 return)。理论上裸 `<input>`
  (重命名框)聚焦时按 `mod+f` 会吞键。**不修**,因:(1) Electron renderer 默认无原生
  find UI,被吞的"原生行为"实际无可见副作用,近乎理论;(2) 任何 blanket 焦点守卫都有
  真实回归风险 —— **xterm.js 用隐藏 `.xterm-helper-textarea` 捕获输入,守卫 `<textarea>`
  会让终端聚焦时 `mod+f`/`mod+t` 全失效**(正好是用户要按的时机),CodeMirror/Milkdown
  contentEditable 同理会断 `mod+b`/`mod+t` 全局键;正确行为是 per-key/per-context 判断,
  属需 GUI 跨 terminal/editor/input 验证的 UX 决策,非补丁。留档待独立 topic。
- **[可不修]** 专用面板热键(`mod+p`/`mod+shift+p`)与通用命令热键三 document 监听并存无去重:
  当前无内置命令占用这两键,仅插件注册同键才双触发,属插件治理/隔离范畴,非现存可复现 bug。
- **[by-design]** QuickOpen `close()` 刻意保留上次 results(注释明示"秒级再开还能看到");
  切 root 后 walk 完成前回车可能开旧 workspace 文件,属已声明取舍。

## 第十三轮(独立复审 — editor 保存 / explorer 展开 / marketplace 更新 / topic-48 注入)

> 多 agent 只读审计 + Claude 亲读验证,对 renderer 侧数据丢失/正确性表面做交叉复审。
> 修 4 条真实缺陷(1 P1 数据丢失 + 3 P2),DEFER 若干低危/理论项。

### P1-AE 关窗/退出 flush pending markdown autosave — `autosave-window-close-flush.spec.tsx`
- autosave scheduler 的 `flush()` 改为返回可 await 的 Promise;新 `autosave-flush-registry.ts`
  模块级 registry(镜像 explorer-persist 的 `activeFlush`),`useAutoSave` 注册当前 scheduler
  的 flush;DockShell `onFlushRequest` 在 ack 前 `await flushPendingAutoSave()`。
- 根因: 关窗走 main→renderer flush 握手,DockShell 只 flush 了 dockview layout +
  `flushExplorerPersistence()`(会话元数据),**漏了** pending 的 markdown autosave 内容 ——
  它卡在 useAutoSave 内部 scheduler 的 2s 防抖 timer 里,只在 React unmount cleanup 才 flush,
  而 `win.close()` 销毁 renderer 时 React cleanup 不保证执行(同第五轮 watcherPool 前提)。
  编辑 md 后 2s 内按 Cmd+W/Cmd+Q → 最后一段静默丢失(editor content 不持久化,重开即没)。
  第七轮 P1-S 只解决"切 tab/卸载",关窗是另一条独立路径。main 侧握手有 1000ms ack 超时兜底,
  await flush 不会让关窗永久挂起。

### P2-AF 切 root 保留前一 root 的展开状态 — `explorer-cross-root-expand-preserve.spec.tsx`
- `FolderTree.setExpandedItems` 旧实现 `setPersistedExpandedPaths(next)` 整体替换 store;
  改为保留 store 里 out-of-root 段,只更新 in-root 段(函数 updater 也喂 in-root 子集)。
- 根因: `expandedPaths` 是跨 root 共享的单一扁平 Set,headless-tree 只看到 `isWithinRoot`
  过滤后的 in-root 子集、回写也只给 in-root 数组。直接整体替换 → 切 root 到 B 后第一次
  折叠/展开即把 store 替换成 B-only,A 的展开从内存 + explorer.json 一并丢失,切回 A 全收起。
  且旧代码读整个 store 的 `current` 是死代码(headless-tree 从不传函数 updater)。

### P2-AG update-store 乐观摘除关闭重复更新点击窗口 — `update-store-dismiss-optimistic.spec.ts`
- update-store 加 `dismiss(id)`(no-op 时返回原引用不触发渲染);MarketplaceTab `onUpdate`
  成功后立即 `dismissUpdate(entry.id)` 让更新按钮即时收起,再 `void refreshUpdates()` 对账。
- 根因: 更新按钮显示 `installed && updateAvailable && !pendingRestart`。in-place 更新成功后
  只异步 `refreshUpdates()`,在它完成前 `updateByPid` 仍含旧版本 → 按钮继续可点 → 用户可对
  已是最新版的插件重复点击触发二次 overwrite 安装(多一次 clone + staging swap)。`pending.add`
  对 in-place 更新语义不适用(`installed=true` 使 pendingRestart 恒 false,该 add 对更新无效果)。

### P2-AH topic-48 `__continuoMeta` 类型契约对齐 null(类型修正,无行为变更)
- `src/spikes/plugin-isolation/index.ts` 的 renderer global 声明 `appIsPackaged?: boolean`
  → `boolean | null`,与 preload 实际暴露的 `boolean | null` 三态对齐。
- 根因: preload 在参数缺失/畸形时暴露 `null`(unknown),renderer 类型却只声明 `boolean`,
  类型撒谎。当前唯一 consumer 用 `?? null` 侥幸正确,但未来 consumer 若写 `=== false` 判定
  "非打包"会把 null(unknown)坍缩成 false —— 正是 README v2-C 要避免的退化。纯类型对齐。

### 本轮 DEFER / 误报留档
- **[DEFER] autosave 写盘失败仅 console.warn 不通知**(`auto-save.ts:28-31`):`markSaved` 未执行
  → tab 保持 dirty,脏标记仍在有视觉信号;显式 Cmd+S 才 `notify.error`。体验项非静默丢失,DEFER。
- **[理论 P3] saveFile await 期间文件被重命名 → markSaved(旧id) no-op + 写回旧路径**:触发窗口
  极窄(毫秒级 autosave 写盘窗口内于 Explorer 完成重命名),几乎不可复现,DEFER。
- **[P3] expandedPaths 不剪枝改名/移动/删除的旧路径**:`watchDir` 失败被吞、缓慢泄漏非可见
  数据丢失,DEFER。
- **[P3] reviews-store 手动刷新失败 UI 不渲染 error**:多数路径有缓存兜底,体验/可观测性项,DEFER。
- **[P3] update-store available 与 reload 后 manifest 的固有时序**:dismiss 已覆盖常见路径,
  refresh-before-reload 的短暂 stale 可自愈,不扩 scope 解 manifest reload 排序,DEFER。
- **[误报] topic-48 注入时序/argv 注入/popout 一致性**:additionalArguments 全由 main 控制,
  untrusted workspace 路径走 URL query 非 argv,注入时序在 app-ready 后稳定,经亲读确认无缺陷。

### P1-AI before-quit 始终强杀 PTY(关最后一个窗口触发的 quit 也跑 cleanupAll)
- 见上文「第十三轮」补充。`electron/main/index.ts` `before-quit` 旧实现用
  `wins.every(flushedOnQuit)` 兼当守卫:关掉最后一个窗口触发的 `window-all-closed→app.quit()`
  路径里 `wins` 已空,`[].every()` 恒 true → 提前 return **跳过 `termService.cleanupAll()`**。
  window 'closed' 清理走 3s grace timer,进程退出不触发 SIGKILL → Linux/Windows 上忽略
  SIGINT 的长任务子进程(agent/node)被孤儿化。改用独立 `quitCleanupStarted` 守卫:无论
  哪条 quit 路径,`cleanupAll()` 都在 `app.quit()` 前 await 一次(重入 before-quit 直接放行)。
  macOS 不受影响(window-all-closed 不 quit,grace timer 正常 fire)。Electron app 生命周期
  改动,靠逻辑审计 + 全量 suite 回归,不单测。

### 第十三轮第二批 DEFER / 误报留档
- **[误报] requestAgentAuth 选窗到 send 间窗口被销毁挂 5min**:`requestAgentAuth` 从选窗
  (`isDestroyed` 校验)到 `win.webContents.send` 是**同步执行**(`new Promise` executor 同步跑、
  send 前无 await),同一 tick 内 Electron 单线程不会中途销毁窗口,无 async gap = 无竞态。
  agent 假设了不存在的 await 间隙,经亲读否决,**未改**。
- **[DEFER 窄竞态] installFromGit(overwrite) 与 uninstallPlugin 同 id 在 service 层未互斥**:
  `uninstallPlugin` 不走 `withInstallLock`,理论上 uninstall 的 `rm -rf targetDir` 可插进
  install 的 `rename(target→backup)`/`rename(staging→target)` 之间致目录半态。但单窗 UI 串行
  触发、需跨窗或自动化并发同 id install+uninstall 才可达,且确定性回归测试需更深 fs 注入
  seam(锁覆盖的 swap 段无现成 gate)。按「无对应测试不硬改业务逻辑」+ 同类窄竞态一贯 DEFER
  的惯例留档(修法:uninstallPlugin 的 fs 段包进 `withInstallLock(id, ...)`)。
- **[P3] installFromGit 中 `cp` 失败留半个 `.installing-` staging 目录**:`.` 前缀 + randomUUID
  后缀,listPluginDirs/watcher 都跳过,仅占盘不影响功能,同 trash 泄漏类 DEFER。
- **[已撤回] hook broker inFlight 泄漏 / cleanupStale 误删 / stdio broadcast socketCtx 残留**:
  三条候选经亲读复核均不成立(finally 兜住 inFlight / TTL 删是预期 / close 事件兜底 socketCtx),
  agent 自己也在报告里逐条撤回。

## 第十四轮(独立复审 — 文件原子写 / 插件 shell stream / ribbon / shell.service)

> 多 agent 只读审计 + Claude 亲读验证,对前 13 轮 + 第十三轮未深挖的 renderer 写路径、
> 插件 shell 流、shell.service 超时清理做交叉复审。修 5 条(1 P1 数据丢失 + 4 P2),
> DEFER 2 条(1 窄竞态 + 1 Windows-only 不可验证),否决 0(本轮 agent 候选均成立或自撤)。

### P1-AL fs:writeFile 原子写用唯一 tmp 名 — `atomic-write-concurrent-same-path.spec.ts`
- `electron/main/ipc/fs/atomic-write.ts` 旧用固定 `${filePath}.tmp`,改为同目录 + 隐藏点前缀 +
  `pid·随机` 后缀(镜像 `electron/main/lib/atomic-write.ts` 的 `atomicWriteJson`)。
- 根因: 固定 tmp 名让同一路径的并发写(autosave 连发 / 手动 Cmd+S 与 autosave 重叠 /
  多窗或插件同写一文件)共享同一 tmp:互相 `open('w')` 截断 → 落盘半截文件;或 A `rename`
  后 B `rename` 撞 ENOENT → B 的写整段丢失且抛错。`fs:writeFile`/`fs:writeBinary` 又不像
  explorer.json 那样走 mutex 串行化。唯一 tmp 后各写各的、rename 原子替换 = 干净的
  last-writer-wins,绝不半截、绝不丢写报错。项目自己另一处 atomic-write 早用唯一名,
  renderer 写路径是漏网的劣化版。

### P2-AM 插件 shell stream 提前 break 触发 ABORT — `shell-stream-start-reject.spec.ts` + `scoped-app-shell-stream-early-break.spec.ts`
- `app.shell.execStream` 的 chunks 异步迭代器(scoped-app 外层 + preload 内层)旧实现都只有
  `next()` 没 `return()`。补:内层 `return()` invoke ABORT + 摘 EVENT listener + 收敛 done;
  外层 `return()` 委托内层。
- 根因: 插件 `for await(chunks){ break }` 时 JS 调 `iterator.return()`,缺这个钩子 → 永不发
  ABORT → 主进程子进程挂到 timeout(最长 30min)、preload handler 驻留、chunkQueue 无界堆积。
  「读够就 break」是自然写法,会累积孤儿进程。

### P2-AN scoped-app done 急切 reject 不再成 unhandledrejection — `scoped-app-shell-stream-early-break.spec.ts`
- `done = start().then(...)` 急切求值,缺 shell 权限时 `ensurePerm` 立即 reject。给 done 挂
  no-op `.catch` 标记 handled —— 但真实 `await done` 仍能看到 reject(catch 不吞,只防 unhandled)。
- 根因: 插件只迭代 chunks(合法,chunks 路径会抛同一错误给 for-await)而从不引用 done 时,
  这个急切 reject 无人处理 → renderer unhandledrejection 噪声 / 误报到崩溃遥测。

### P2-AO IconSidebar ribbon 异步 onClick 错误弹 toast — `icon-sidebar/icon-sidebar.spec.tsx`
- `onClick={() => void r.onClick()}` 旧实现吞掉插件 onClick 的同步 throw / async reject。改为
  同步调用(保持既有时序)+ try/catch + `.catch` 两类错误都 `notify.error`。
- 根因: ribbon onClick 契约允许返 Promise,插件内部抛错时用户点了没反应 + unhandledrejection,
  无任何反馈。

### P2-AP shell.service SIGKILL grace timer 清理闭环 —(逻辑审计 + 全量回归,无外部行为变更)
- 内层 `setTimeout(SIGKILL)` 旧实现不存句柄、不在 `close`/`error` 清。改为存 `killTimer` +
  `clearTimers()` 统一清 + `unref()` 兜底。
- 根因: 进程在 grace 期内正常退出(常态)后,这个 timer 仍挂 `SIGKILL_GRACE_MS`,闭包持
  `child` 引用阻止 GC + 让 event loop 多活一截。fire 时 `!exited` 为假只是 no-op,但资源
  未闭环。无外部行为变更(SIGKILL 本就 no-op),同 P2-G/P1-AI 类内部清理,靠逻辑审计 +
  全量 suite 回归(超时/SIGKILL 路径既有测试保持绿)。

### 第十四轮 DEFER 留档
- **[DEFER 窄竞态] installFromGit(overwrite) vs uninstallPlugin 同 id 未互斥**:见第十三轮第二批
  留档(同一条,本轮另一 agent 复现)。修法:uninstall 的 fs 段包进 `withInstallLock`。
- **[DEFER Windows-only 不可验证] watch 回调 `${rootPath}/${subdir}` 未归一 rootPath**:
  `fs.ipc.ts:171-176` 只把 filename 反斜杠归一,rootPath 没归一 → Windows recursive 下产出
  混合分隔符路径(`C:\proj/sub`),可能与 renderer 树节点 key 不一致致深层子目录变更不刷新。
  但仅 Windows + recursive 可达,且修法方向取决于 renderer 节点 key 的归一策略(backslash vs
  forward-slash),darwin 上无法验证或测试,盲改 watch 广播匹配逻辑有引入回归风险。留档:
  若约定是 forward-slash(line 171 归一 filename 已暗示此意图),则一并归一 rootPath 即可。

## 第十五轮(独立复审 — editor React/同步层 + dock/持久化 hydration)

> 两个独立 agent 分审。**dock/布局/持久化 hydration 层确认收敛**(未发现新可复现 P1/P2;
> terminal-在场整份弃 layout 是 T7b 刻意设计、reconciler 二次 remove 幂等 P3、closed phantom
> 空段无害 —— 均亲读确认非新缺陷)。editor 同步层修 1 条 P2,其余 3 条 DEFER。

### P2-AQ CodeEditor 外部 reload 保留光标/选区 — `code-editor-external-reload-keeps-cursor.spec.tsx`
- value-sync effect 全文替换旧实现不带 selection,改为把旧 selection clamp 到新长度后随
  dispatch 一并提交(scrollIntoView 默认 false 不拽滚动)。
- 根因: 外部进程改盘 → reloadFromDisk 更新 content → CodeEditor 用 `dispatch({changes:
  {from:0,to:doc.length,insert}})` 整篇替换,CodeMirror 不带 selection 时把光标甩到文档边界。
  用户在 .js/.json 或 markdown Source 模式文件中部阅读/定位时被外部修改打断会跳回顶部。
  Milkdown 走 epoch-remount 是有意设计,CodeEditor 这条就地 dispatch 路径漏了 selection 保持。

### 第十五轮 DEFER 留档
- **[DEFER 功能级] 外部删除/移动已打开的 clean tab 文件 → tab 留陈旧内容无提示,再保存复活
  已删文件**:`useExternalFileSync.ts:31-34` readFile `!r.ok` 直接 return(刻意,避免外部
  atomic save 的瞬时 ENOENT 误判)。稳健修复需「orphaned tab」UX(如何显示已删状态/保存语义)
  + 重试逻辑区分永久删除 vs 瞬时不可读,否则外部 delete-then-write 编辑器会误报刷屏。属功能级
  改动而非补丁(同「二进制文件打开」DEFER 类),且无用户数据丢失(VSCode 同样保留 tab + 保存
  重建,只是有 deleted 标记),留档待独立 topic。
- **[DEFER 平台相关] `useExternalFileSync` dirname vs watcher 广播路径裸字符串相等**:
  `dirname(tab.filePath) !== changedDir`(line 28)对跨进程路径用精确字符串比较,尾斜杠/`.`段/
  分隔符规范化差异即失配 → 外部同步静默失效。与第十四轮 watch rootPath 未归一(P2-B)同源,
  能否复现依赖具体 OS watcher 给出的相对路径形态,darwin 无法验证,同批 DEFER。
- **[DEFER 极窄时序] 多 md tab 重叠 pending autosave 时关窗只 await 活跃 tab**:
  `autosave-flush-registry` 是 per-renderer 单槽。但 useAutoSave 是单 scheduler 架构(同一时刻
  仅一个 live scheduler,切 tab 时旧 scheduler 的 cleanup 已 `void flush()` 落盘),single-slot
  对此架构正确。残留窗口=切 tab 后立即关窗、且切走时 fire-and-forget 的 writeFile IPC 未达
  main —— 亚毫秒级,且 main 侧写通常已完成(IPC 已送达即处理),留档 DEFER。

## 第十六轮(独立复审 — SDK registries/co-app + terminal service/hooks)

> 两个独立 agent 分审。修 2 条(1 P1 renderer 崩溃 + 1 P2 泄漏),最大候选(SDK registry
> 直通)归 ADR-Plugin-5 隔离工作 DEFER。

### P1-AR readHistory replay 卸载后不写已 dispose 的 xterm — `terminal-readhistory-after-unmount.spec.ts`
- `useTerminal` 的 `readHistory(termId).then()` 回调加 init 作用域 `teardownDone` 守卫
  (cleanup 置位),拦下卸载后的 safeWrite。
- 根因: 该回调缺 teardown 守卫(同文件 onData/searchResults 都有 mountedRef 守卫,唯独
  这条 replay 漏了)。mount 后异步 readHistory 在 resolve 前 panel 卸载(dockview lazy-mount
  inactive panel 快速关 / 切 workspace / StrictMode 双 mount / 慢盘)→ cleanup 已
  `disposeQueue(term)+term.dispose()`,迟到的 `.then()` 仍 `safeWrite(term,...)`。更糟:
  disposeQueue 删了 WeakMap 条目,迟到的 safeWrite→getQueue 新建一个 disposed:false 队列
  绕过 safeWrite 自身的 disposed 守卫 → `term.write()` 到已拆除的 core,报 "Object has been
  disposed"。**mountedRef 不够**:StrictMode 第二次 mount 把它重置回 true,让第一次 mount
  的迟到 readHistory 误判仍挂载 → 用 init 作用域标志。

### P2-AS removeByOwner 清理 titleCounter 防泄漏 — `terminal-sessions-title-counter-cleanup.spec.ts`
- `removeByOwner` 在 early-return 之前 `titleCounter.delete(ownerWindowId)`。
- 根因: 每窗建终端时 `nextDefaultTitle` 在 titleCounter 写 windowId→n,窗口关闭走
  removeByOwner 旧实现只删 sessions、不删 titleCounter。BrowserWindow.id 单调不复用 →
  反复开关窗口该 Map 永久增长。量级可忽略但确为未清理项。

### 第十六轮 DEFER 留档
- **[DEFER → ADR-Plugin-5] scoped-app 直通 raw 贡献点 registry(panels/commands/ribbon/...
  共 10 个)**:`scoped-app.ts:384` `...rest` 把这些共享单例 registry 原样暴露(line 372
  文档化的当前架构)。两面问题同根:(1) 插件直接 `app.commands.register()`(绕过
  `this.addCommand()` 的 Plugin.disposables 跟踪)→ disable/reload 不清理 → 泄漏;
  (2) 插件可读写/枚举全局贡献表 + `app.events.emit` 伪造事件 → 跨插件越权。正确修法
  (per-plugin 包裹全部 registry + 自动 dispose 跟踪,mirror fs/dock/mcp 的 scope wrapper)
  是 ADR-Plugin-5 真隔离的核心工作,与已留档的「scope-decision 信任锚点」「(b) 拓扑共享
  webContents」同属隔离前置项。打磨阶段不做大重构,归入隔离 topic。
- **[DEFER → ADR-Plugin-5] dock.openPanel 无 pluginId 作用域**:插件可 openPanel 他插件的
  面板 type。同上跨插件隔离类,归隔离工作。
- **[DEFER 理论 µs 竞态] PluginMcpRegistry dispose→立即重注册同名跨通道乱序**:本地
  `entries.delete` 同步、`upstream.unregister` fire-and-forget 与新 register 是两条 IPC 通道,
  到 main 顺序无保证,unregister 后到会删掉刚注册的新 tool。需 µs 级 dispose+register 交错,
  随机 requestId 非屏障但场景极窄,DEFER。
- **[DEFER 仅测试] terminal.service `__resetForTest` 不清挂起 timer**:只清 instances Map,
  不 clear throttleInterval/flushTimer/killTimer,孤儿定时器仅影响测试隔离/泄漏 baseline,
  非用户面,DEFER(修法:遍历 instances 先清 timer 再 clear)。
- **[DEFER 低危] 插件 disable/uninstall 时已开面板成孤儿**:`PanelRegistry.dispose` 删 spec,
  但 dockview 中已开的同 type panel 不被关闭、渲染未知 component。属 DockShell↔registry 清理
  联动缺失,归 ADR-Plugin-5 隔离/生命周期工作。

## 第十七轮(独立复审 — mcp invoke 桥接/agent-auth 接线 + fs watcher/设置)

> 两个独立 agent 分审。**plugin-mcp invoke 桥接侧确认收敛**(pending timeout/reply 路由/
> abortByWebContents/reload 清理/INVOKE_REPLY trusted-frame 都已严密)。修 1 条 P2,DEFER 2 条。

### P2-AT 目标窗口关闭立即结算 agent-auth pending — `agent-auth-cancel-by-window.spec.ts`
- `requestAgentAuth` 的 `pending` 改存目标 windowId;新 `cancelAgentAuthByWindow(windowId)`
  把发往该窗口的 pending 全部立即结算为 denied;`index.ts` `win.on('closed')` 调用之。
- 根因: pending 取消路径只有 5min 定时器,窗口 closed 不提前结算。发起调用的是**仍存活的
  外部 agent CLI 进程**,用户关窗后它要干等满 PROMPT_TIMEOUT_MS(5min)才收到默认 denied,
  表现为 agent 假死。这与已 DEFER 的 request-scope「等待者是已死请求方自己」**不同** ——
  这里等待者是活的外部进程,DEFER 免责理由不成立。镜像 stop-hook broker.cancelByWindow(#3)。
  (顺带:close-flush.spec.ts 的 agent-auth mock 补 `cancelAgentAuthByWindow` stub。)

### 第十七轮 DEFER 留档
- **[DEFER 需 IPC 协议] watchDir 被 LRU 驱逐后 renderer 账本 stale → 最早目录永久失去实时刷新**:
  展开 >64 目录时 main 侧 LRU 强关最早的 watcher,但 `watchDir` 是 void fire-and-forget、
  无驱逐回报 → renderer `prevPathsRef` 仍记为已 watch → 该目录变更不再推送(永不刷新)+ 折叠
  时 `unwatchDir` 对不存在的 watcher 静默吞掉 + 永不重 watch。与已 DEFER 的「LRU 强关是既定
  取舍」相邻但补充了具体后果链。正确修法需新增 `fs:watch-evicted` main→renderer 推送 + renderer
  剔除被驱逐 path,且重 watch 会 churn 另一目录(根因是 MAX_WATCHERS=64 对大 monorepo 偏小),
  属需设计的协议级改动,非补丁。需 >64 同时展开目录方可达,DEFER。
- **[DEFER dev-only] values-store 模块级匿名 storage 监听器无清理,HMR 下叠加**:
  `values-store.ts` 顶层 `window.addEventListener('storage', ...)` 匿名注册、无 ref 无 remove。
  生产 single-shot 无害;dev/HMR 每次热替换重新求值模块 → 叠加新监听器 + 泄漏旧闭包,一个
  storage 事件触发 N 次 setState(功能仍正确)。仅 dev 可感知,DEFER(修法:具名 listener +
  `import.meta.hot.dispose` 清理)。
- **[已撤回] useFsWatcher debounce use-after-unmount / co-api Proxy trap 一次性 claim 副作用**:
  agent 自己复核后撤回(cancel 已覆盖单卸载、当前启动顺序保证 capture 先行)。

## 第十八轮(收敛轮 — 自审回归 + 剩余 UI 表面)

> 两个 agent:一个对抗性 re-read 本 session 第 13-17 轮我引入的 12 处改动找回归,
> 一个扫剩余 UI 表面。自审确认 11 处无回归(对抗边界 TDZ / null 通配 / 闭包独立性 / 单槽
> 切换时序 / done.catch 不吞 reject / 反向选区 clamp 均正确),揪出 **1 处我引入的回归**;
> UI 扫描揪出 **1 条 P1**(安全语义)。两条都已修。

### P1-AL 修订 atomic-write 改 per-path 串行化 + 固定 tmp 名(消除自审揪出的孤儿 .tmp 回归)
- 第十四轮为修并发把 tmp 名改唯一,但**第十八轮自审**发现唯一名 crash 在 fsync→rename 窗口
  残留的 `.tmp` 带随机后缀、永不复用、无清扫 → 单调累积孤儿(旧固定名只留 1 个、下次写复用
  自愈)。改为 **per-path Promise 链锁串行化 + 固定 `${path}.tmp`**:同路径写排队各自完整
  rename(消除并发损坏),固定名让 crash 残留自愈不累积。writeChains 链排空删条目防 map 泄漏。
  回归测试新增「孤儿 .tmp 被下次写复用不累积」。

### P1-AU design/Modal 叠加时 Esc 只关栈顶 — `modal-stacked-esc-top-only.spec.tsx`
- `src/design/Modal.tsx`(Nous 共享层,加 Continuo-local 注释 + 待推回上游)加模块级
  `modalKeyStack`,键盘(Esc/Tab)只由栈顶(最后打开)Modal 处理。
- 根因: 每个 Modal 实例都在 document 挂独立 keydown 监听,叠加时单次 Esc 触发**所有**打开
  Modal 的 onClose。Continuo 里 CommandPalette/QuickOpen 开着时 agent 推来的 AgentAuthPrompt
  (onClose=deny)/ PermissionPrompt(onClose=denyAll)会被这次 Esc **静默拒绝** —— 安全决策
  被误触发、agent 操作失败且用户不知情。P1(安全语义 + 无 top-most 收敛)。

### 自审确认无回归(11 处)
- agent-auth pending 存的是实际挂弹窗的窗口(pickMainWindow 兜底后的 win.id);isActive gate
  不误伤 HMR(reload 每次新 token);matchesFilter null fail-closed(filter.windowId 类型恒
  非 null);shell.service clearTimers 无 TDZ(只在异步回调调)+ unref 不漏发 SIGKILL;
  removeByOwner titleCounter 在 early-return 前删;iterator return()/done.catch 语义正确;
  autosave 单槽切 tab 时序正确;FolderTree updater 喂 inRootCurrent + deps 含 root;
  useTerminal teardownDone 闭包各 init 独立;CodeEditor clamp 反向选区/readonly 均正确。

### 第十八轮 DEFER 留档
- **[DEFER 窄/无障碍] Modal 焦点陷阱 activeElement 落在 content 外时不回收焦点**:Tab 只在
  first/last 边界回绕,active 既非 first 非 last(在 modal 外)时不 preventDefault → 焦点逃出。
  需打开瞬间焦点被移到 content 外方触发,条件性可复现,top-most 栈已部分缓解(背景 Modal 不
  处理 Tab),DEFER。
- **[DEFER 已知同类] StatusBar Copy MCP 复位 setTimeout 无清理/无 token(双击闪烁 + 卸载
  setState)**:与第八轮已 DEFER 的「StatusBar MCP copy 反馈 setTimeout 不跟踪」同一条,
  纯 UI 反馈瑕疵无数据后果,维持 DEFER。
- **[DEFER 实际无害] before-quit 不逐窗 cancelAgentAuthByWindow**:Cmd+Q 时 mcpHost.close()
  会断开 MCP 连接,外部 agent 的调用随连接关闭而出错(非干等),且进程整体退出,无害,DEFER。

## 第十九轮(收敛轮 — MCP host token + window-restore/启动)

> 两个 agent 分审。修 1 条清晰 P2;**否决 1 条误报**(亲读验证发现与既有命名契约矛盾 = 刻意
> 设计);1 条 P1 因属已记录/已测的防御性行为 + 产品语义问题 DEFER;其余平台/理论项 DEFER。

### P2-AW prepareShellIntegrationEnv 失败时撤销已签发 mcpToken — `migration-step1-pty-handover/create-failure-rollback.spec.ts`
- `terminal.service.createTerminal` 把 `prepareShellIntegrationEnv` 包进 try,失败时撤销
  `meta.mcpToken`。
- 根因: `prepareShellIntegrationEnv`(写 shell integration 脚本,磁盘满/权限/ENOENT 时抛)在
  PHASE 1 try **之外**,失败绕过 sm.create 的 rollback。此时 mcpToken 已在 ipc 层签发注入
  windowTokens,但绕过撤销 → 孤儿 token 留存(授予该窗 MCP 访问直到关窗)+ map 增长。安全
  影响有限(token 未注入任何存活进程),但属真实 cleanup 遗漏。

### 第十九轮 误报 / DEFER 留档
- **[误报,已否决+回滚] 拖文件夹/dock/CLI/恢复的 workspace 不进 recentRoots**:agent 报
  hydrateStores/hydrateStoresForNewWindow 走 setState 绕过 setRoot 的 recentRoots LRU。但**亲读
  验证**发现这与多条**命名测试契约**直接矛盾:`persistence-layer` "新窗 → recentRoots 仍读全局段"、
  cold-start-drag-folder 断言拖入 folder 不进 recentRoots、`workspace-store-empty-string` T31
  "hydrateStores filters empty recentRoots"(断言 root `/work` **不**被加入)。即**刻意设计** ——
  hydrate/拖/dock/CLI/恢复 打开只设 root、不污染共享 recentRoots LRU,仅显式 setRoot(header 选择)
  才加入。改动会破 6 个既有测试。**已完整回滚**(改回 explorer-persist + workspace.store + 删测试)。
  方法论印证:agent 发现须经 Claude 亲读验证,与既有命名契约矛盾的"修复"是误报。
- **[DEFER 产品语义] revokeAndKillAgentSessions 的 rotateToken 全局清空 windowTokens**:"终止全部
  agent terminal" 按钮调 rotateToken → `windowTokens.clear()` 作废**所有**窗口 token(含 user
  终端 + 其它窗口 agent),而 kill 循环只杀 originHint='agent' 的 PTY → user 终端里手动跑的
  claude/codex 下次 MCP 调用 401。但:(1) `rotateToken` 被 README T11 显式记录 + 测试覆盖(行为
  契约),"never touches user sessions" 可解读为 PTY 层(实现确实不杀 user PTY);(2) 是否全局
  rotate 是「安全 panic 按钮」的防御纵深 vs 精确撤销,属**产品语义决策**,非清晰 bug。token 是
  per-terminal 的(issueWindowToken 每次新签),且 forceKill→cleanupSessionLocal 已撤被杀 agent
  的 token,故全局 rotate 对 agent 是冗余、对 user 是过度。留档待产品定夺,不擅改已测契约。
- **[DEFER 平台] Windows/Linux second-instance argv 文件夹被丢弃**:运行中拖文件夹/CLI 打开走
  `second-instance` 回调,旧实现只查 `co://` URL、不喂 argv 给 pickArgvFolders → 文件夹不打开。
  冷启动有 pickArgvFolders 覆盖,热启动漏(与 macOS open-file 不对称)。需 packaging 加 folder
  file-association 才实际可达,平台特定 darwin 无法验证,DEFER。
- **[DEFER 理论] open-file 在 whenReady await 期间到达 → 多开一窗**:app.isReady()=true 但
  pendingOpenPaths 尚未 splice 的窗口期,无 seq 冲突/无数据丢失,仅 UX 抖动,难复现,DEFER。
- **[DEFER 理论] HTTP verifyAndResolveCtx 不校验窗口存活(与 stdio 路径不对称)**:窗口 destroy
  到 closed 清理之间亚毫秒竞态,需用户授权,影响有限,DEFER。

## 第二十轮(完整性批判 — 收敛确认)

> 独立 completeness-critic agent 系统性扫描审计列表**之外**的所有子系统:网络/fetcher
> (index/manifest/reviews GraphQL 拉取 + 缓存 TTL + 离线退守)、co:// 协议 + 拖拽 + open-file/url、
> persistence v1→v3 迁移 + loadExplorer 损坏保留 + allocateWindowSeq mutex、install/uninstall
> 原子 swap + manifest zod 校验 + IpcPermissionStore、watch 池 LRU/refcount、safe-handle
> frame-trust、fs move/copy/remove/trash sweep。
>
> **结论:未发现新的清晰可修 P1/P2 缺陷,审计已收敛。** 剩余锐边全部落入三类已声明排除:
> 已覆盖 / 已声明 DEFER / 理论 µs 竞态(move-copy TOCTOU、sweepStaleTrashAtStartup v0.1 no-op、
> writeEnabledIds 非原子但注释明确不投资、co:// dispatch 全窗是多窗产品语义、sandbox-sweep
> same-realm 局限属 ADR-Plugin-5 隔离)。

---

## 打磨阶段总览(第十三~二十轮,本 session)

7 轮独立审计(多 agent 只读 + Claude 亲读验证)+ 1 轮对抗性自审 + 1 轮完整性批判。修 **19 条**
真实 P1/P2(数据丢失 / 资源泄漏 / 安全边界 / 未闭环),每条先写本目录可执行规范再改实现;
另修 1 条**自审揪出的自引入回归**(atomic-write 唯一 tmp 名 → 改 per-path 串行化)。
test 2896 → 2932。可修缺陷产出逐轮收敛(7→5→1→2→1→2→1→0),第十九轮起出现误报(recentRoots,
经亲读验证与命名契约矛盾,已回滚)+ 产品语义 DEFER(rotateToken),第二十轮完整性批判确认收敛。

**方法论印证**:agent 只读审计必须经 Claude 亲读验证 —— 本 session 否决多条误报(P2-C
requestAgentAuth 假 async gap、P2-AV recentRoots 与既有命名契约矛盾、hook broker 三条 agent 自撤),
关键修复用"删 fix 证 spec FAIL"+ 对抗性自审(11/12 改动确认无回归 + 揪出 1 自引入回归)收敛。

---

## 第二十一轮(新 session 复审 — "未闭环"专项视角)

> 新 session 对 continuo-meta 注入 / renderer hooks / 主进程 services+IPC 三块做独立复核
> (均确认前 20 轮收敛仍成立、无新可修 P1/P2),随后换"未闭环"专项视角(按了没反应的
> 动作 / 静默吞错让用户卡死)扫整个 renderer,揪出**一类跨多调用点的反馈缺口**:贡献式
> action 与核心文件操作的失败被静默吞掉,用户"点了没反应"。注意区分:第十四轮 P2-AO 只修了
> `IconSidebar` ribbon 一处,未传播到兄弟调用点;destructive 文件操作(trash/paste/move/
> terminal)前序已有 `notify.error`,本轮只补真正还缺失的几处。

### P1-AX 贡献式 action 抛错统一弹 toast — `contributed-action-error-surfaced.spec.ts`
- 新建共享 helper `src/lib/run-contributed-action.ts`:`runContributedAction(label, fn)` 把
  同步 throw 与 async reject 都捕获经 `notify.error` 弹给用户(`notify.error` 默认 mirror=true
  → 同时 console.error,保留诊断输出)。
- 4 个调用点收敛到此 helper:`IconSidebar` ribbon(原内联实现重构)、`EditorHeader` 编辑器
  action 两个按钮(原 `void a.fn()` **连 console 都没有**)、`CommandPalette` execute(原只
  `console.warn`,面板已关用户看不到)、Explorer `ContextMenu` 插件项(原只 `console.warn`)。
- Quick Open 打开文件失败(`QuickOpenModal.openFile`)+ Explorer 点击文件打开失败
  (`FolderTree` onOpenFile,Explorer 主操作)也补 `notify.error`(原只 `console.warn`)。
  新增 i18n key `quick_open.open_failed`(en/zh/ko)。
- 根因: 这些调用点曾各自 `void fn()` 或只 `console.warn` —— 插件/命令内部抛错时用户"点了
  没反应",没有任何可感知反馈。

### P1-AY Quick Open 扫描失败 ≠ 空 workspace — `quick-open-scan-failed-distinct.spec.tsx`
- `walkWorkspaceFiles` 失败(ok=false 或抛异常)时置 store `scanFailed` 标志,UI 显式显示
  「扫描工作区文件失败」+「重试」按钮,而非伪装成「工作区无文件」。重试经 `reloadToken`
  递增重跑 effect;恢复成功后清 `scanFailed` 显示结果。
- 新增 store 字段 `scanFailed` + `setScanFailed` + i18n key `quick_open.scan_failed` /
  `quick_open.retry`(en/zh/ko)。修既有 `quick-open-modal` spec 的 beforeEach 补 `scanFailed`
  reset 防跨测试泄漏。
- 根因: 旧实现 walk 失败只 `console.warn` + `setResults([])` → UI 渲染「无文件」,与真空
  workspace 不可区分,且无重试入口 → 用户以为工作区空,放弃(静默失败伪装成空 = 死胡同)。

### P1-AZ auto-save 失败给反馈(去重)— `autosave-failure-notified-once.spec.ts`
- `makeAutoSaveScheduler` 加可选 `onError` 钩子,**去重**:仅在 ok→fail 跃迁时触发一次
  (防 2s 防抖反复失败刷屏),一次成功后重置。`useAutoSave` 接 `notify.warn`(mirror:false,
  scheduler 已 console.warn 防双写)+ i18n key `editor.autosave_failed`(en/zh/ko)。
- 数据**不丢**(`markSaved` 仅写盘成功才清 dirty,既有契约不变),onError 仅补"为何脏点
  不消"的反馈。向后兼容:不传 onError 时失败仍 swallow 不抛。
- 根因: Markdown 2s 防抖自动保存失败只 `console.warn`,与手动 Cmd+S(已 `notify.error`)
  不一致 → 后台静默失败用户无从知晓,可无限期卡在脏态。

### 第二十一轮复审确认无新缺陷的子系统(非缺陷)
- continuo-meta 注入(main `additionalArguments` 工厂 + preload 严格全等解析退守 null 三态 +
  `__continuoMeta` Object.freeze 暴露面非机密):攻击面窄、无建窗旁路、与 argv 消费方无串扰。
- renderer hooks 生命周期:effect 清理 / use-after-unmount 守卫 / 闭包陈旧值 / 竞态数据丢失
  全部已闭环(20 轮收敛仍成立)。
- 主进程 services+IPC 错误路径:terminal.service 三段回滚(含第十九轮 P2-AW)、cleanupSession
  flush 顺序、shell SIGKILL 升级、stdio close destroy、hook-bridge waiter 三路径清理、
  atomic-write per-path 串行化均正确。
- destructive 文件操作(trash/paste/move/root-drop/open-in-terminal)+ WindowPlugin
  (window.new/openFolderInNew create)前序已有 `notify.error`,无需补(仅极罕见的 clipboard
  copy / reveal / 文件夹 picker 打开失败保留 console.warn,非破坏性低频便利操作,可接受)。

---

## 第二十二轮(收敛确认轮 — settings/keybindings/dock/marketplace 补扫)

> 独立 agent 扫前 20 轮覆盖较少的区域(settings / keybindings / dock 持久化 / marketplace
> 流程 / PluginManager UI 接线 / theme / stores),用"未闭环 + 状态一致性"双视角。捞出 3 条
> 真实可修缺陷(均经 Claude 亲读验证),其余区域读确认收敛。

### P2-BA keybindings 跨窗口 storage 同步 — `keybindings-cross-window-sync.spec.ts`
- `keybindings-store.ts` 加模块级 `storage` 事件监听:别窗改 `localStorage` 同 key 时重读
  `overrides`,让各窗收敛一致。镜像 `values-store` 第十一轮 P2-CC 的同款修复。
- 根因: overrides 用 localStorage 持久化但 zustand 内存只在本窗启动读一次 → 多窗下窗口 A
  改/解绑快捷键后,窗口 B 仍按旧绑定派发键盘(`useCommandHotkeys` 读 `getEffectiveHotkey`)+
  设置 tab / CommandPalette 显示陈旧 hotkey,直到 B 重载才收敛。keybindings 是 values-store
  的平行 store,被漏掉了同步。(theme `ThemeProvider` 同缺但影响更小,DEFER。)

### P2-BB marketplace 更新成功后 reload 本地版本再 refresh — `marketplace-tab` 回归
- `MarketplaceTab.onUpdate` 成功后 `dismissUpdate` + **`await mgr.reload(entry.id)`** 推进
  renderer 内存里 PluginManager 的版本,再 `refreshUpdates`。reload 走 per-id 生命周期锁,
  与 2s mtime watcher 并发安全。
- 根因: `installFromGit(overwrite)` 原子覆盖磁盘但**不** reload PluginManager;内存版本要等
  2s mtime watcher 才更新。紧随的 `refreshUpdates` 读 `mgr.listAll()` 陈旧旧版本 →
  `isNewerVersion(remote, old)` 为真 → 把刚 dismiss 的条目又加回 `available` → 更新按钮 +
  IconSidebar 角标复活,且无人再触发 refresh,滞留到下次手动刷新/重启。

### P2-BC marketplace 刷新评论失败给反馈 — `marketplace-tab` 回归
- `MarketplaceTab` 订阅 `useReviewsStore(s => s.error)` 并在刷新按钮下渲染错误反馈(失败且非
  loading 时);新增 i18n key `marketplace.reviews.refresh_failed`(en/zh/ko)。
- 根因: 旧实现订阅了 `reviewsByPid`/`reviewsLoading` 却**从未读取 `error`** → 刷新失败
  (NO_TOKEN / 网络且无缓存)时按钮恢复原样、评论区无变化,用户无法区分"成功无新评论" vs
  "失败"(同文件索引拉取失败有错误态,评论刷新漏了)。

### 第二十二轮读确认收敛的子系统(非缺陷)
- DockReconciler/DockShell 布局读写、panel add/remove 幂等、关窗 flush 链:已闭环。
- editor.store / workspace.store 读写往返(markSaved/reloadFromDisk/dirty 保护):严密。
- update-store/reviews-store `refreshGen` 单调代际防乱序、loading 双分支收尾:正确。
- SettingsPanel/values-store 读写往返、KeybindingCaptureModal 冲突检测(VSCode 同款允许保存
  仅告警):刻意设计,正确。
- PluginsTabContent reload/disable/enable 失败仅 console.warn(无 toast)但 refresh() 后
  行 status 多自我修正、且为可逆非破坏性操作:介于"反馈不足"与"可接受",未列正式缺陷。

---

## 第二十三轮(收敛确认 — bridge/protocol/registry/terminal/explorer 直读复核)

> 因 subagent API 过载(529),本轮由 Claude 亲读系统性复核前面较少碰的剩余面。
> **结论:未发现新的可修 P1/P2 缺陷,审计收敛。**

直读确认正确处理(非缺陷):
- `protocol/handler.ts`:co:// 解析失败 / commandId 不存在 → console.warn 不抛(外部 URL
  失败不应崩 renderer,注释明确;niche 外部触发路径,非可见按钮)。
- `EditorActionRegistry.when` / `ExplorerDecoratorRegistry.fn` 求值:try/catch **fail-closed**
  (predicate 抛错 → action 隐藏 / decoration 跳过)。这是 render 期谓词/装饰求值,失败静默
  正确 —— 每次 render 弹 toast 反而是 spam。**刻意设计,非未闭环。**
- Explorer 全部 mutation UI 闭环:rename(`FolderTree:118` notify.error)、新建文件/文件夹
  (`submitCreate:433` notify.error)、内部拖移(`onDropItems` + root drop notify.error)。
- Terminal:drag-drop 已 `notify.warn`(no_os_path / write_failed);pane spawn 失败
  dispatch `SET_PTY_FAIL`(可见失败态,非静默);WebGL init 失败静默回退 DOM(正确降级)。
- `scoped-app.ts` 安全门:fs/network/shell/clipboard 每个方法 `ensurePerm(pluginId, perm)`
  **fail-closed 抛 PermissionError**;makeEditor.openFile checkPath、makeDataStore pluginId
  绑定(前轮已验)—— 越权面无缺口。

留档(非本目标范围):`spawnLeaf.ts` 的 `createSpawnQueue` 导出全仓无引用(疑似重构遗留死
代码,`cancelPanelSpawns` 才是被 `wrap-panel-close` 使用的活导出)。删死代码属 cleanup 非
bug 修复,且不影响运行,不在"缺陷修复"目标内,留档不动。

---

## 本 session(第二十一~二十三轮)总览

新 session 以"未闭环 + 状态一致性"为主视角,先独立复核 continuo-meta / renderer hooks /
主进程 services+IPC 三块确认前 20 轮收敛仍成立,再补扫剩余面,修 **7 条**真实 P1/P2:
- P1-AX 贡献式 action/命令/右键/QuickOpen打开/Explorer点击打开 失败统一 notify(抽
  `run-contributed-action.ts` 共享 helper,收敛第十四轮 P2-AO 只修一处的遗漏)
- P1-AY QuickOpen 扫描失败区分空 workspace + 重试
- P1-AZ auto-save 失败 onError 去重通知
- P2-BA keybindings 跨窗 storage 同步(镜像 values-store)
- P2-BB marketplace 更新 reload-before-refresh(防更新按钮/角标复活)
- P2-BC marketplace 评论刷新失败渲染 error
test 2932 → 2953。第二十三轮直读复核确认收敛。方法论延续:agent 只读审计经 Claude 亲读
验证(本 session 三个复核 agent 均确认前轮收敛 + 两个发现 agent 的 10 条候选经亲读全部确认
为真实缺陷,无误报 —— 因均与既有仓库 pattern(IconSidebar P2-AO / values-store P2-CC)一致
而非矛盾)。

---

## 本 session(第五 session / 第二十四~二十六轮)总览

承前序 67 条收敛后再开 `/goal`。3 轮多 agent 只读审计 + Claude 亲读验证,以**「生产实现 vs
测试 mock 差异」**为本轮高产新视角,修 **6 条**真实 P1/P2,否决 1 条误报。test 2953 → 2965。

- **P1-BE** `IpcPluginDataStore.write` 先写缓存 + 标 loaded 再 await save → 落盘失败仍返
  从未落盘的脏值(假持久化)。修:缓存移到 await save 成功之后。**前序审计全用
  `InMemoryDataStore` mock 绕过了真实 IPC 实现,故一直未发现** —— 本轮专设此视角捞出。
  (`plugin-data-store-persist-integrity.spec.ts`)
- **P2-BF** `IpcPluginDataStore.load` 把 in-flight promise 存 loading 后,`loading.delete`
  写在 await 之后 → reject 时永不执行,rejected promise 永久缓存 → 瞬时 IPC 错后该 id 永远
  无法重试。修:try/finally 清 loading。(同上 spec)
- **P2-BG** `useExternalFileSync` 同一 path 多次 dir-changed 发起并发、未序列化的 readFile,
  乱序 resolve 时旧内容覆盖新内容。修:per-path 单调 seq,latest-wins 丢弃过期回调。
  (`external-file-sync-out-of-order.spec.tsx`)
- **P2-BD** `MarketplaceTab` 更新成功后 `mgr.reload` 失败仍继续 `refreshUpdates` → 内存仍旧
  版 → 把刚 dismiss 的条目复活(P2-BB reload-before-refresh 的残留缺口)。修:抽
  `reconcile-after-update.ts` 做 reload→refresh 成功门控,reload 失败跳过 refresh。
  (`marketplace-reload-fail-no-resurrect.spec.ts`)
- **P2-BH** `plugin-data:save` 的 finally `await release()`(proper-lockfile 解锁)可能 reject
  (锁 stale 被接管 / `.lock` 被外部清)→ 若 atomicWriteJson 已成功而 release reject,finally
  的 reject 覆盖成功结果 → 一次成功的写被 IPC 报成失败(未闭环)。修:`release().catch(()=>{})`
  best-effort,与本文件 `.corrupt` 写同款风格。(`plugin-data-save-unlock-failure.spec.ts`)
- **P2-BI** `useCommandHotkeys` 全局快捷键派发仍裸 `void cmd.fn()`(同步 throw 逃逸 keydown /
  async reject 成 unhandledrejection,无 toast),而命令面板路径已 `runContributedAction` →
  hotkey 触发的命令失败"按了没反应"完全静默。修:hotkey 派发也经 `runContributedAction`,
  label 用 `tWithFallback(titleKey, title)` 与面板对齐。**「helper 建了未传播到平行调用点」
  最高频缺陷族再现**(P2-AO→P1-AX→本条)。(`hotkey-command-error-surfaced.spec.tsx`)
  收敛验证:全仓 grep 确认 6 个应用内贡献面(palette/ribbon/hotkey/explorer 右键/editor
  toolbar×2)全走 runContributedAction;唯一剩余裸路径是 co:// deep-link(handler.ts 已
  try/catch console.warn,niche 外部路径刻意设计,R23 已留档)。

**否决 1 条误报(Claude 亲读拦下)**:agent 报 `IpcPermissionStore.upsert/clearDenied` 与
P1-BE 同类(cache-ahead + 写盘失败仅 console.warn 不抛),且 `ipc-permission-store.spec.ts:139`
把该行为断言为正确。但 `ipc-permission-store/README.md` **明列「IPC 写盘失败 → console.warn,
不抛(in-memory 仍变更)」为关键行为契约** —— 磁盘错误不应阻断用户当前 session 的权限决策生效;
且 denied 不持久化在重启后是 fail-safe(重新弹窗询问,非静默放行)。**与既有 README/测试契约
矛盾 = 刻意设计,否决**(同前序 revoke-pending 误报模式)。独立的完整性批判 agent 也将此项
归入已知 DEFER 并确认。

**DEFER 留档(本 session 新增)**:DockShell `setApiReady(true)` 早于 `fromJSON` 恢复的 ms 级
窄窗(启动瞬间关窗才丢 dock 布局段,P3 级)/ update-store 首启 refresh 与 PluginManager.init
顺序竞态(仅首次需授权弹窗的冷启动、后激活插件本轮漏检更新,boot-wiring 非单测可达)/ 关窗丢
脏 code tab(MVP 无 hot-exit,持久化明确不存 content/dirty,需 beforeunload 守卫属 feature)/
discard markdown 确认期间 pending autosave 落盘(与 markdown autosave-always-saves 语义张力,
产品决策)。

**方法论沉淀(承前四 session)**:(1) **「生产实现 vs 测试 mock 差异」是与前述视角正交的高产新
角度** —— 前序审计用 InMemory/mock 替身验证契约,真实 Ipc* 实现的 await 顺序/错误传播/缓存
一致性(cache-ahead-of-write / rejected-promise-cached / 解锁掩盖成功)从未被覆盖,本轮专设此
视角一次捞出 3 条(P1-BE/P2-BF/P2-BH);(2) **「helper 建了未传播到平行调用点」缺陷族贯穿五
session**(popout/init 锁/run-contributed-action 三度),收敛手段=对该 helper 做全仓 grep 确认
所有兄弟调用点都接入;(3) **与既有 README/命名测试契约一致的候选可信,矛盾的大概率刻意设计**
(IpcPermissionStore 写盘吞错 = README 明列,否决);(4) 收敛趋势 4→1→1,完整性批判 agent 独立
确认收敛 + 针对性 grep 验证缺陷族无残留 = 双重收敛证据。

## 第二十轮(第十 session — 收敛轮:4 全新视角 agent 仅捞 1 真 bug)

> 4 agent 分审未 commit diff 四切片(main fs IPC / main plugin·mcp·terminal / renderer
> stores / renderer dock·UI)+ 2 正交 agent(测试断言是否被削弱掩盖 bug / index.ts·persistence
> 编排)。前三切片 0 新 bug(agent 多在复述 diff 里已修内容);renderer dock agent 报 3 候选
> **经 Claude 亲读全部误报**(unsubExit 同步抛错则 cleanup 根本不注册 + 与既存 unsubData 同构
> 非回归 / Modal onClose 已在 deps 数组 / quick_open 新 i18n key en·ko·zh 三语言齐全)。测试
> 审计 agent:20 个被改 spec 全部为真修复的合法适配,无削弱掩盖。唯一真 bug 由 index.ts 编排
> agent 捞出,Claude 亲读 + 全仓 grep 确认。

### P2-BJ popout 子窗关闭不释放窗口级资源(fs watcher / scope·agent 授权) — `popout-window-resource-cleanup.spec.ts`
- 抽 `electron/main/window-resource-cleanup.ts` 的 `makeWindowResourceCleanup` 工厂(注入
  cancelScopeRequests/releaseFsWatchers/cancelAgentAuth),`index.ts` 在覆盖全窗口的
  `browser-window-created` 处统一挂 `win.once('closed')`;`createMainWindow` 的 `win.on('closed')`
  不再各挂三项(只留主窗专属 explorer.json 段落持久化)。创建期先捕获 `wcId`('closed' 后
  webContents 已销毁不可读)。
- 根因: **第十一轮以来最高频「helper/守卫建了未传播到所有兄弟入口」族再现(第六度)**。
  dockview popout 子窗由 Electron 在 setWindowOpenHandler 返回 `action:'allow'` 时**内部创建,
  不走 createMainWindow**,但经 overrideBrowserWindowOptions 注入了同一套 PRELOAD,能发起
  fs.watch / plugin scope 授权 / agent 授权。P2-N/P2-AT/scope-cancel 三项关窗清理当初只挂在
  createMainWindow 的 `win.on('closed')` → popout 关闭时 watcher 引用单向累积触顶
  MAX_WATCHERS 把活跃窗 watcher LRU 踢掉、pending scope/agent 授权 host 侧干等满 5min TTL。
  对照证据:terminal.ipc 的 `windowClosedCleanup`(PTY + stop-hook waiter + mcp revoker)是
  **同类窗口级资源**,却已用覆盖全窗口的 `app.on('browser-window-created')` 挂法 —— 同仓两套
  挂载模式,其一漏了 popout 兄弟。修复统一到通用挂法,杜绝再次漂移。

**方法论沉淀(承前五 session)**:(1) 第十 session 4 全新视角 agent 仅捞 1 真 bug、3 候选亲读
全误报、20 spec 审计 0 削弱 —— **收敛极深,印证「agent 复述已修内容/理论瑕疵」是深收敛阶段的
主要噪声**;(2) **「兄弟入口未传播」族第六度复现**(popout vs createMainWindow),本轮发现路径
正是「同类资源在仓内已有正确的全窗口挂法(terminal),拿它当对照标尺去查别的资源是否漏挂」
—— 正交标尺比通读更快定位族缺口;(3) 修复同时把逻辑抽成可注入工厂 + 静态守卫(index.ts 必引
helper + 必挂 browser-window-created),把「单一来源」固化进测试防回退。
