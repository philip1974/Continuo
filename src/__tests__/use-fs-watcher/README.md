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

### 卸载

- onDirChanged unsub
- 当前 prevPathsRef 全部 unwatchDir
