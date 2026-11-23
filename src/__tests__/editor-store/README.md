# editor-store (M-Editor Step E1)

行为契约:**资源管理器编辑器 Zustand store**(由维护者早期项目的 Jotai 实现改写为 Zustand,使用 `zustand` 的 `create`)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/stores/editor.store.ts` | tabs / activeTabId / mode + 7 个 actions + createTab/getStateAfterClosingTab 纯函数 |

## EditorTab 模型(与 Mind 同源)

```ts
interface EditorTab {
  id: string;              // filePath || `untitled-${uuid}`
  filePath: string | null; // null = 未保存草稿
  content: string;         // 当前内容(编辑器实时同步)
  originalContent: string; // 上次磁盘内容(dirty 比对依据)
  dirty: boolean;          // = content !== originalContent
}
```

## 关键行为

### `openTab(tab)`
- 已存在(同 id)→ 不重复追加,只切 activeTabId 到该 tab
- 新 tab → 追加到 tabs,activeTabId = tab.id

### `closeTab(id)` 通过纯函数 `getStateAfterClosingTab` 计算
- 关非活跃 tab → tabs 减,activeTabId 不变
- 关活跃 tab,后面有 → 切到原索引位的下一个
- 关活跃 tab,后面没、前面有 → 切到前一个
- 关最后一个 tab → activeTabId = null
- 关不存在的 id → 状态不变

### `switchTab(id)`
- 切 activeTabId(无论 id 是否存在,UI 派生 activeTab 时 fallback)

### `editorFocusPulse`(issue #22)
- openTab / switchTab 每次 +1(同 id 也 +1),DockShell 据此激活 editor 面板
- `{ requestFocus: false }`(持久化会话恢复)→ 照常打开 / 切换,但 pulse 不变

### `updateContent(id, content)`(编辑器 onChange 时调用)
- tab.content = content
- dirty = (content !== originalContent)
- 不存在的 id → 不变(防止编辑器异步触发到已关闭 tab)

### `markSaved(id)`
- tab.originalContent = tab.content
- tab.dirty = false

### `setMode(mode)`
- 全局编辑模式切换:`'edit' | 'source' | 'preview'`

### `createTab(filePath, content)` 纯 helper
- 返回 EditorTab,id = filePath ?? `untitled-${crypto.randomUUID()}`
- originalContent = content,dirty = false

## 不在本主题验证

- React 组件订阅(Step E4)
- IPC 调用(Step E2 hooks)
- 自动保存 debounce(Step E2)
- Mode 切换的 UI 行为(Step E4)
