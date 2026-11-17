# explorer-tree (M-Explorer Step 4)

行为契约:**资源管理器 UI 层**(Explorer 容器 + EmptyWorkspace + FolderTree + FileRow)。

本主题**只测 `tree-config.ts` 的纯逻辑**(dataLoader + 配置工厂),
React 组件渲染 / 虚拟滚动 / 真键盘交互留 Step 7 smoke E2E。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/tree-config.ts` | `createTreeConfig({ root, fs })` 工厂,组装 headless-tree 的 TreeConfig |
| `src/panels/Explorer/index.tsx` | 容器:根据 `workspaceRoot` 路由 EmptyWorkspace ↔ FolderTree |
| `src/panels/Explorer/EmptyWorkspace.tsx` | 中央"打开文件夹"按钮,调 `fs.selectDirectory` |
| `src/panels/Explorer/FolderTree.tsx` | `useTree` + `@tanstack/react-virtual` |
| `src/panels/Explorer/FileRow.tsx` | 单行(`Folder` / `Document` 图标 + 名称 + 状态) |

## 关键行为(tree-config 层)

- `rootItemId` 等于传入的 `root`
- `features` 启用:`asyncDataLoaderFeature` + `selectionFeature` + `hotkeysCoreFeature`
- `dataLoader.getItem(root)` 返回构造的 root entry(`name` = `basename(root)`,`isDirectory: true`)
- `dataLoader.getChildrenWithData(parentPath)` 调 `fs.listDir(parentPath)`:
  - 成功:把 `FileEntry[]` 映射为 `{ id: entry.path, data: entry }[]`
  - 失败:返回 `[]`,`onIpcWarn` 回调被调(默认 console.warn)
- `dataLoader.getItem(child)`(非 root)调 `fs.listDir(parent)` 查找,找不到时降级返回最小信息
- `getItemName(item)` 返回 `item.getItemData().name`
- `isItemFolder(item)` 返回 `item.getItemData().isDirectory`

## FileRow 渲染隔离(perf,`folder-tree-row-memo.spec.tsx`)

- `FileRow` 是 memo 组件;FolderTree 经 `readFileRowState(item, tree)` 把行状态(data / isDir /
  isSelected / isFocused / isExpanded / isLoading / isRenaming / renamingValue / level / posInSet /
  setSize / isDraggingOver)以 primitive 下传,定位只传 `start`(行内构造 style)
- 滚动(virtualizer range 变化)时一直在视口的行不重渲;新进入的行按 start 定位
- 键盘移动焦点只重渲新旧焦点行,tabIndex 跟随
- 选中 / 展开 / 剪切灰显 / 重命名受控输入 / 兄弟增删后的 aria-setsize 均正确反映到对应行
- 已知:选中集合变化与剪贴板空↔非空翻转仍会重渲全部可见行(selectedPaths / hasClipboard 供每行
  ContextMenu 使用),属低频交互

## 不在本主题验证

- 真实浏览器虚拟滚动行为(留 E2E)
- selection feature 的内部 state 流转(headless-tree 自带覆盖)
- `EmptyWorkspace` 按钮点击 → fs.selectDirectory → setRoot 的真实 IPC 路径(留 E2E)
- `initExplorerPersistence` 在 main.tsx 的接入(已在 explorer-stores 主题测过)
