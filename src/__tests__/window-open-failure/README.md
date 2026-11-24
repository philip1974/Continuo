# 主进程开新窗口失败的用户提示

行为契约:**由主进程发起的「开新窗口」(应用菜单 / Dock 菜单的「新建窗口」「在新窗口中打开文件夹」、
macOS open-file、second-instance 传入目录、冷启动多目录)失败时,用户看到本地化错误对话框,
不产生 unhandled rejection。**

开新窗口要先在 `explorer.json` 分配 windowSeq(读 + 写);磁盘满(ENOSPC)或 userData 无读写权限
(EACCES)时会 reject。主进程入口原先都是 `void openXxx()`,完全静默。

两条路径共用 `openWorkspaceWindowWith`(`window.ipc.ts`):分配 windowSeq 的 node errno 在此归到 `FS_*` 业务码
(`mapNodeErrnoCode`),故 renderer 经 `coApi.window.create`(命令面板「新建窗口」/「在新窗口打开文件夹」)失败
的 notify 与主进程菜单路径按同一 code 本地化(此前 renderer 路径只显示英文 errno 原文)。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/lib/run-window-open.ts` | `runWindowOpen(fn, ui)`:吞掉 fn 的异常(含同步抛出),以 `menu.file.window_open_failed` 为标题、按错误码(`errors.<CODE>`,未收录的 node errno 经 `mapNodeErrnoCode`)本地化原因 + 原始错误文本为详情提示 |
| `electron/main/index.ts` | 所有主进程开窗入口经 `runWindowOpen` 调用;提示用 `dialog.showMessageBox`(无 main→renderer 推送通道,同 VSCode 主进程 `dialogMainService.showMessageBox`) |

## 关键行为

- 失败:不抛、不 reject;弹一次错误对话框(同一批 second-instance / 冷启动目录在首个失败处停止,只提示一次)。
- 成功:返回 fn 结果,不提示。
- 提示文案按当前语言在失败当时取。
