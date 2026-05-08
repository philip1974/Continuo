# editor-hooks-react(useAutoSave / useEditorFile / useExternalFileSync)

行为契约:**Editor panel 用的几个 React hook 薄壳**

| 文件 | 责任 |
|---|---|
| `useAutoSave.ts` | enabled + activeTab.dirty + 有 filePath 时按防抖触发 saveFile |
| `useEditorFile.ts` | useMemo 包 openFileByPath / saveActive,saveActive 无 active tab 返 NO_ACTIVE_TAB |
| `useExternalFileSync.ts` | 订阅 fs:dir-changed,非 dirty 同 dir tabs 重读磁盘 → reloadFromDisk |
| `useAutoSave.ts` 内 `isAutoSaveEnabled` | 只有 .md/.markdown 返 true |

## 关键行为

### useAutoSave

- enabled=false → 不调
- 没 active tab / filePath null / dirty=false → 不调
- 满足条件 → delayMs 后调 saveFile;再次满足条件 → 防抖合并

### isAutoSaveEnabled

- null → false
- 'a.md' / 'a.markdown' / 'a.MD' → true
- 'a.txt' / 'a.tsx' → false

### useEditorFile.saveActive

- activeTabId=null → ok=false code=NO_ACTIVE_TAB
- 有 → 调 underlying saveFile

### useExternalFileSync

- 注册 onDirChanged 订阅;hook unmount 时返 unsub
- changedDir 命中 tab.filePath 父目录 + 非 dirty + 读盘 ok → reloadFromDisk
- dirty tab 跳过
- changedDir ≠ dirname → 跳过
- readFile ok=false → 跳过(不抛)
