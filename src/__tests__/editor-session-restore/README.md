# editor-session-restore(Editor tab session 持久化与恢复)

行为契约:**editor 打开的文件路径列表 + active 路径作为 `explorer.json`
的一部分(字段 `editor`)持久化。重启时从磁盘 read 内容并 `openTab`
恢复。dirty 改动**不持久化**(VSCode hot exit 不在 MVP 范围)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/persist/explorer-persist.ts` | snapshot/hydrate + `hydrateEditorTabs(snap, fs)` async helper + `initExplorerPersistence(api, extras)` |
| `src/stores/editor.store.ts` | tabs / activeTabId / openTab / switchTab |
| `src/main.tsx` | 启动时把 `coApi.fs` 注入 `initExplorerPersistence` extras |

## Snapshot 字段(扩展 `ExplorerSnapshot`)

```ts
editor?: {
  openFilePaths: string[];   // 顺序 = useEditorStore.tabs(过滤 filePath=null)
  activePath: string | null; // active tab 的 filePath;active 是 untitled → null
}
```

> `editor` 字段为可选 — 旧 `explorer.json` 不含本字段时,hydrate 仅恢复
> workspace / explorer / pinned / layoutUi。

> 不持久化 `content` / `originalContent` / `dirty`:启动时从磁盘读最新
> 内容。意味着关闭前未保存的改动会丢失(MVP 不做 hot exit)。

## 关键行为

### snapshotFromStores · editor 字段

- 起始 tabs=[] → `editor.openFilePaths=[]` + `activePath=null`
- 多个 file tab → openFilePaths **顺序与 store.tabs 一致**
- 含 untitled tab(filePath=null)→ 不进 openFilePaths(无路径无法恢复)
- active 是 file tab → activePath = 该 tab 的 filePath
- active 是 untitled / activeTabId=null → activePath=null

### hydrateEditorTabs(snap, fs) · async

- snap.editor 缺失 → noop
- snap.editor.openFilePaths=[] → noop
- 多 path → 并发 fs.readFile,**只为 ok 结果** openTab(create with content),保持顺序
- 单个 readFile 失败(文件被删 / 移动)→ 跳过该 path,继续其他
- 全部失败 → tabs 仍为空,activeTabId 不变
- activePath 在已恢复 tabs 内 → `switchTab(activePath)`
- activePath 不在已恢复 tabs 内(被跳过)→ 不调 switchTab(让 store 自然行为)

### initExplorerPersistence(api, extras) · 集成

- `extras.fs` 提供 + snap 含 editor → 先 sync hydrateStores,再 await hydrateEditorTabs
- `extras.fs` 不提供 → editor 段忽略(只 hydrate workspace 等)
- 订阅 `useEditorStore` → store 变化触发 debounce write(snapshot 含最新 editor 字段)
- subscribe 在 hydrate 完成后才 attach:避免 hydrate 写入触发回环 write

## 不在本主题验证

- workspace / explorer / pinned / layoutUi 字段持久化 — `explorer-persist` / `persistence-layer` 持有
- editor.store 内部 reducer(openTab / switchTab)— `editor-store` 持有
- coApi.fs IPC 真实行为 — 由 fs spec 持有
