# editor-orphaned-tab

文件被删除时对齐 VSCode 的 orphaned 编辑器:tab 保留、标为「已删除」,自动保存不再把文件写回;手动保存照常按路径重建。
资源管理器里用户主动删除只保留有未保存修改的 tab(干净的关闭,VSCode 同);外部删除(git checkout 切到删除它的分支 /
外部 rm / mv)与工作区根消失时干净 tab 也保留(VSCode `workbench.editor.closeOnFileDelete: false`),文件重新出现即恢复。

## Contracts

- **标记**:tab 有仅运行时的 `orphaned` 标记(不进会话快照)。
  - Explorer 删除(`removePaths`):被删路径(目录含其下全部)的干净 tab 关闭(不变),脏 tab 保留并置 `orphaned`。
  - Explorer 撤销新建(撤销 = 删除刚建的文件)同 Explorer 删除。
  - 外部删除(`orphaned-external-clean.spec.tsx` / `orphaned-external-sync.spec.tsx`):`fs:dir-changed` 命中 tab 时,干净 tab 重读、脏 tab 只做廉价 `fs:stat`(不读内容、不动编辑);确认不存在(隔 `EXTERNAL_DELETE_CONFIRM_MS` 复查仍不存在,先删后建式替换不算)→ `markPathsDeleted`:干净 / 脏 tab 都**保留**并置 `orphaned`,不关闭、不换活动 tab、组内 MRU 不变;所在目录被外部改名 / 删除同样。文件重新出现(如切回原分支)→ 清除;干净 tab 按磁盘重载(内容相同则不重挂载视图,光标 / 撤销历史不丢)。同目录其它文件的变化(文件名集合不含本文件)不检查。
  - 有 tab 新被标记时发「已删除」路径通知(在文件中查找结果移除该文件、Quick Open 最近打开移除该路径,同 VSCode `SearchView.onFilesChanged` / `HistoryService.remove`;tab 之后再激活即重新记入最近打开)并移除其下的最近关闭条目;已标记的再次确认不重复通知。
  - 工作区根自身被改名 / 删除(`orphaned-root-gone.spec.tsx` / `root-presence-main.spec.ts`):fs.watch 对根自身只回调一次、filename = 根的 basename,按子项解析匹配不到 tab。main 在该回调(以及 Windows 删除被 watch 目录时的 watcher error)里 stat 根:不存在 → 向所有窗口推 `fs:root-presence-changed`(`{ path }`,不带文件名;preload 按 dir-changed 同一守卫校验);此前推过消失、之后同一回调时根又存在(改回原名 / 重建)→ 再推一次;根仍在且未消失过(根下恰有同名子项)→ 不推。渲染端收到后复查根下全部 tab(同 watch-restored 子树复查:干净重读、脏 stat,有界并发),按上一条统一标记 / 清除。
    - 平台:macOS 递归 FSEvents 按路径监视,改名 / 删除 / 改回 / 重建都回调同一 basename,全覆盖。Linux inotify 对根自身的 IN_MOVE_SELF / IN_DELETE_SELF 同样以 basename 回调 → 消失可检测;inotify 跟随 inode,删除后 watch 失效、重建不再回调(不自动恢复,文件之后被访问 / 保存才清除),改名再改回仍回调。Windows ReadDirectoryChangesW 不报根自身:删除 → watcher error(EPERM)→ 检测消失;重建后 watch-lost 退避重装成功 → watch-restored 复查清除;改名不回调,检测不到。
  - 清除:重命名 / 移动到新路径、保存成功(手动保存重建文件)、文件重新出现、还原 / 重新读到磁盘内容。
    - 应用内保存过的文件被 mv 走再 mv 回(或工作区根改名再改回):mv 不改 mtime / size / ino,磁盘 stat 仍与保存记录一致;
      已标记的 tab 不做「自己保存的回声」判断(否则跳过读盘、标记永远不清),照常读盘清除;未标记时回声识别照旧省掉整文件读。
  - 标记变化 bump `chromeVersion`,tab 栏随之重渲。
- **tab 栏**:orphaned tab 的文件名加删除线,后缀「(已删除)」/ `(Deleted)` / `(삭제됨)`(VSCode:strikethrough + "(Deleted)")。
- **自动保存**:orphaned tab 不自动保存(已排队的取消;切走 / 关窗 flush 也跳过),删除后文件不会在自动保存延迟后「又出现」;该 tab 仍按未落盘的脏文件计入关窗确认。
  - 外部删除尚未被确认(防抖 + stat + 延迟复查约 0.8–1.5s)时自动保存先到点(含切走 / 关窗 flush):自动保存以 `recreateMissing: false` 保存,读盘确认文件不存在 → 不写回、就地置 `orphaned`,按未落盘处理,不弹「自动保存失败」提示。
