# explorer-watch (M-Explorer Step 6)

行为契约:**fs.watch 增量更新**。外部修改(Finder/编辑器/git checkout)目录内容时,
Explorer 自动反映,不需手动刷新。

## 架构

```
┌─ main 进程 ────────────────────────────────────────┐
│ watcherPool(MAX 64,LRU)                          │
│   start(path):fs.watch(path, recursive*)           │
│     → onChange → webContents.send(fs:dir-changed)  │
│   stop(path):最后一个引用释放时 watcher.close()    │
│ fs:watch / fs:unwatch IPC handlers(走 safeHandle)  │
└─ preload ──────────────────────────────────────────┘
│ coApi.fs.watchDir / unwatchDir                     │
│ coApi.fs.onDirChanged(cb) → unsubscribe            │
└─ renderer ─────────────────────────────────────────┘
│ useFsWatcher(expandedPaths, onChange):             │
│   diff(prev, next) → 调 watchDir/unwatchDir        │
│   onDirChanged → debouncePerPath(100ms) → onChange │
│ FolderTree 把 onChange = (path) =>                  │
│   tree.getItemInstance(path).invalidateChildrenIds │
```

## 决策(Step 6 草案确认)

1. **watch 粒度**:展开即 watch,折叠即 unwatch(VSCode 风,大 monorepo 不爆 watcher)
2. **change 时 UX**:静默刷新树
3. **debounce**:同一 path 100ms 合并多事件(连续事件最长等 1s 必触发一次)
4. **chokidar fallback**:不加。*macOS / Windows 用 recursive watch;Linux 的 fs.watch 不支持 recursive,按目录 non-recursive 监听

## 模块拆分

| 文件 | 职责 |
|---|---|
| `electron/main/ipc/fs/watch.ts` | createWatcherPool 工厂 — 纯函数(creator 注入便于测)|
| `electron/main/ipc/fs.ipc.ts` | 加 watch / unwatch handler + 真 fs.watch + webContents.send |
| `electron/shared/fs-channels.ts` | 加 WATCH / UNWATCH / DIR_CHANGED |
| `electron/preload/index.ts` | `fs.watchDir / unwatchDir / onDirChanged`(renderer 经 `coApi.fs.*` 调用) |
| `src/panels/Explorer/fs-watch-helpers.ts` | diffSets / makeDebouncePerPath 纯函数 |
| `src/panels/Explorer/hooks/useFsWatcher.ts` | React hook 编排 |
| `src/panels/Explorer/FolderTree.tsx` | 接 useFsWatcher,onChange → invalidate |

## BDD 覆盖

### `watch-pool.spec.ts`(主进程纯函数)
- watch(path) 调 creator 一次
- 重复 watch 同 path 共享 watcher(creator 不再调),按引用次数 unwatch
- unwatch(path) 调 watcher.close
- has(path) 反映状态
- size() 计数正确
- 满 MAX_WATCHERS=64 时 watch 新 path → LRU 踢最早(close + 释放槽位)
- `isPinned` 为真的路径(生产 = 任一窗口当前 workspace root)不参与驱逐,踢最旧的非钉住项;全部钉住时退回踢最旧者
  (LRU 驱逐不调 onLost、持有者不会重装,root 被踢会让外部修改同步静默失效;也不改成驱逐走 onLost,否则重装循环抖动)
- unwatch 不存在的 path → 无操作不抛

### `fs-watch-helpers.spec.ts`(渲染端纯函数)
- diffSets(prev, next) 返回 { added, removed }
- diffSets 空集合边界
- makeDebouncePerPath(100, fn):同一 path 短时间内多次 → 只调最后一次
- makeDebouncePerPath:不同 path 互不影响
- cancel() 清掉所有 pending timer

## 不在本主题验证

- 真实 fs.watch 触发 OS 事件(留手动 / E2E)
- ipcMain 事件跨进程到达 renderer(留 E2E)
- React hook 集成行为(useFsWatcher 是薄壳,逻辑都在 helpers,留 E2E)
- 多窗口 / popout 场景下 watcher 与 webContents 关联(留 popout 里程碑)

## 同 tick 同路径合并广播(性能审计 #1)

macOS/Win 每个展开目录各有一个 recursive watcher,一次变更会被根及每个已展开祖先的 watcher
各回调一次,且 `resolveWatchChangedPath` 算出的 changedPath 与报告的祖先无关(都是同一个绝对目录)。
生产回调经 `queueDirChangedBroadcast`(`createSameTickPathCoalescer`)入队:同一 tick 内同一路径
只向每个窗口发一次 `fs:dir-changed`,不同路径按首次出现顺序各发一次,延迟一个 `setImmediate`。

