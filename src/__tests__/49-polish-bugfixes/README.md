# topic 49 · 打磨阶段缺陷修复(P1 批次)

进入打磨阶段后,对插件 / 终端 / marketplace / 窗口生命周期做子系统审计,修复 5 条
用户可感知或会造成资源/数据损失的 P1 缺陷。每条都先写本目录下的可执行规范,再改实现。

## 行为契约

### #1 终端自然退出不丢最后一段输出 — `terminal-exit-flush.spec.ts`
- PTY 自然退出时,仍卡在节流(flush)窗口里的最后一段输出**必须发**给 renderer,不随退出丢弃。
- 退出时若无 pending 输出,则不发多余的 `terminal:data`;退出状态走 sessions 快照的 `exitCode`,没有单独的退出推送。
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
- main 入口须是普通文件(目录 → `BAD_MAIN`,不落地);`branch` 选项 → `--branch=<b>`
  (非法/前导 `-` → `BAD_INPUT`,不启动子进程);`expectedId` ≠ manifest.id → `PLUGIN_ID_MISMATCH`。
  marketplace 卡片安装/更新经 `entryInstallOptions(entry)` 传 `{ expectedId, branch }`。
- 更新(overwrite,已有旧目录)保留插件数据:swap 前在锁内把旧目录的 `data.json` 带进 staging,**覆盖**仓库自带的
  同名文件(更新不让仓库内容取代用户数据);旧目录没有 `data.json` → 仓库自带的照旧保留(同全新安装)。
  只认普通文件(noFollow:符号链接 / 硬链接 / 非普通文件拒)、≤ plugin-data 上限、合法 UTF-8;不满足或读写失败 →
  `PLUGIN_DATA_PRESERVE_FAILED`,中止更新,旧版本与数据原样保留、无 staging 残留。

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
  且落在同父目录,`sweepStaleTrashInDir` 能命中(现只认宿主生成的精确形态,见
  `plugin-fs-atomic-replace-trash`)。
- 根因: 旧实现 trash 名是 `${finalPath}.trash-...`(后缀形式 `foo.json.trash-...`),
  不以 `.trash-` 开头,sweep 永远漏掉。rename 回滚失败(line 489)泄漏的 trash 会
  永久驻留插件目录。旧测试只用字面量 `.trash-old` 掩盖了这个 bug。

### P2-G before-quit 不重复 flush 同窗 — (index.ts `wireWindowCloseFlush`)
- close handler 查 `flushedOnQuit.has(win.id)`(本窗 close 流程与 before-quit 共用;后续删去了原先的局部 `flushed`)。
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
  迁移路径(`migrateExplorerFile`,启动时经 `prepareExplorerFileForBoot`)对损坏文件特意 skip 不动,运行期写路径却没有
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
- 首字符不得为 `.` / `_`(plugins 目录元数据与临时目录命名空间);`-` 开头仍合法 —— 已装的这类插件须照常
  列举可见、可卸载(否则 renderer 静默跳过 + 卸载 INVALID_ID → 目录永久残留)。
- 末字符不得为 `.`,且不得是 Windows 保留设备名(`con` / `prn` / `aux` / `nul` / `com0-9` / `lpt0-9`,含
  `nul.x` 这类带扩展名形式),各平台统一。根因: Win32 去掉路径段尾部的点,`foo.` 与 `foo` 落到同一安装目录
  与 data 文件,而互斥锁 / 权限 / scope 的键是两个 id;设备名作目录名指向设备。`com.example.foo`、`console`、
  `x.nul` 等不受影响。

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
- `plugin-data:save-serialized` 用 `atomicWriteText`(temp+fsync+rename)写入已序列化文本;`plugin-data:load`
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
- **安全修订(F4)**:只有**未发 hello** 的连接(外部 MCP client)才回落到当前活窗;发过 hello 的连接绑定窗口
  关闭后 fail-closed —— tools/call 回 `NO_WINDOW_CTX`、不执行工具(tools/list 不受影响)。回落会让窗口 A 里
  agent 的调用以窗口 B 的身份执行 / 弹授权(B 已「本次启动期间允许」→ 静默放行)。该 proxy 随 A 的终端退出。
- **安全修订(hello 失败)**:hello **本身失败**(token 无效 / 已轮换、窗口在 hello 到达前已关)同样记为「已尝试
  hello」,tools/call 回 `NO_WINDOW_CTX`,不被当作外部客户端回落主窗。连接状态机:未 hello → 外部客户端;
  hello 成功 → 绑定窗口;hello 失败或绑定窗口已关 → 拒绝。
