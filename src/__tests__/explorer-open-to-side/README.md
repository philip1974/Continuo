# explorer-open-to-side(资源管理器「在侧边打开」)

行为契约:**从资源管理器把文件打开到当前编辑器组右侧的组**(没有就向右拆出新组),入口:文件右键菜单、⌃Enter、⌥ 单击。

## VSCode 参照

- 命令 `explorer.openToSide`(`fileCommands.ts`):键位 `primary: Ctrl/Cmd+Enter`,mac `WinCtrl+Enter`(即 ⌃↩;Windows / Linux
  Ctrl+Enter),`when: explorerViewletFocus`;处理:取多选资源(`getMultiSelectedResources`:右键项在选中集里 → 整个选中集),
  滤掉文件夹,`openEditors(files, SIDE_GROUP)`,`pinned: true`。
- 菜单(`fileActions.contribution.ts`):`MenuId.ExplorerContext` 组 `navigation` order 10,`when: !ExplorerFolderContext` ——
  只在文件菜单,位于最前。
- SIDE_GROUP(`editorGroupFinder.ts`):源组 = 活动组;`findGroup({ direction: right }, 源组)`(网格里紧挨右侧的组)找不到就
  `addGroup(源组, right)`。`preserveFocus` 打开到 SIDE_GROUP 时**不激活该组**(注释:为了反复 ⌥ 单击总落在同一个侧边组)。
- ⌥ 单击:列表多选键为默认 `ctrlCmd` 时,Alt 单击即 `sideBySide`;`explorerView.onDidOpen` →
  `openEditor({ preserveFocus, pinned }, SIDE_GROUP)` —— 单击 = 预览、焦点留在树里;双击 = 常驻、焦点进编辑器。
  本项目 ⌥ 单击此前没有专门含义(按普通单击预览打开),现照 VSCode 改为在侧边打开。

## 行为

1. **入口**
   - 文件右键菜单首项「在侧边打开」(三语 `panels.explorer.ctx.open_to_side`),右侧键位 ⌃↵(mac)/ Ctrl+Enter;其后分隔线。
     文件夹 / 空白处菜单没有该项。右键的文件在多选集中 → 作用于整个选中集,其中的文件夹不打开。
   - 资源管理器聚焦时 ⌃Enter(mac)/ Ctrl+Enter:同右键菜单,目标为焦点项(在多选集中则整个选中集);全是文件夹 → 无动作。
   - ⌥ 单击文件行:预览方式、焦点留在资源管理器、活动编辑器组不变;⌥ 双击:常驻、侧边组获焦。不按 ⌥ 照旧在活动组打开。
2. **落到哪个组**:源组 = 触发窗口的活动编辑器组;网格里紧挨它右侧的组(取最上面那个)是编辑器组 → 放进去;右侧没有组或紧挨着的是
   终端等非编辑器面板 → 在源组右侧拆出新编辑器组。dock 未就绪 / 没有编辑器组 → 按普通方式打开。
3. **焦点与活动组**:右键 / ⌃Enter / ⌥ 双击 → 常驻打开,侧边组成为活动组,第一个文件成为其活动编辑器并获焦;⌥ 单击 → 侧边组里
   以预览方式打开(预览 tab 原位替换),活动编辑器组仍是源组、不聚焦编辑器 —— 再 ⌥ 单击别的文件仍落在同一个侧边组,不会再拆。

## 实现

| 文件 | 职责 |
|---|---|
| `src/shell/dock/explorer-editor-drop.ts` | `openFilesToSide(paths, { preview, preserveFocus })`;`openDroppedFiles` 增加 `preview` / `preserveFocus`(打开后把活动组还给原组) |
| `src/shell/dock/group-sizes.ts` | `rightNeighborGroup`(经 dockview 网格树找右邻组) |
| `src/panels/Editor/editor-groups-actions.ts` | `splitEditor` 的 `focus: false`(只建组不动焦点) |
| `src/panels/Explorer/ContextMenu.tsx` / `tree-keyboard.ts` / `FileRow.tsx` / `FolderTree.tsx` | 菜单项、⌃Enter、⌥ 单击接线 |

## 规范

- `open-files-to-side.spec.ts`:真实 dockview + 编辑器 store —— 右邻编辑器组 / 新拆分 / 右邻是终端时拆分、⌥ 单击不激活且重复落在同一侧边组
- `open-to-side-entry.spec.tsx`:菜单项位置 / 键位 / 多选、文件夹与空白无该项;⌃Enter 键位匹配与处理
- `folder-tree-wiring.spec.tsx`:真实文件树里 ⌥ 单击 / ⌥ 双击 / 普通单击、右键接线、多选滤掉文件夹(同文件也覆盖「在文件夹中查找…」接线)
- e2e `tests/e2e/explorer-open-to-side.spec.ts`:真实右键「在侧边打开」拆出右侧组并获焦;⌥ 单击两次都落在同一侧边组、焦点留在树