- **手动保存**(⌘S / 关闭时选「保存」):照常写盘(VSCode 同样重新创建文件),成功后清除 orphaned。所在目录也已删除时保存失败(atomic-write 不建父目录),提示找不到文件。
- **Explorer 删除确认**:删除涉及有未保存修改的 tab → 确认框追加未保存警告(按数量用单 / 复数句式:只删这一个脏文件 →「该文件有未保存的更改…其编辑器」;多项 / 文件夹里只有 1 个脏 →「其中 1 个文件…其编辑器」;2 个及以上 →「其中 N 个文件…它们的编辑器」);此时即使关掉了「删除前确认」设置也照样确认(VSCode 的未保存警告不受 `explorer.confirmDelete` 控制)。无未保存 tab 时行为不变。
  - 确认框打开期间、以及确认后移到废纸篓在途期间,被删路径(含子路径)下 tab 的自动保存暂停(`autosave-hold.ts`,同关闭脏 tab 的确认框开着时暂停):确认框停留超过自动保存延迟再确认,脏 tab 仍保留并标记已删除,修改不写回磁盘 —— 与框内文案一致;取消则恢复,仍脏照常保存。
- **重启**:`orphaned` 是 runtime only;会话快照只有路径,重启时读不到的文件 tab 不恢复(VSCode 会恢复并显示已删除;这里没有可显示的内容,干净 tab 的内容就是已删除的磁盘内容)。
- **⇧⌘T**:外部删除不再关闭 tab,不涉及最近关闭栈;用户关闭已删除的 tab 照常入栈。
- 与 VSCode 的差异:VSCode 从 Explorer 删除时会先丢弃(soft revert)未保存修改并关闭编辑器;本项目保留编辑器与修改(只标记已删除),数据更安全,警告文案按此说明。

## Modules

| File | Role |
|---|---|
| `src/stores/editor.store.ts` | `EditorTab.orphaned`、`removePaths` / `markPathsDeleted` 置位、`renamePath` / `markSaved` / `reloadFromDisk` 清除、`setOrphaned`、`countDirtyTabsUnder` |
| `src/panels/Editor/useExternalFileSync.ts` | 外部删除确认(干净重读 / 脏 stat + 延迟复查)、根消失 / 恢复时复查子树 |
| `electron/main/ipc/fs/watch.ts` / `electron/main/ipc/fs.ipc.ts` | `createRootPresenceTracker`;生产 watcher 在根 basename 回调 / error 时检测根消失并广播 `fs:root-presence-changed` |
| `electron/preload/index.ts` | `fs.onRootPresenceChanged`(payload 守卫) |
| `src/panels/Editor/useAutoSave.ts` | orphaned 跳过自动保存;自动保存不重建已删除的文件;被 hold 的路径暂停 |
| `src/panels/Editor/autosave-hold.ts` | 按路径暂停自动保存(Explorer 删除确认 / 删除在途) |
| `src/panels/Editor/editor-file-actions.ts` | `saveFile` 的 `recreateMissing: false`:不存在则不写、置 orphaned |
| `src/panels/Editor/EditorHeader.tsx` | 删除线 +「(已删除)」 |
| `src/panels/Explorer/FolderTree.tsx` | 删除确认框的未保存警告;确认框打开 / 删除在途时 hold 被删路径的自动保存 |
| `orphaned-store.spec.ts` / `orphaned-panel.spec.tsx` / `orphaned-external-sync.spec.tsx` / `orphaned-external-clean.spec.tsx` / `orphaned-root-gone.spec.tsx` / `root-presence-main.spec.ts` / `orphaned-trash-confirm.spec.tsx` | 上述契约 |
| `tests/e2e/editor-orphaned-tab.spec.ts` | 真实 Electron:编辑 .md 后删除 → tab 显示已删除、过了自动保存延迟文件也不被写回;删除紧贴自动保存到点前也不写回;确认框停留超过自动保存延迟再确认,tab 仍保留并标记已删除 |
| `tests/e2e/external-delete-keep-tab.spec.ts` | 真实 Electron:git checkout 式外部删除 → 干净 tab 保留并显示已删除,切回后标记清除;工作区根改名 → 打开的 tab 显示已删除,改回后清除;应用内保存后 mv 走再 mv 回 / 根改名改回,保存过的 tab 同样清除 |