- **安全修订(token 吊销)**:hello 成功后绑定所用的 token 被吊销 / 轮换 → 连接同样降为「hello 失败」(每次请求
  复查 token),可用新 token 重新 hello 恢复。见 `stdio-revoked-token-binding/`。

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
- **后续**:`terminal:overflow` / `overflow-recovered` 两个事件 renderer 从未订阅,已连同恢复检查定时器删除
  (见 `terminal-overflow-throttle/README.md`);以下为当时的修复记录。
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

## P1/P2 批次(第十一轮 — 独立复审:popout 消费方 / 终端同步竞态 / init 锁 / IPC 信任)
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

## 第十三轮(独立复审 — editor 保存 / explorer 展开 / marketplace 更新 / topic-48 注入)
### P1-AE 关窗/退出 flush pending markdown autosave — `autosave-window-close-flush.spec.tsx`
- autosave scheduler 的 `flush()` 改为返回可 await 的 Promise;新 `autosave-flush-registry.ts`
  模块级 registry(镜像 explorer-persist 的 `activeFlush`),`useAutoSave` 注册当前 scheduler
  的 flush;DockShell `onFlushRequest` 在 ack 前 `await flushPendingAutoSave()`。
  后续:活动句柄改随 `claimAutoSave` 登记在 autosave-failures(`activeAutoSaveFlush()`),registry 只保留在途 flush 集合。
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

### P1-AI before-quit 始终强杀 PTY(关最后一个窗口触发的 quit 也跑 cleanupAll)
- 见上文「第十三轮」补充。`electron/main/index.ts` `before-quit` 旧实现用
  `wins.every(flushedOnQuit)` 兼当守卫:关掉最后一个窗口触发的 `window-all-closed→app.quit()`
  路径里 `wins` 已空,`[].every()` 恒 true → 提前 return **跳过 `termService.cleanupAll()`**。
  window 'closed' 清理走 3s grace timer,进程退出不触发 SIGKILL → Linux/Windows 上忽略
  SIGINT 的长任务子进程(agent/node)被孤儿化。改用独立 `quitCleanupStarted` 守卫:无论
  哪条 quit 路径,`cleanupAll()` 都在 `app.quit()` 前 await 一次(重入 before-quit 直接放行)。
  macOS 不受影响(window-all-closed 不 quit,grace timer 正常 fire)。Electron app 生命周期
  改动,靠逻辑审计 + 全量 suite 回归,不单测。

## 第十四轮(独立复审 — 文件原子写 / 插件 shell stream / ribbon / shell.service)
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
- `done = started.then(...)` 急切求值,缺 shell 权限时 `ensurePerm` 立即 reject。给 done 挂
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

## 第十五轮(独立复审 — editor React/同步层 + dock/持久化 hydration)
### P2-AQ CodeEditor 外部 reload 保留光标/选区 — `code-editor-external-reload-keeps-cursor.spec.tsx`
- value-sync effect 全文替换旧实现不带 selection,改为把旧 selection clamp 到新长度后随
  dispatch 一并提交(scrollIntoView 默认 false 不拽滚动)。
- 根因: 外部进程改盘 → reloadFromDisk 更新 content → CodeEditor 用 `dispatch({changes:
  {from:0,to:doc.length,insert}})` 整篇替换,CodeMirror 不带 selection 时把光标甩到文档边界。
  用户在 .js/.json 或 markdown Source 模式文件中部阅读/定位时被外部修改打断会跳回顶部。
  Milkdown 走 epoch-remount 是有意设计,CodeEditor 这条就地 dispatch 路径漏了 selection 保持。

## 第十六轮(独立复审 — SDK registries/co-app + terminal service/hooks)
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

## 第十七轮(独立复审 — mcp invoke 桥接/agent-auth 接线 + fs watcher/设置)
### P2-AT 目标窗口关闭立即结算 agent-auth pending — `agent-auth-cancel-by-window.spec.ts`
- `requestAgentAuth` 的 `pending` 改存目标 windowId;新 `cancelAgentAuthByWindow(windowId)`
  把发往该窗口的 pending 全部立即结算为 denied;`index.ts` `win.on('closed')` 调用之。
