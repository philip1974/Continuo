# cold-start-drag-folder (Issue #45)

Tracks issue #45 cold-start drag-folder behavior. Verifies the `fresh` query flag's routing in `initExplorerPersistence`: fresh+initialWorkspace overrides the persisted segment (root, UI, and editor tabs); no fresh keeps the existing restore behavior; the `workspace` query without `fresh` survives as the corrupted-snap fallback.

- 新窗口打开的目录(拖文件夹冷启动 / 命令行 / 「在新窗口打开文件夹」/ 段缺失时按 query 用作 root)进「最近打开」:本窗列表
  置顶,并作为启动期选择补发 `touchRecent` 交 main 合并落盘与跨窗广播(此前直接 setState 不经 setRoot,永远进不了最近列表)。