未采用「祖先已 recursive 覆盖则不建子 watcher」:watcher 回调无 filename(Win
ReadDirectoryChangesW 缓冲溢出 / 旧 macOS)时只广播 watcher 根路径 —— 子目录不再有自己的 watcher
就收不到自身路径的刷新,invalidation 行为不一致;另需在祖先 unwatch / LRU 驱逐 / error 驱逐时
级联重建或 watch-lost 通知被覆盖的子路径,风险大于收益。

## dir-changed 跳过从未加载子项的目录(`folder-tree-dir-changed-unloaded.spec.tsx`)

macOS/Win 根目录 recursive watcher 对任意深度变更都上报其所在目录,包括 `.git` / `node_modules` /
构建产物等 listDir 默认排除、树上不显示的目录。headless-tree 的 `getItemInstance` 对未知 id 现建临时
实例,`invalidateChildrenIds` 仍会 listDir + 写缓存 + rebuildTree。`refreshParent` 因此在目录非 root
且 `dataRef.childrenIds[path]` 未定义(子项从未加载)时直接跳过:

- 树上不显示 / 已显示但从未展开过的目录变更 → 不触发 listDir
- root 变更 → 照常刷新
- 已加载的目录(展开中,或已折叠但子项仍缓存)变更 → 照常刷新

`useExternalFileSync` 等其它 `onDirChanged` 订阅者不经 `refreshParent`,不受影响。

未做:刷新后清理已消失子项的 `itemData` / 被删子目录的 `childrenIds`。焦点 / 选中等状态可能仍引用
被删 id,`getFocusedItem` 对其返回现建实例,而本树未配 `createLoadingItemData` → 清掉 itemData 后
`isItemFolder` 读 `null.isDirectory` 抛错;保留缓存是这些陈旧引用安全的前提。

## 侧栏隐藏期间延后刷新(perf,`folder-tree-hidden-defer.spec.tsx`)

- ExplorerSidebar 关闭时文件树保活(隐藏),watcher 不卸载;`ExplorerVisibleContext=false` 期间
  dir-changed 不 invalidate/listDir,只记脏目录(从未加载子项的非 root 目录直接忽略)
- 再次显示时对每个脏目录各刷新一次;显隐本身不触发 unwatchDir / listDir
- 隐藏前的滚动位置在再次显示时恢复

## renderer reload 释放该窗口的 watcher 引用(`fs-watch-release-on-reload.spec.ts`)

- watch 引用按 BrowserWindow id 记账;sender 主框架非同文档导航(reload)即释放该窗口全部引用(与关窗
  `releaseFsWatchersForWindow` 同一 `unwatchByOwner` 路径),新文档重新 watch 后折叠一次即关闭 fs.watch
- 同文档导航(hash / pushState)不释放;其它窗口对同一路径的引用不受影响
- 生产池钉住 workspace root:root 最早 watch、之后再 watch 超过 64 个目录,root 的 fs.watch 不被关闭

## 目录列表不变的刷新不 rebuild(perf,`folder-tree-refresh-skip-unchanged.spec.tsx`)

原子保存(本应用写 `.<name>.continuo.tmp` 再 rename;vim / VSCode 等外部编辑器同理)只产生 rename 事件,
dir-changed 不是 changeOnly → Explorer 刷新所在目录。listDir 便宜,贵的是 headless-tree 整树 rebuild。

- `refreshParent` 先 listDir,与缓存子项比较(`sameTreeChildren`:顺序 + path + name + isDirectory + isSymlink;
  size / mtime / ctime 不显示且按 FileEntry 契约是快照,不比较)→ 完全相同则不 invalidate / 不 rebuild
- 新增 / 删除 / 改名 / 类型变化 / 符号链接标记变化 → 用这次 listDir 结果写缓存并 rebuild 一次(不二次 listDir)
- 外部原子保存:tmp 出现与 rename 落在同一 debounce 窗口 → 最终列表不变,不 rebuild;比较时 tmp 仍在 →
  刷新(无论是否显示隐藏文件,缓存须如实),rename 后再刷新一次
- 同目录并发刷新只应用最后发起的那次(乱序完成亦然:最早的请求最慢、中间的先完成后再发起新刷新 → 仍只应用最新);比较期间折叠 → 缓存照常更新;卸载 → 在途结果丢弃
- listDir 失败 / 缓存已失效 → 走原 invalidateChildrenIds 路径(原失败告警与清空语义)
