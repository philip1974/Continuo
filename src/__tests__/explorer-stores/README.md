# explorer-stores (M-Explorer Step 3)

行为契约:**资源管理器三个 Zustand store + 跨进程持久化**。

对应 doc/08 § Zustand store 设计、ADR-007(Zustand vanilla 化)、ADR-012(持久化范围)。

## 模块

| 文件 | 内容 |
|---|---|
| `src/stores/workspace.store.ts` | `root` / `recentRoots`(LRU 5) |
| `src/stores/explorer.store.ts` | `expandedPaths` / `sort` + `toggleExpand` / `setExpandedPaths` / `setSort`(多选由 headless-tree selection state 驱动;`activePath`/`search` 是死字段已删,见下) |
| `src/stores/pinned.store.ts` | `paths` 顺序保留 + `toggle` |
| `electron/main/persistence.ts` | 复用,追加 `ExplorerSchema` / `loadExplorer` / `saveExplorer` |
| `electron/main/ipc.ts` | 追加 `explorer:read` / `explorer:write` 通道(走 safeHandle) |
| `electron/preload/index.ts` | 追加 `window.api.explorer.{read,write}` |
| `src/lib/persist/explorer-persist.ts` | `initExplorerPersistence(api)`:hydrate + debounce 300ms 写 |

## 持久化范围(ADR-012,VSCode 风)

| 字段 | 持久化 | 理由 |
|---|---|---|
| `workspace.root` / `recentRoots` | ✅ | 重启恢复 |
| `explorer.expandedPaths` | ✅ | 树展开状态 |
| `explorer.sort` | ✅ | 用户偏好 |
| `pinned.paths` | ✅ | Pin 列表 |

> 多选状态(selectedPaths / anchor)现由 headless-tree 的 selection state 持有,
> 不在本 store,也不持久化(只在当前会话有意义)。
>
> `explorer.activePath`(打磨 R18):曾是焦点字段,但从无生产 setter/reader(恒
> null)。已从 runtime store 移除;磁盘 schema 维持兼容(snapshot 写保留位
> null,hydrate 忽略旧值),故仍出现在 ExplorerSchema 与持久化 round-trip 测试里。
>
> `explorer.search`(打磨 R19):曾是搜索串字段(从不持久化),但生产 Explorer UI
> 从无读写。已从 runtime store 与 hydrate 复位路径整体移除;等真正实现 Explorer
> 搜索 UI 时再按实际交互重新引入。

数据形态:磁盘 JSON 全用 array,store 内部用 Set;`hydrate` / `snapshot` 负责互转。

## Spec 拆分

| 文件 | 主题 |
|---|---|
| `workspace.spec.ts` | LRU、setRoot 三态 |
| `explorer.spec.ts` | toggleExpand / setExpandedPaths / setSort |
| `pinned.spec.ts` | toggle / 顺序保留 |
| `persistence-schema.spec.ts` | ExplorerSchema strict + version 锁 + loadExplorer/saveExplorer round-trip |
| `persistence-layer.spec.ts` | snapshot ↔ hydrate Set/array 转换、不持久化字段闭包、init flow(mock api) |

## 不在本主题验证

- IPC 通道注册行为(已在 fs-ipc-bridge / ipc-safe-handle 测过 safeHandle)
- 真 Electron 跨进程读写(留 E2E)
- React 组件订阅 store(留 Step 4 explorer-tree)