- 根因: pending 取消路径只有 5min 定时器,窗口 closed 不提前结算。发起调用的是**仍存活的
  外部 agent CLI 进程**,用户关窗后它要干等满 PROMPT_TIMEOUT_MS(5min)才收到默认 denied,
  表现为 agent 假死。这与已 DEFER 的 request-scope「等待者是已死请求方自己」**不同** ——
  这里等待者是活的外部进程,DEFER 免责理由不成立。镜像 stop-hook broker.cancelByWindow(#3)。
  (顺带:close-flush.spec.ts 的 agent-auth mock 补 `cancelAgentAuthByWindow` stub。)

## 第十八轮(收敛轮 — 自审回归 + 剩余 UI 表面)
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

## 第十九轮(收敛轮 — MCP host token + window-restore/启动)
### P2-AW 创建失败时撤销已签发 mcpToken — `terminal-create-reserve-before-spawn.spec.ts`
- mcpToken 由 ipc 层的 `makeCreateHandler` 签发,也由它的同一个 catch 吊销:登记会话失败
  (`TOO_MANY_TERMINALS` 等)、`prepareShellIntegrationEnv` 失败、spawn 失败、退出闸拒绝,一处覆盖。
  `terminal.service.createTerminal` 只回滚自己分配的状态(`migration-step1-pty-handover/create-failure-rollback.spec.ts`)。
- 根因: `prepareShellIntegrationEnv`(写 shell integration 脚本,磁盘满/权限/ENOENT 时抛)在
  PHASE 1 try **之外**,失败绕过 sm.create 的 rollback。此时 mcpToken 已在 ipc 层签发注入
  windowTokens,但绕过撤销 → 孤儿 token 留存(授予该窗 MCP 访问直到关窗)+ map 增长。安全
  影响有限(token 未注入任何存活进程),但属真实 cleanup 遗漏。

## 第二十一轮(新 session 复审 — "未闭环"专项视角)
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

## 第二十轮(第十 session — 收敛轮:4 全新视角 agent 仅捞 1 真 bug)
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


## 第十一 session(保存反馈 / 外部修改冲突 / seq / locale 兜底)
### P2-BK autosave 把 resolve 的 `{ok:false}` 当成功 — `autosave-resolved-failure.spec.tsx`
- `saveFile` 对普通磁盘错误(EACCES/ENOSPC,main safeHandle 返回 `{ok:false}`)是 resolve;
  `makeAutoSaveScheduler.runSave` 只在 reject 时走失败路径 → onError 不触发、无提示。
- 修复:结果 `ok===false` 视同失败(抛出结果本身,去重语义不变);`useAutoSave` 通知按 code 经
  `localizeErrorByCode` 本地化(与 Cmd+S 的 `notifyFailure` 同路径),不露 raw message。

### P2-BL dirty tab 外部修改后保存静默覆盖 — `save-external-change-conflict.spec.ts`
- `useExternalFileSync` 对 dirty tab 跳过 reload,保存又不比较磁盘 → 外部版本被无声抹掉。
- 修复(参考 VSCode「文件已在磁盘上更改」):`saveFile` 写盘前读盘,≠ `tab.originalContent` →
  返回 `EDITOR_DISK_CHANGED` 不写。显式保存(Cmd+S)弹 `ConfirmDialog` 确认后以 `{force:true}`
  覆盖;autosave 不覆盖、走 P2-BK 失败通知。markSaved 并发键入语义不变(读盘后重取 tab 再快照)。
- 复审修订:只有明确「不存在」(`FS_NOT_FOUND`,main readFile 对 ENOENT 的映射;resolve 或 reject 带该 code)
  才照常写(允许重建);其它读错误(FS_DENIED / FS_IO / bridge reject)无法确认磁盘状态 → 中止保存、
  保留 dirty、返回该错误(autosave 走失败通知,Cmd+S 走既有失败提示)。

### P2-BM allocateWindowSeq 安全但落后的计数分配重复 seq — `dock-layout-per-window-seq/window-seq-allocate.spec.ts`
- nextWindowSeq 为安全整数但 ≤ 现存最大 windowSeq 时原样分配 → 与现存段重复(E4 只处理不安全整数)。
- 修复:与 E4 合并为一处 `seq = max(安全 nextWindowSeq, 现存最大安全段 + 1, 1)`。
- 复审修订:现存段 = `MAX_SAFE_INTEGER`(或计数本身到顶)时 `seq + 1` 不安全 → 退化为最小未被占用的
  正整数(计数仍安全时从计数起找,已分配未落盘的 seq 也算占用),结果与 nextWindowSeq 均为安全整数。

### P2-BN settings 读失败时 getCurrentLocale 与 loadSettings 不一致 — `i18n-en-zh-ko/settings-service.spec.ts`
- EACCES/EIO 时 loadSettings 返回系统语言默认但不写 cached;getCurrentLocale 因 cached 空返回硬编码
  'en' → main 侧文案与 renderer 分裂。
- 修复:另存 `unknownStateFallback` 仅供 getCurrentLocale 兜底;saveSettings 的 no-op 比较仍只认
  cached(已知已存状态),未知态不会让同值保存被跳过。

## 独立审计(文件读写数据安全 / watcher 健壮性)
### 原子保存保留 POSIX 权限位 — `atomic-write-preserve-mode.spec.ts`
- `atomicWriteFile` 覆盖已有普通文件时,临时文件在 rename 前 `fchmod` 为原文件 `mode & 0o777`
  (不受 umask 影响);0755 脚本保存后仍可执行,0600 私密文件不被放宽。不保留 setuid/setgid/sticky。
- 新建文件行为不变(0666 & ~umask);Windows 跳过(mode 语义有限)。
- 覆盖 fs:writeFile / fs:writeBinary / 插件 fs writeFile(都经 `ipc/fs/atomic-write`)。

### fs.watch 异步 error 不崩溃主进程 — `watch-error-evict.spec.ts`
- 生产 creator 注册 FSWatcher `'error'` 监听(console.warn),经 `WatcherCreator` 第三参 `onError`
  上报池:关闭并移出该 watcher、清 owner 记账;迟到的 error 不误杀同 path 重建的新 watcher。
- 驱逐时池经 `createWatcherPool` 第二参 `onLost(path, ownerIds)` 报出驱逐前的持有者窗口(LRU / 正常 unwatch 不报,
  迟到的重复 error 不重复报);`notifyWatchLost` 只向这些窗口推 `fs:watch-lost`(`{ path }`),跳过已销毁 / 不存在
  窗口,单窗 send 抛错不中断。renderer 侧重装(失败续排退避重试、成功后刷新并本地分发 watch-restored 供编辑器
  外部同步重读 clean tab、折叠复位退避)见 `use-fs-watcher/`、`editor-hooks-react/`。

### 非 UTF-8 文件不进入可保存的文本编辑器 — `read-file-non-utf8.spec.ts`
- 编辑器文本读取入口 `fs:read-file` 以 `requireUtf8` 读取:非法 UTF-8 → `FS_NOT_UTF8`(en/zh/ko 文案),
  打开走既有失败提示,防 U+FFFD 替换后保存写回 EF BF BD 损坏原文件。UTF-8 BOM 原样保留不变。
- 插件 fs readFile 契约不变(宽松解码)。

### P2-BO shell 终止杀整棵进程树 — `shell-process-tree-kill.spec.ts`
- 流式 shell 的 ABORT / 超时、一次性 execShell 的超时:后台后代(`sh -c 'sleep 600 & wait'`)随之被杀(ESRCH),
  exit / Promise 及时结算。
- 整组 SIGTERM 后直接子进程先退出(close 先到)时,宽限期满仍对整组 SIGKILL:同组内忽略 SIGTERM、stdio 不持管道的
  后代(`trap '' TERM`,重定向 /dev/null)最终被杀(ESRCH)。结算(resolve)照常,但不取消这一步 —— 旧 execShell 在
  settle 时清掉 SIGKILL timer 致该后代存活;流式路径的 killWithGrace timer 本就不随 close 取消。
- **已知边界(不修,与 VSCode tasks 一致)**:后代主动 setsid / `detached` 脱离原进程组后,整组信号够不着它。它仍持
  stdout/stderr 管道时,终止后最多再等 3s 销毁 stdio 强制结算 —— 用例只断言「及时结算、不挂住」,**不断言**该后代被杀;
  afterEach 按记录的 pid 手动清理它只为防测试泄漏进程,不是掩盖缺陷。
- 根因: 旧实现只杀直接子进程,孤儿后代持管道 → close 不来,done 与 active 槽位挂住。
- 修复:POSIX spawn `detached: true` 建新进程组,终止对 `-pid` 发信号(沿用 killWithGrace 的 SIGTERM → 宽限 →
  SIGKILL);Windows 走 `taskkill /pid <pid> /T /F`(`lib/kill-with-grace.ts` 的 `processTreeKillable`)。
- 退出清理:`cleanupAllShellExecs()` / `cleanupAllShellStreams()` 对所有在途进程树立即强杀(不给宽限,`killProcessTreesNow`)
  并等待 close(上限 2s,到点销毁 stdio),纳入 before-quit 与 `termService.cleanupAll` 同一段 awaited 清理(接线见
  `dirty-close-confirm/close-confirm-flow.spec.ts`)。同组内忽略 SIGTERM 的后代随之被杀(ESRCH)。根因:before-quit
  此前只等 terminal/debug/MCP;exec 无退出清理,stream 只在 webContents 销毁后 SIGTERM + 未被等待的定时 SIGKILL,
  detached 进程组在 IDE 退出后继续运行。
- 退出闸(终审 P1):cleanupAll 开始即置 shuttingDown,此后 `execShell` / stream START 以 `AGENT_NOT_AUTHORIZED`
  立即拒绝且不 spawn(与 debug launch 同一闸);结束前再扫登记表强杀清理期间漏网的进程。根因:清理只杀调用瞬间的
  快照,插件收到结算 / exit 后立即重启的任务不在快照内,窗口销毁路径的定时 SIGKILL 在主进程退出后不会执行。

### Windows 进程树终止先等 taskkill 结束 — `windows-tree-kill-order.spec.ts`
- Windows 上 `processTreeKillable` 的 SIGTERM 启动 `taskkill /pid <pid> /T /F`;随后的 SIGKILL(根进程直杀兜底)
  **排在 taskkill 结束(exit / error)之后**,最多等 `TASKKILL_WAIT_MS`(1s)后照常直杀。未发过 SIGTERM 的 SIGKILL 直接直杀;
  taskkill 启动失败(error)立即直杀根进程。POSIX 行为不变。
- 根因:`killProcessTreesNow` 紧接 SIGTERM 同步 SIGKILL 直杀根进程,taskkill 稍后执行时根 PID 已不存在,无法遍历子进程树。

### 卸载时 path scope 清理失败中止卸载 — `uninstall-scope-cleanup-fail-closed.spec.ts`
- `uninstallPlugin` 清 `_plugin-path-scopes.json` 失败(原子写 ENOSPC、读盘 IO 错误)→ 抛 `PATH_SCOPE_CLEANUP_FAILED`
  (en/zh/ko 文案),**不删目录**、旧 scope 原样在盘;磁盘恢复后重试 → 卸载完成、scope 已清。
- 仅 scopes 文件已损坏(JSON 解析失败,读端恒降级 [] 不会被继承)仍放行卸载(既有契约,`plugins-path-scopes.test.ts`)。
- 根因:旧实现把任何清理失败当 best-effort 吞掉再删目录 → 同 manifest id 重装时冷启动水合旧 scope,`covers()` 静默
  授权不弹窗,新代码继承旧目录读写授权。顺序:renderer 先回收 plugin-fs token(失败 `PLUGIN_FS_TOKEN_REVOKE_FAILED`
  中止),再调 main 卸载;main 先清 enabled / permissions / path scope,全部成功后才删目录。

### 卸载间隙的授权不把 path scope 写回磁盘 — `uninstall-scope-persist-race.spec.ts`
- 授权弹窗「授权」后的 scope 落盘走 `persistPluginPathScopesIfInstalled`:与卸载共用同 id mutation 锁,锁内确认插件目录仍在,
  否则拒 `NOT_INSTALLED`(调用方 best-effort 吞掉,本会话内存授权随后被卸载的 `revokePluginFsAccess` 撤销)。
- 任意交错下卸载完成后磁盘无该插件 scope:卸载前到达的写入随后被卸载清掉;卸载中(scope 已清、rm 未完成)到达的写入等卸载结束后被拒。
- 根因:卸载先清 `_plugin-path-scopes.json` 再 rm 目录,返回后才撤内存 token;间隙里另一窗口点「授权」→ token 仍 active →
  直接写盘把 scope 写回 → 同 id 重装冷启动水合旧 scope,`covers()` 静默授权。

### 退出时在途 HTTP MCP 请求不拖住 mcpHost.close() — `mcp-host-close-inflight.spec.ts`
- `close()` 停止接新连接后立即 `closeAllConnections()` 断开现存连接(挂在授权 await 上的在途 POST 被断开,服务端
  `ctx.signal` abort),整个关闭上限 2s。
- before-quit 在关闭 MCP 前同步 `cancelAllAgentAuth()`(见 `agent-auth-service` T17):未决授权全部 denied,不发 IPC。
- 根因:窗口已隐藏无人应答弹窗,`server.close()` 等现存连接自行结束 → 请求挂满 5min 授权定时器 → 应用不可见且无法退出。
  stdio server 的 close 本就先 destroy 现存连接,无需改。

### 取消退出不再停用 Stop hook broker — `hook-broker-stop-on-irreversible-quit.spec.ts`
- 旧实现在 MCP host 启动处另挂一次性 before-quit 监听,退出一开始就 `broker.stop()`;用户在未保存确认框取消
  (或保存失败中止退出)后 broker 不重启,`terminal.await_stop_hook` 直到重启应用都报 broker stopped。
- 修复:停止函数存为 `stopHookBroker`,只在主 before-quit 的不可逆清理阶段(全局最终检查通过、
  `cancelAllAgentAuth` 之后)与 MCP host / stdio 关闭一起执行。

### 终端退出闸:清理开始后拒绝新建 PTY — `terminal-quit-shutdown-gate.spec.ts`
- 根因(终审 P1):before-quit 的 `termService.cleanupAll()` 只杀调用瞬间的 instances 快照;清理期间(debug teardown
  数秒、MCP host 关闭前)agent 经 `terminal.create_session` 新建的 PTY 不在快照内,窗口关闭只走 3s grace,主进程退出后
  升级定时器不执行 → 忽略 SIGINT/SIGHUP 的长期命令成为孤儿。
- 修复(与 shell exec / stream / debug launch 同一闸):`cleanupAll` 开始即置 shuttingDown;此后 `createTerminal`
  在入口、shell integration 准备之后(spawn 前)两处以 `TERMINAL_CREATE_CANCELLED` 拒绝(已签发的 mcpToken 由签发它的 ipc 层吊销);
  spawn 在途时清理开始 → spawn 完成后立即 SIGKILL 并以同码失败;结束前再扫一遍登记表强杀漏网会话。
  `resetTerminalShutdownForTest()` 供测试复位。
- renderer 用户路径(Cmd+T / Dock「新建终端」)对 `{ok:false, TERMINAL_CREATE_CANCELLED}` 静默(窗口已隐藏),
  见 `create-user-terminal`。

### execShell 达输出上限后丢弃式 drain — `shell-exec-cap-drain.spec.ts`
- 根因(性能):某流写满 `maxOutputBytes` 后 data listener 仍逐 chunk 进 JS 回调(立即 return),`yes` / 失控日志
  在截断后让 main 热路径空转到超时。
- 修复:该流写满即摘掉 JS data 处理,保持 flowing 丢弃(不反压子进程);恰好写满时挂一次性 listener,再来数据才置
  `truncated`(与旧实现一致)。结果内容、截断标志、exit/close 语义不变。

### 保存回声身份在写句柄关闭后取(Windows LastWriteTime)— `atomic-write-echo-stat-after-close.spec.ts`
- 根因(Windows 专属,优化失效):旧实现 fsync 后经 `fd.stat()` 取「本次写入」身份(关闭前),rename 后 stat 目标严格比
  `mtimeMs`;NTFS/FAT 在写句柄关闭时才刷新 LastWriteTime → 比对几乎必然失败,保存回声识别失效(每次保存整文件重读)。
- 修复:`fsync → close → stat(tmp)` 作 written(dev/ino/mtime/size),再 `rename → stat(target)` 比对(NTFS rename
  保留 FileId 与 LastWriteTime)。不一致(外部改写)或 stat(tmp) 失败 → `undefined`,退化为整文件读,永不误判为回声;
  写盘与 tmp 清理的错误路径不变。macOS/Linux 行为不变。

### Windows stdio MCP 命名管道每次启动随机命名 + 发现文件 — `security-windows-stdio-pipe-per-user.spec.ts`
- 攻击场景(Windows 专属):命名管道命名空间全机共享。可预测名(旧固定名 `\\.\pipe\continuo-mcp`,或仅由用户名 /
  profile 目录推导的名字)下,同机其它用户先建同名管道 → 本用户 Continuo 绑定失败(EADDRINUSE 被吞成告警),终端里的
  stdio proxy 连到对方管道并在 hello 中交出 `{windowId, token}` → 对方拿 token 调本用户的 127.0.0.1 HTTP MCP。
- 契约:
  - 主进程每次启动生成 `\\.\pipe\continuo-mcp-<sha256(小写用户名 \0 小写 profile 目录) 前 32 hex>-<128 bit 随机 hex>`,
    每次不同;只接受形如 `^\\\\.\\pipe\\continuo-mcp-[0-9a-f-]+$` 的名字(拒绝远程管道 / 任意路径 / 多行)。
  - 每个 PTY 注入 `CONTINUO_MCP_SOCKET=<该名>`(与 `CONTINUO_MCP_TOKEN` 同处注入),proxy 优先读它。**所有平台**都注入本实例端点
    (POSIX 为 `<userData>/mcp.sock`):否则 dev 实例终端里的 proxy 按候选顺序优先连 packaged 的 socket,用 dev token 发 hello 必败。
  - 启动时(任何准备 / listen 之前)先删 `<userData>/mcp-pipe` 旧文件(崩溃残留);listen 成功后才原子写入两行
    「管道名 + 主进程 pid」,启动失败不留文件;close 时内容仍是自己写的(名字 + 本进程 pid)才删除。
  - proxy 在 win32 且无 env 时按 `%APPDATA%\Continuo` → `%APPDATA%\Continuo Dev` 读 `mcp-pipe`,内容非法则跳过;
    格式合法还须其中的 pid 仍存活(`process.kill(pid, 0)`,EPERM 视为存活),否则跳过该候选 —— 崩溃 / 强杀残留的
    发现文件不用;只有管道名一行的旧格式没有 pid 可验,同样跳过(fail-closed)。
    都读不到 → 报错退出,不回落确定性名。proxy 的校验正则 / 读取逻辑(`<windows-pipe-discovery>` 标记段)与主进程逐项比对。
  - proxy 对候选(win32 的合法发现文件;macOS / Linux 存在的 packaged / dev socket)按序连接,连不上(ENOENT /
    ECONNREFUSED 等)试下一个,全部失败才报错退出(`<connect-candidates>` 标记段直测 + 端到端:过期 packaged socket
    回落到运行中的 dev)。`CONTINUO_MCP_SOCKET` 显式指定时只连它;win32 上其值同样须是合法本机 continuo-mcp
    管道名(`isAcceptableEnvSocket`),否则报错退出;POSIX 上是任意 socket 路径,名字不校验(归属校验见下一节)。
  - macOS / Linux 不写发现文件(PTY env 注入见上)。
- 残余窗口:Continuo 崩溃后到下次启动之间发现文件仍在,其中的管道名可被同机其它用户抢注。proxy 的 pid 存活检查
  挡住「写入者已死」的情形;但该 pid 若已被系统复用给别的进程,检查仍判为存活,此期间在 Continuo 终端外启动的
  proxy(不发 hello,不泄 token)仍可能连到对方管道收到伪造工具结果。下次启动即删除。

### POSIX stdio proxy 只连属于当前用户的 unix socket — `security-stdio-socket-owner.spec.ts`
- 攻击场景(macOS / Linux,多用户机器):项目级 MCP 配置(不可信仓库里的 `.mcp.json` 等)的 env 段把
  `CONTINUO_MCP_SOCKET` 指向同机其它用户监听的 unix socket。proxy 在 Continuo 终端里启动(env 带窗口 token),
  连上后在 hello 里把 `{windowId, token}` 发给对方 → 对方拿 token 调本用户的 127.0.0.1 HTTP MCP。
- 契约(`<posix-socket-trust>` 标记段直测 + 启动真实 proxy 的端到端):连接前对每个候选先 `realpath`,
  校验**解析后的路径**,并**连接解析后的路径**(不是原路径)——
  - 解析后的路径是 socket 且属主是当前用户;
  - 其父目录属主是当前用户且 group / other 不可写(否则他人可在校验与连接之间换掉 socket)。
  主进程把 socket 建在 0700 的 userData 里(`setupSocketDir`),必然满足。
  - 只校验原路径不够:路径中间有别人可改的符号链接(`/tmp/link/mcp.sock`)时,校验时指向本人的 socket、
    连接前换成指向别人的即可绕过;连接解析后的路径则与该链接此后的指向无关。
  - `realpath` / `stat` 失败(不存在、无权限 …)= 不可信(fail-closed),不再「交给连接去试」。
  - `CONTINUO_MCP_SOCKET` 指定的不满足 / 无法校验 → 报错退出:不连接、不发 hello、不透传(连上不发 hello 对方仍可伪造工具结果)。
  - 默认候选(packaged / dev)不满足 → 跳过并在 stderr 说明,继续试下一个。Windows 分支(管道名校验)不变。
- 行为变化:把 `CONTINUO_MCP_SOCKET` 指到 `/tmp` 等非本人目录的自定义用法不可用;指向符号链接的,只要解析后
  落在本人的可信目录里即可用(连接的是解析后的路径)。
- 残余:解析后路径的更上层祖先目录若他人可写且无 sticky 位,仍可在校验与连接之间被整体替换(只校验了直接父目录)。
- 残余:同一用户的其它进程监听的 socket 仍会通过校验(同 uid 进程本就能读终端 env 里的 token)。

### HTTP MCP 调用方身份绑定 Mcp-Session-Id — `security-http-mcp-session-subject.spec.ts`
- 攻击场景(已被提示注入、已获终端授权的 agent):HTTP 传输下 per-session capability 的 `callerSubject` 就是 bearer
  token,而 token 经 PTY env `CONTINUO_MCP_TOKEN` 注入每个终端;同用户进程可读其它进程环境(macOS `ps eww -ax` 实测
  可读同 uid 进程 env,Linux `/proc/<pid>/environ`)。攻击方 agent 读到受害终端 agent 的 token → 直接 POST /mcp 调
  read_output / send_input / kill / await_stop_hook 操作受害方经 HTTP 创建的会话。stdio 不受影响(subject 为每连接
  随机 uuid);默认接入方式是 stdio,本条只影响手动配置 HTTP 传输的用户。
- 契约:
  - `initialize` 响应头下发随机 `Mcp-Session-Id`(服务端生成,不进 env / 日志 / 响应体);带该头的请求
    `callerSubject = token + session id`。攻击方拿到 token 只能 initialize 出自己的新 session,身份与受害方不同。
  - 回带的 session id 不存在 / 属于别的 token → HTTP 404(MCP 规范:未知 session 回 404),工具不执行。
  - 未带该头的旧客户端 `callerSubject = token`(行为不变),与带 session 的客户端身份互不相通。
  - 单 token session 数上限,超限 initialize → 429;达上限时只驱逐**空闲超阈值、无在途请求、且名下无活跃资源**
    (debug 会话 / 在途 launch、在途终端创建、其创建且未退出的终端,`hasLiveResources`)的最旧 session,全部候选都有
    资源则仍 429 —— 防持 token 方反复 initialize 驱逐停在断点的受害方、杀其 debug 会话 / 让其终端沦为孤儿;
    session 随 `revokeToken` / `revokeWindowTokens` / `rotateToken` / `DELETE /mcp`(带 session id)释放。
  - session 每次被删除(DELETE / 空闲驱逐 → `closed`;`revokeToken` → `token-revoked`;`revokeWindowTokens` →
    `window-revoked`)都经 `onHttpSessionReleased(subject, cause)` 通知一次(幂等)。回收接线在
    `electron/main/services/mcp-revoker-wiring.ts`:`closed` 取消在途创建 + `killByController(subject,'session-closed')`;
    `token-revoked` 同样回收但 reason 为 `terminal-exit`,`byToken` 再回收 token 本身;`window-revoked` 不经此回收
    (窗口关闭由 `killByOwner('window-closed')` 与终端 kill 负责)。
- 残余(未收口):token 本身仍可被同 uid 进程读到(如 `ps eww`)。持 token 者可经 HTTP 或 stdio `_continuo/hello`
  被当作该窗口的绑定调用,复用该窗口的「本次启动期间允许」静默 create_session / debug_launch 等;per-session
  capability 仍生效(读控不了受害方的会话)。真正收口需把 token 绑定到持有终端的进程树,当前未做。未回带
  `Mcp-Session-Id` 的非规范客户端仍以 token 为身份。

### 生产 CSP 的 connect-src 不放行 localhost — `csp-localhost-dev-only.spec.ts`
- `index.html`(生产构建产物来源)的 connect-src 只含 `https:`(不含 `'self'`:file:// 源下 `'self'` = 全盘 file:,Worker 内 fetch 只有 CSP 能拦);`http://localhost:*` / `ws://localhost:*` /
  `wss://localhost:*` 只为开发期 Vite HMR,由 `scripts/vite-csp-dev-connect.ts`(`apply: 'serve'`)仅在 dev server
  加回。生产产物 `out/renderer/index.html` 不含 localhost,renderer 被注入脚本时不能借 CSP 探测本机端口服务。
- dev 变换找不到 connect-src 锚点即抛错(index.html 改 CSP 须同步插件,不静默丢失 HMR 来源)。
