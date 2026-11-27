# dock-group-sizes(只用鼠标调整组大小:双击分隔条等分 / 双击 tab 展开 / 最大化组)

行为契约:**不用键盘也能把组等分、把一个组撑大、最大化一个组**,对齐 VSCode 编辑器组。作用于 dock 主窗网格里的所有组
(编辑器组与终端等面板同在一个 dockview 网格);floating / popout 组不在网格里,不参与。

## VSCode 参照

- 分隔条双击:`Sash.onDidReset` → `SplitView.onDidSashReset` → `Grid.onDidSashReset(location)`:两侧视图没有 preferred 尺寸
  (编辑器组没有)→ `gridview.distributeViewSizes(parentLocation)`,只等分**该分隔条所在那一排**(同一 splitview),不递归。
- 双击 tab:`multiEditorTabsControl` —— 预览(未 pinned)tab → `pinEditor`;pinned tab → 按
  `workbench.editor.doubleClickTabToToggleEditorGroupSizes`(默认 `'expand'`)调 `EditorPart.toggleExpandGroup`:
  该组已展开(`gridWidget.isViewExpanded`:沿途每一级的其它可见兄弟都是最小尺寸)→ `arrangeGroups(EVEN)` =
  `gridWidget.distributeViewSizes()`(整个网格递归等分);否则 `arrangeGroups(EXPAND)` = `gridview.expandView`(沿途每一级
  `resizeChild(index, +∞)`,兄弟缩到最小)。组数 < 2 → 不动。双击后 `EventHelper.stop`(不再冒泡给 tab 栏)。
- 最大化组:`workbench.action.toggleMaximizeEditorGroup`(标题「Maximize Group」/ 最大化后「Unmaximize Group」,前置条件:
  多个编辑器组或已最大化)。VSCode 把它放在编辑器标题栏「…」菜单;Continuo 的 dock / 编辑器 tab 栏没有这个溢出菜单,
  放在 **tab 右键菜单末尾**(单独一组)。

## 行为

1. **双击组之间的分隔条**(dockview `.dv-sash`)→ 该分隔条所在那一排等分;其它排不动(如右列上下拆分后双击上下之间的分隔条,
   左右宽度不变)。改动经 `onDidLayoutChange` 通知(布局照常持久化)。
2. **双击 tab**:
   - dock tab(终端 / 编辑器组 / 设置等面板,`SharedTab`):dock 面板没有预览态 → 总是切换组大小:未展开 → 展开(其它组缩到最小);
     已展开 → 整个网格等分。双击 tab 上的关闭 / 退出最大化按钮不算。
   - 编辑器文件 tab(`EditorHeader`):预览 tab → 转常驻(不改组大小,见 `editor-preview-tab`);常驻 tab → 对该编辑器组所在的
     dock 组切换大小(同上)。
   - 网格里只有一个组 → 不动。
3. **tab 右键菜单末尾「最大化组」**(dock tab 与编辑器 tab 都有;三语 `shell.tab.ctx.maximize_group`):最大化该组(dockview
   原生 `maximizeGroup`,同 ⇧⌘Enter 终端缩放);已最大化时该项为「取消最大化组」(`unmaximize_group`)→ 还原。组不在主窗网格里 /
   网格里只有它一个组 → 不列。

## 实现

| 文件 | 职责 |
|---|---|
| `src/shell/dock/group-sizes.ts` | `distributeSashSizes` / `trackSashReset`(网格根元素上的 dblclick 委托)/ `isGroupExpanded` / `toggleExpandGroup` / `canMaximizeGroup` / `toggleMaximizeGroup` / `groupSizeMenuEntries`。dockview 6 无公开 API:经 `api.component.gridview` 的 BranchNode(`children` + `splitview`)调 `distributeViewSizes` / `resizeChild`,再按拖动分隔条结束同一路径(`_onDidChange`)通知布局变化;内部结构不符 → 静默不动 |
| `src/shell/dock/DockShell.tsx` | onReady 注册 `trackSashReset` |
| `src/shell/motion/SharedTab.tsx` | dock tab 双击 + 右键菜单项 |
| `src/panels/Editor/EditorHeader.tsx` | 编辑器常驻 tab 双击 + 右键菜单项 |

## 规范

- `group-sizes.spec.ts`:真实 dockview —— 分隔条等分(只等分那一排)、真实 dblclick 委托、展开 / 等分切换(含嵌套)、单组不动、最大化 / 取消、浮动组不可最大化
- `tab-double-click.spec.tsx`:dock tab 双击 / 双击关闭按钮 / 右键最大化;编辑器常驻 tab 双击展开、预览 tab 双击只转常驻、右键最大化
- e2e `tests/e2e/dock-group-sizes.spec.ts`:真实鼠标双击分隔条等分、双击 tab 展开再等分、右键最大化组
