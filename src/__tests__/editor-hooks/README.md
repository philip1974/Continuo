# editor-hooks (M-Editor Step E2)

行为契约:**编辑器文件操作 + 自动保存**纯函数层。
React hook 是薄壳(Step E4 接入 EditorPanel),业务逻辑都在纯函数里,本主题测它们。

## MVP 范围(简化)

只做 3 个文件操作 + 1 个 autosaver:
- `openFileByPath(path, deps)` — Explorer 单击触发
- `saveFile(tabId, deps)` — Cmd+S 触发(已有 filePath 才能保存)
- `updateActiveContent(content, deps)` — 编辑器 onChange,只是包 store action 的语法糖
- `makeAutoSaveScheduler(saveFile, delayMs)` — debounce 调度器

**不做**:Cmd+O / Cmd+N / 另存为(需要 fs:open-dialog/save-dialog,LayoutMotion 暂无这两个 IPC,留下里程碑)。
新建/打开文件统一走 Explorer 右键菜单 + 单击。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/editor-file-actions.ts` | 纯函数 openFileByPath / saveFile |
| `src/panels/Editor/auto-save.ts` | makeAutoSaveScheduler(类似 fs-watch-helpers 风格) |
| `src/panels/Editor/useEditorFile.ts` | 薄壳 hook(注入 deps,UI 层用) |
| `src/panels/Editor/useAutoSave.ts` | 薄壳 hook(订阅 activeTab,enabled 时 schedule) |

## 关键行为

### `openFileByPath(path, deps)`
- 已开过同 path → 不重读,只 switchTab → ok
- fs.readFile 成功 → createTab + openTab → ok
- fs.readFile 失败 → 不 open,返 `{ok:false, code, message}` 透传

### `saveFile(tabId, deps)`
- tab 不存在 → ok:false code='TAB_NOT_FOUND'
- tab.filePath === null → ok:false code='UNSAVED_DRAFT'(MVP 不支持另存为)
- fs.writeFile 失败 → 透传 IpcFail
- 成功 → store.markSaved(id),返 ok

### `makeAutoSaveScheduler(saveFile, delayMs)`
- `schedule()`:连续 N 次只调 saveFile 1 次(按最后一次的 delayMs)
- `cancel()`:清掉 pending,saveFile 不被调
- saveFile 抛错时 swallow + console.warn

## 不在本主题验证

- React hook 真集成(留 E4 集成时手验)
- IPC 真跨进程(已在 fs-ipc-bridge 测)
- store 行为(已在 editor-store 测)
- 关闭脏 tab 弹窗(留 E4 EditorPanel 状态机)
