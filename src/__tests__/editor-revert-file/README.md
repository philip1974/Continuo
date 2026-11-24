# editor-revert-file

对齐 VSCode「Revert File」:编辑器里未保存的修改可以丢弃、换回磁盘上的版本;保存遇磁盘冲突时除「覆盖」外也能选择用磁盘版本。

## Contracts

- 命令 `workbench.action.files.revert`(「文件」分类,三语标题 Revert File / 还原文件 / 파일 되돌리기,同 VSCode 无默认快捷键):重读活动文件 tab 的磁盘内容,tab 内容与基线都换成磁盘版本、不再脏,未保存修改丢弃;不写盘。
  - 磁盘内容与上次加载相同也照样丢弃修改。
  - 读盘失败(如文件已不存在)→ 按 code 提示错误,tab 内容与脏态不变。
  - 没有活动文件 tab → 什么也不做。
- 与外部同步同一出口(`reloadFromDisk`,带 `discardChanges`):递增 `reloadEpoch`,Markdown 编辑视图重挂拿新内容;尚未上抛的编辑器输入先回写再丢弃,卸载回写不会把丢弃的输入写回。
- 保存遇磁盘已被外部修改(EDITOR_DISK_CHANGED)的确认框按钮 [放弃更改并重新加载, 取消, 覆盖]:
  - 放弃更改并重新加载 → 不写盘,tab 换成磁盘版本且不再脏,确认框关闭;
  - 若确认框来自关闭脏 tab 时选的「保存」→ 还原后关闭该 tab;
  - 覆盖 / 取消行为不变(见 editor-dirty-close)。
- 自动保存遇冲突的提示与确认框说明文案都提到两种选择(覆盖,或放弃更改并重新加载)。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/editor-file-actions.ts` | `revertFile`:读盘 → `reloadFromDisk(..., { discardChanges: true })` |
| `src/stores/editor.store.ts` | `reloadFromDisk` 的 `discardChanges` 选项 |
| `src/panels/Editor/editor-commands.ts` | `REVERT_COMMAND_ID` / `revertActiveEditor` / 命令 spec |
| `src/panels/Editor/EditorPanel.tsx` | 覆盖确认框的 alternative 按钮 |
| `revert-file.spec.tsx` | 上述契约 |
| `tests/e2e/editor-revert-file.spec.ts` | 真实 Electron:外部改盘后 ⌘S 冲突 →「放弃更改并重新加载」 |
