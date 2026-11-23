# editor-hooks-react(useAutoSave / useEditorFile / useExternalFileSync)

行为契约:**Editor panel 用的几个 React hook 薄壳**

| 文件 | 责任 |
|---|---|
| `useAutoSave.ts` | enabled + activeTab.dirty + 有 filePath 时按防抖触发 saveFile |
| `useEditorFile.ts` | useMemo 包 openFileByPath / saveActive,saveActive 无 active tab 返 NO_ACTIVE_TAB |
| `useExternalFileSync.ts` | 订阅 fs:dir-changed,非 dirty 同 dir tabs 重读磁盘 → reloadFromDisk |
| `useAutoSave.ts` 内 `isAutoSaveEnabled` | 只有 .md/.markdown 返 true |

## 关键行为

### useAutoSave

- enabled=false → 不调
- 没 active tab / filePath null / dirty=false → 不调
- 满足条件 → delayMs 后调 saveFile;再次满足条件 → 防抖合并
- 已排队后 tab 变干净(Cmd+S / 关窗「保存」成功)→ 取消计时器;计时器到点 / 切 tab flush / 关窗 flush 执行时再读 store,tab 已不脏则不写盘(直接视为成功);保存后继续输入(仍脏)照常 autosave
- 切走 tab 时编辑器卸载回写(先于本 hook cleanup)把旧 tab 写脏、计时器里没有它 → cleanup 先补排队再 flush,按旧 tab 落盘;是否补排队按旧 tab 的 autosave 开关(schedule effect 看过的 enabled)判断,不按新 tab
- 计时器 / flush 执行时 tab 已关闭(找不到)→ 没有可保存的内容,不调 saveFile、不算失败(不弹「自动保存失败: TAB_NOT_FOUND」)
- enabled=false(设置关闭 / 暂停)期间没有 pending,关窗 flush 不会落盘 → 关窗脏文件计数不豁免该 tab;恢复后重新排队即清除

### 关闭脏 .md 的「放弃修改?」确认框 × autosave(`autosave-discard-confirm.spec.tsx`)

- 确认框开着期间暂停 autosave(EditorPanel 传 `enabled: autoSaveEnabled && closeCandidate === null`):停留超过 delay 不把待放弃的内容写盘
- 防抖窗口内确认放弃 → 不写盘、不弹失败提示
- 取消确认 → 恢复 autosave,仍脏照常 delay 后写盘

### isAutoSaveEnabled

- null → false
- 'a.md' / 'a.markdown' / 'a.MD' → true
- 'a.txt' / 'a.tsx' → false

### useEditorFile.saveActive

- activeTabId=null → ok=false code=NO_ACTIVE_TAB
- 有 → 调 underlying saveFile

### useExternalFileSync

- 注册 onDirChanged 订阅;hook unmount 时返 unsub
- 同时订阅本地 watch-restored(Explorer 重装失效 watcher 成功)→ 重读该目录**子树内**的 clean tab(macOS/Win watcher 递归,断线期间子目录变化同样丢失;普通 dir-changed 仍精确匹配直接父目录);子树重读有界并发(峰值在途 ≤ 32,同 hydrateEditorTabs),排队项发起时若该 path 已在途则并入尾随一次,不并发重复读;unmount 退订
- changedDir 命中 tab.filePath 父目录 + 非 dirty + 读盘 ok → reloadFromDisk
- dirty tab 跳过
- changedDir ≠ dirname → 跳过
- dir-changed 携带变更文件名集合 → 只重读文件名在集合内的 clean tab(rename 旧名/新名命中任一即可;文件名比较大小写 + NFC 宽松,宁多读不漏读);无集合(平台不给 filename / 缓冲溢出 / 超上限)→ 退化为按目录匹配
- symlink tab(tab.realPath = 读盘时 main 解析的链接真实目标,runtime only 不持久化):目录按 dirname(filePath) 或 dirname(realPath)、文件名按 basename(filePath) 或 basename(realPath) 匹配 → 同目录 `CLAUDE.md -> AGENTS.md` 外部改 AGENTS.md、跨目录链接目标所在目录变更都重读链接 tab;watch-restored 子树同理;重读结果的 realPath 回写 tab
- readFile ok=false → 跳过(不抛)
- 保存回声识别(性能):保存成功记录写入内容的 `{mtimeMs,size,ino}`(main 关闭写句柄后对 tmp stat、rename 后复核一致才返回);记录带进程内单调保存代际 `gen`(同写到运行时 `tab.savedGen`,记录不持有写入内容),命中的 clean tab `savedGen` 与记录 gen 一致时,先发廉价 `fs:stat` 比对 —— 一致 → 不 readFile;mtime/size/ino 变化(ino 区分粗粒度 mtime 文件系统上同大小的外部替换)、stat 失败(ok=false 或 reject)、记录已不对应 tab 基线(外部 reload 清 savedGen / 关闭重开的新 tab 无 savedGen)→ 照旧整文件读(不凭「刚保存过」跳过,外部同时写入照常同步)
