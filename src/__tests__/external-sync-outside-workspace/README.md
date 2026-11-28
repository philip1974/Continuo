# 工作区外文件的外部修改同步(external-sync-outside-workspace)

行为契约:**工作区外的文件(以及没打开文件夹时的任何文件)被外部进程修改后,打开它的 tab 和工作区内文件一样自动同步
(干净 tab 重读、脏 tab 不覆盖);不可见期间的修改在再次可见时补上。**

对齐 VSCode:`editorService.handleVisibleEditorsChange` 对可见编辑器里不在工作区内的资源单独 `fileService.watch(resource)`,
不再可见即释放;`TextFileEditorTracker` 窗口获焦时重载可见的文本编辑器(「文件事件不总可靠」)。

## 行为

- **可见** = 各编辑器组的活动 tab。可见的工作区外文件(无标题文件、图片除外)经 `fs:watch-file` 让 main 监视其父目录;
  切走 / 关闭 tab 即 `fs:unwatch-file` 释放。工作区内的文件不走这条路(工作区根 watcher 覆盖)。
- main 只接受**本窗口经 `fs:read-file` 读过的文件**(main 自己记账),路径须是规范的绝对路径(含 `..` 等拒绝);对父目录装
  **非递归** watcher(工作区 watcher 在 macOS / Windows 是递归的,对 `~/Downloads`、`/` 这类父目录不可控),同目录多个文件共用
  一个(引用计数),按窗口记账(关窗 / renderer reload 释放);同时最多 `MAX_FILE_WATCHERS`(32)个目录,超出拒绝(不驱逐已有的)。
  变化照常经 `fs:dir-changed` 广播(带文件名),由外部同步按原规则处理(自动重读 / 冲突处理不变)。
- 不可见期间没有 watcher:打开时记下文件的 stat 指纹(mtime + size),再次可见时比对,变了就复查一次(干净 tab 重读、脏 tab 只查
  是否还在);窗口获焦时对可见的这类文件同样比对(图片 tab 只靠这条)。未变不读盘。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/useExternalSyncRootWatch.ts` | 可见工作区外文件的 watch 集合、stat 基线、再次可见 / 获焦比对 |
| `src/panels/Explorer/hooks/useFsWatcher.ts` | watcher 安装 / 竞态 / 失效重装(可换 IPC:`fs:watch` 或 `fs:watch-file`) |
| `electron/main/ipc/fs.ipc.ts` | `fs:watch-file` / `fs:unwatch-file`:已读文件校验、父目录非递归 watcher 池、上限、按窗口释放 |
| `electron/main/services/window-editor-documents.service.ts` | 每窗口经 `fs:read-file` 读过的文件登记 |

## Specs

| File | 覆盖 |
|---|---|
| `watch-file-main.spec.ts` | 只接受本窗口读过的规范路径;非递归父目录 watcher + 带文件名广播;同目录引用计数;reload / 关窗释放;数量上限 |
| `outside-workspace-watch.spec.tsx` | 工作区外 / 无文件夹时外部修改自动重读;工作区内 / 无标题 / 图片不 watch;不可见不 watch、切回补读、未变不读;获焦比对 |

e2e:`tests/e2e/external-sync-outside-workspace.spec.ts`(真实 watcher:工作区外日志被追加约 1s 内显示;无文件夹同样;切回后内容已更新)。
