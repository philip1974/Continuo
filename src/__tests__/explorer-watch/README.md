# explorer-watch (M-Explorer Step 6)

行为契约:**fs.watch 增量更新**。外部修改(Finder/编辑器/git checkout)目录内容时,
Explorer 自动反映,不需手动刷新。

## 架构

```
┌─ main 进程 ────────────────────────────────────────┐
│ watcherPool(MAX 64,LRU)                          │
│   start(path):fs.watch(path, non-recursive)        │
│     → onChange → webContents.send(fs:dir-changed)  │
│   stop(path):最后一个引用释放时 watcher.close()    │
│ fs:watch / fs:unwatch IPC handlers(走 safeHandle)  │
└─ preload ──────────────────────────────────────────┘
│ window.api.fs.watchDir / unwatchDir                │
│ window.api.fs.onDirChanged(cb) → unsubscribe       │
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
3. **debounce**:同一 path 100ms 合并多事件
4. **chokidar fallback**:不加,Linux 走 fs.watch(我们 non-recursive,Linux 也支持)

## 模块拆分

| 文件 | 职责 |
|---|---|
| `electron/main/ipc/fs/watch.ts` | createWatcherPool 工厂 — 纯函数(creator 注入便于测)|
| `electron/main/ipc/fs.ipc.ts` | 加 watch / unwatch handler + 真 fs.watch + webContents.send |
| `electron/shared/fs-channels.ts` | 加 WATCH / UNWATCH / DIR_CHANGED |
| `electron/preload/index.ts` | window.api.fs.watchDir / unwatchDir / onDirChanged |
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
- closeAll() 清空所有
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

## 本进程原子保存不触发整目录刷新(perf,`atomic-replace-change-only.spec.ts`)

原子保存(写 `.<name>.continuo.tmp` 再 rename 覆盖)在 macOS 只产生 rename 事件(先一 tick 只有 tmp,
再一 tick tmp + 目标名),旧 changeOnly 判定恒 false → 每次保存 Explorer 都整目录 listDir。

- 覆盖**已有**普通文件:`atomicWriteFile` 写 tmp 前登记目标名 + tmp 名(rename 前续期,TTL 2s,条目上限);
  合并器 flush 时该目录本 tick 文件名**全部**是登记名 → `changeOnly: true`(files 照常携带,外部同步不受影响)
- 批中出现目标名即消费登记(连同 tmp),**不论该批结论**(混入外部文件名的批、全 change 事件的批同样消费):
  之后同名的外部删除 / 改名按原语义刷新;只见 tmp(目标事件未到)不消费
- 该目录本批文件名未知(超上限 / 缺 filename)→ 清掉该目录全部登记;目录新装 watcher(`fs:watch`)前同样
  清掉该目录登记(Linux 未展开目录不 watch,闲置登记不得吞掉展开后的外部删除)
- 按登记判为 changeOnly 的批:发出后异步 lstat 复查被消费的目标,已不存在 / 不再是普通文件 / 复查出错
  (保存与外部删除同批)→ 补发一次非 changeOnly(同一广播通道);目标仍在 → 不补发
- 新建文件、混入未登记文件名、缺 filename、TTL 过期、tmp 撞上 crash 残留(其删除对显示隐藏文件的树可见)
  → 不按 changeOnly(刷新)
- 残余:目录不在任何 watcher 覆盖下时登记最多闲置 2s;其间若祖先新装 recursive watcher(macOS/Win)后外部
  删除该文件,先发 changeOnly,再由上面的 lstat 复查补发刷新(延迟一次 lstat,不漏)
- 目录 / 文件名逐字比较,不做大小写 / NFC 折叠:字面不一致只会多刷新,不会漏刷新
