# editor-revert-file

对齐 VSCode「Revert File」:编辑器里未保存的修改可以丢弃、换回磁盘上的版本;保存遇磁盘冲突时除「覆盖」外也能选择用磁盘版本。

## Contracts

- 命令 `workbench.action.files.revert`(「文件」分类,三语标题 Revert File / 还原文件 / 파일 되돌리기,同 VSCode 无默认快捷键):重读活动文件 tab 的磁盘内容,tab 内容与基线都换成磁盘版本、不再脏,未保存修改丢弃;不写盘。
  - 磁盘内容与上次加载相同也照样丢弃修改。
  - 读盘失败(如文件已不存在)→ 按 code 提示错误,tab 内容与脏态不变。
  - 没有活动文件 tab → 什么也不做。
- 与外部同步同一出口(`reloadFromDisk`,带 `discardChanges`):递增 `reloadEpoch`;尚未上抛的编辑器输入先回写再丢弃。
- **还原可撤销**(VSCode:还原不确认,`ModelService.updateModel` 以前后 `pushStackElement` 的最小差异编辑套用,⌘Z 找回):
  - 代码编辑器 / Markdown 源码模式:CodeEditor 按 value 以最小差异的一步套用(进撤销栈)。
  - Markdown 编辑 / 预览(Milkdown):**不重挂载**(EditorPanel 的 key 不含 `reloadEpoch`),`reloadEpoch` 作为 prop 传给视图;它变了 →
    随之到来的 value 以最小差异的事务就地套用并**进撤销栈**,前后各 `closeHistory` 一次,自成一组(不与之前的输入合并,之后的输入
    也不并进来)。焦点 / 光标保留;套用的内容即视图的新基线、不上抛(保存的源码与磁盘一致,不变脏);原文块 / 行尾按新内容重建
    (`sourceBlocks.resync`,「原样写回」机制不变)。⌘Z → 回到还原前的内容并上抛(tab 变脏),⇧⌘Z 回到磁盘版本。
    epoch 不变的内容变化(另一编辑器组)照旧不进撤销栈(见 `editor-groups`)。
  - 外部修改自动重载(干净文件)走同一路径,撤销历史不再丢失。
  - 唯一不能就地套用的情况:磁盘版本较大 / 含编辑模式会改写的语法,按规则只能以源码模式显示(编辑视图随之卸载,其撤销历史丢失)。
    此时若有未保存修改,`revertActiveEditor` 先经该组面板弹破坏性确认(`panels.editor.revert_lose_undo_*`,三语,初始焦点在取消);
    取消 → 什么也不变。没有未保存修改 → 不确认(没有会丢的内容)。
- 保存遇磁盘已被外部修改(EDITOR_DISK_CHANGED)的确认框按钮 [比较, 放弃更改并重新加载, 取消, 覆盖](比较见 editor-save-conflict-compare):
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
| `revert-file.spec.tsx` | 上述契约(含 Markdown 编辑视图不重挂、确认框) |
| `revert-undo-milkdown.spec.tsx` | 真实 Crepe:重载可撤销、自成撤销组、套用不上抛、epoch 不变的同步不进撤销栈 |
| `src/panels/Editor/MilkdownEditor.tsx` | `reloadEpoch` prop → 可撤销的 `applyExternal` |
| `tests/e2e/editor-revert-file.spec.ts` | 真实 Electron:外部改盘后 ⌘S 冲突 →「放弃更改并重新加载」 |
