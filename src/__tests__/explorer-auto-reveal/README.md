# explorer-auto-reveal(资源管理器跟随活动编辑器)

对齐 VSCode `explorer.autoReveal`(默认 `true`):活动编辑器的文件变了(⌘P Quick Open、终端 ⌘+单击文件链接、编辑器 tab
切换、编辑器在 popout 子窗里也一样),资源管理器选中该文件、逐级展开父目录并滚动入视野。只改树的选中 / 焦点项,**不移动 DOM
焦点**(键盘留在编辑器 / 终端里),不弹任何通知。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/FolderTree.tsx` | 订阅 `editor.store.activeTabId`;展开父目录 + 复用「新建后定位」的 `pendingReveal`(不聚焦行) |
| `src/plugins/settings/core-setting-specs.ts` | `EXPLORER_AUTO_REVEAL`(`explorer.autoReveal`,布尔,默认开,三语) |
| `src/core-plugins/ExplorerTabPlugin.ts` | 设置页「资源管理器」里登记该项 |

## 行为(`explorer-auto-reveal.spec.tsx`)

- 活动文件在工作区内 → 父目录逐级展开(未加载的目录随之加载),文件出现后被选中(单选)、成为树焦点项(`tabindex=0`)、滚动入视野;
  DOM 焦点不动
- 切到另一文件 → 旧选中项取消、新文件选中
- 已是选中项 → 不动(保留多选)
- 工作区外的文件 → 树不变
- 未显示隐藏文件时,隐藏路径(`.` 开头的段)下的文件不跟随;`node_modules` / `bower_components` 下的文件不跟随
  (VSCode `explorer.autoRevealExclude` 默认值)
- 设置 `explorer.autoReveal = false` → 不展开、不改选中

## 不在本主题验证

- 「新建后定位」本身(`explorer-tree/folder-tree-create.spec.tsx`)
- 真实虚拟滚动位置(jsdom 下 virtualizer 为桩)
