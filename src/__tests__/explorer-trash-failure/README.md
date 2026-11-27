# explorer-trash-failure(移到废纸篓失败:本地化原因 / 永久删除出路)

行为契约:资源管理器「移到废纸篓」失败时,不再显示 `EACCES: permission denied, rename '…' -> '…'` 这类原始英文串加完整
路径,而是按原因给出本地化提示;非权限类失败(卷不支持废纸篓等)弹确认框询问是否改为永久删除。

## VSCode 参照(`src/vs/workbench/contrib/files/browser/fileActions.ts` deleteFiles 的 catch)

- 使用废纸篓失败 → `dialogService.confirm`:message「Failed to delete using the Trash. Do you want to permanently delete
  instead?」(Windows 为 Recycle Bin),detail `deleteDetail`(「This action is irreversible!」),主按钮「Delete Permanently」;
  确认后 `useTrash = false` 重跑删除(跳过二次确认、忽略已不存在)。
- 背离:VSCode 对任何废纸篓失败都询问;Continuo 对权限 / 只读卷失败直接给原因 —— 这两类永久删除同样会失败,询问只会
  让用户点两次才看到同一个错误。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/ipc/fs.ipc.ts` `makeTrashHandler` | 失败分类:不存在 → `FS_NOT_FOUND`;errno 或父目录不可写探测为权限 / 只读卷 → `FS_DENIED` / `FS_READONLY_FS`;其余 → `FS_TRASH_FAILED` |
| `electron/main/ipc/fs/delete-permanently.ts`(`fs:delete-permanently`) | `fs.rm` 递归删除,不跟随符号链接;拒绝文件系统根与工作区根;E2E 模式只允许系统临时目录内 |
| `src/panels/Explorer/mutate-actions.ts` `deleteItemsPermanentlyAndCleanup` | 与移到废纸篓同一套批量 / 清理 |
| `src/panels/Explorer/FolderTree.tsx` | `FS_TRASH_FAILED` → 永久删除确认框(design Modal 经 ConfirmDialog);其它失败 → toast「无法将「名字」移到废纸篓:原因」 |

## 关键行为

- 只读目录里删 `a.txt` → toast「无法将「a.txt」移到废纸篓:拒绝访问」,不含原始 errno 串与完整路径,不弹永久删除框。
- 卷不支持废纸篓 → 确认框:标题「无法将「a.txt」移到废纸篓。是否改为永久删除?」,正文明确「此操作不可撤销!永久删除后无法从
  废纸篓恢复。」,主按钮「永久删除」(危险样式,初始焦点在「取消」,回车不直接删除);取消 → 什么都不删。
- 确认后永久删除:目录递归删除;符号链接只删链接本身,目标不受影响;成功后与移到废纸篓同样关 tab / 刷新父目录。
- 永久删除失败 → toast「永久删除「名字」失败:原因」(本地化)。
