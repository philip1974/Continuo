# editor-hooks (M-Editor Step E2)

行为契约:**编辑器文件操作 + 自动保存**纯函数层。
React hook 是薄壳(Step E4 接入 EditorPanel),业务逻辑都在纯函数里,本主题测它们。

## MVP 范围(简化)

只做 3 个文件操作 + 1 个 autosaver:
- `openFileByPath(path, deps)` — Explorer 单击触发
- `saveFile(tabId, deps)` — Cmd+S 触发(已有 filePath 才能保存)
- `makeAutoSaveScheduler(saveFile, delayMs)` — debounce 调度器

**不做**:Cmd+O / Cmd+N / 另存为(需要 fs:open-dialog/save-dialog,Continuo 暂无这两个 IPC,留下里程碑)。
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
- 最新请求胜出:快速连续打开(含切到已开 tab)时,读盘较慢的旧请求完成后只在后台加入 tab(`activate:false` + 不抢焦点),最终激活的是用户最后请求的文件;读盘期间在 tab 栏切换(store.switchTab)同样算更晚的用户选择(store 维护用户激活代际),会话恢复的 `requestFocus:false` 切换与关 tab 不算

### `saveFile(tabId, deps)`
- tab 不存在 → ok:false code='TAB_NOT_FOUND'
- fs.writeFile 失败 → 透传 IpcFail
- 成功 → store.markSaved(id),返 ok
- 性能(保存回声识别):writeFile 带回 stat → 按 tab 路径记录 `{stat, gen}`(不存写入内容),同一 gen 经 `markSaved(id, savedContent, gen)` 写到 `tab.savedGen`;未带 → 清旧记录。记录随编辑器 chrome 变化(关闭 / 删除 / 改名 tab、外部 reload 使 savedGen 失效后)清理,只为打开的 tab 保留

### `makeAutoSaveScheduler(saveFile, delayMs)`
- `schedule()`:连续 N 次只调 saveFile 1 次(按最后一次的 delayMs)
- `cancel()`:清掉 pending,saveFile 不被调
- saveFile 抛错时 swallow + console.warn

## 不在本主题验证

- React hook 真集成(留 E4 集成时手验)
- IPC 真跨进程(已在 fs-ipc-bridge 测)
- store 行为(已在 editor-store 测)
- 关闭脏 tab 弹窗(留 E4 EditorPanel 状态机)
