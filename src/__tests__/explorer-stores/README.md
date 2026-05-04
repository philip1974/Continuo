# explorer-stores (M-Explorer Step 3)

行为契约:**资源管理器三个 Zustand store + 跨进程持久化**。

对应 doc/08 § Zustand store 设计、ADR-007(Zustand vanilla 化)、ADR-012(持久化范围)。

## 模块

| 文件 | 内容 |
|---|---|
| `src/stores/workspace.store.ts` | `root` / `recentRoots`(LRU 5) |
| `src/stores/explorer.store.ts` | `activePath` / `selectedPaths` / `lastAnchorPath` / `expandedPaths` / `sort` / `search` + 多选 4 actions |
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
| `explorer.activePath` | ✅ | 焦点位置(VSCode 行为) |
| `explorer.sort` | ✅ | 用户偏好 |
| `pinned.paths` | ✅ | Pin 列表 |
| `explorer.selectedPaths` | ❌ | 多选只在当前会话有意义 |
| `explorer.lastAnchorPath` | ❌ | 仅 Shift+click 范围选用 |
| `explorer.search` | ❌ | 重启清空 |

数据形态:磁盘 JSON 全用 array,store 内部用 Set;`hydrate` / `snapshot` 负责互转。

## Spec 拆分

| 文件 | 主题 |
|---|---|
| `workspace.spec.ts` | LRU、setRoot 三态 |
| `explorer.spec.ts` | toggleExpand / 多选 4 actions / setSort / setSearch |
| `pinned.spec.ts` | toggle / 顺序保留 |
| `persistence-schema.spec.ts` | ExplorerSchema strict + version 锁 + loadExplorer/saveExplorer round-trip |
| `persistence-layer.spec.ts` | snapshot ↔ hydrate Set/array 转换、不持久化字段闭包、init flow(mock api) |

## 不在本主题验证

- IPC 通道注册行为(已在 fs-ipc-bridge / ipc-safe-handle 测过 safeHandle)
- 真 Electron 跨进程读写(留 E2E)
- React 组件订阅 store(留 Step 4 explorer-tree)
