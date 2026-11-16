# useFsWatcher(Explorer 展开路径 ↔ fs.watch)

行为契约:**`useFsWatcher(expandedPaths, onChange)` 同步展开集合到 main 的 fs.watch:
新增展开 → watchDir,折叠 → unwatchDir。订阅 fs:dir-changed 事件,debounce 100ms
后回调 onChange(path)。Hook 卸载时全 unwatch + cancel debouncer。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/hooks/useFsWatcher.ts` | hook |
| `src/panels/Explorer/fs-watch-helpers.ts` | diffSets / makeDebouncePerPath(已测) |

## 关键行为

### expandedPaths 变化

- new = expandedPaths,prev = 上次同步的集合
- added(new \ prev) → watchDir 各一次
- removed(prev \ new) → unwatchDir 各一次

### 订阅 fs:dir-changed

- 注册一次 onDirChanged,debounce 100ms 后调 onChange
- 同一 path 100ms 内多次只触发一次(由 debouncer 实装,本 hook 仅装上)

### fs:watch-lost(main 因 FSWatcher error 驱逐了本窗持有的 watcher)

- 仅对账本中已安装的 path 生效:移出账本、作废在途尝试,立即调一次 onChange(path) 刷新该目录
- 退避延迟后(首次 2s,同一 path 连续失效逐次翻倍,上限 60s;折叠即复位)若仍展开且未被重装 → 重新 watchDir
- 重装失败(卷仍不可用:watchDir ok:false / reject)→ 继续按同一退避续排重试,直到成功或折叠/卸载
- 重装成功 → 再调一次 onChange(path) 并本地分发 `emitWatchRestored(path)`(`src/lib/fs-watch-restored.ts`),
  补断线期间的变化;首次正常安装不分发
- 「失效未恢复」标记按 path 记录:退避期间普通 diff 抢先重装(展开别的目录 / 折叠重开同一 path)成功同样补刷新 +
  分发并清标记(原定时器见已安装即退出);每次失效只分发一次
- 延迟期间折叠 → 不重装;卷持续断开不会形成高频重试
- 折叠(path 不再在 expandedPaths)即清零 lostCount 并取消待重装定时器,不论是否在账本中(lost 已移出账本);
  折叠—重开后的下一次失效从 2s 重新退避

### 卸载

- onDirChanged / onWatchLost unsub,取消待重装定时器
- 当前 prevPathsRef 全部 unwatchDir
