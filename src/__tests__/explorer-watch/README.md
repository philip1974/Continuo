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
