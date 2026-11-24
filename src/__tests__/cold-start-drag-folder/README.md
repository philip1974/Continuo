# cold-start-drag-folder (Issue #45)

Tracks issue #45 cold-start drag-folder behavior. Verifies the `fresh` query flag's routing in `initExplorerPersistence`: fresh+initialWorkspace overrides the persisted segment (root, UI, and editor tabs); no fresh keeps the existing restore behavior; the `workspace` query without `fresh` survives as the corrupted-snap fallback.

- 新窗口打开的目录(拖文件夹冷启动 / 命令行 / 「在新窗口打开文件夹」/ 段缺失时按 query 用作 root)进「最近打开」:本窗列表
  置顶,并作为启动期选择补发 `touchRecent` 交 main 合并落盘与跨窗广播(此前直接 setState 不经 setRoot,永远进不了最近列表)。

## fresh 是一次性启动参数,刷新不再当新窗口 — `reload-after-fresh.spec.ts`

- `consumeStartupQuery(location, history)`(`src/lib/initial-workspace.ts`)解析 windowSeq / workspace / fresh 后,
  用 `history.replaceState` 只去掉 `fresh`(保留 windowSeq、workspace、其它参数与 hash;无 fresh 或超长 query 不改地址)。
- 之后任何刷新(View → Reload / Force Reload、dev 同 URL 刷新、DevTools 刷新)的 URL 与 restore-loop 开窗一致:
  本窗段存在 → 按段恢复 root / 展开 / 侧栏 / 编辑器 tab;段缺失 → workspace 仍作 root 回退。
- 此前 fresh 留在 URL 里,fresh 开的窗口(新窗口打开文件夹 / 命令行 / 拖文件夹到 Dock)换 root 开文件后刷新,
  会走 hydrateStoresForNewWindow 覆盖本窗段:root 回退、tab 全丢,并写回磁盘。
- 对照 VSCode `CodeWindow.reload`:重载时清掉 filesToOpenOrCreate 等一次性配置、保留 workspace。
