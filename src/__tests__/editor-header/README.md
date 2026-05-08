# EditorHeader(单行 Header,tabs + mode 切换)

行为契约(VSCode 对齐):

* **0 tab 不渲染;tabs≥1 统一走 TabNav** — 单 tab 也是 tab(`flex-shrink:0` +
  `max-width:220px`),按内容宽收紧不撑满整行,右侧 panel 留空。
* **mode SegmentedControl 仅 autoSaveEnabled 时显示。**
* **不显文字「保存」按钮** — dirty 由 TabNavItem 自带的 ● 指示,保存走 ⌘S
  (EditorPanel keydown 已挂)。手动保存模式 = "不自动保存",不附带 toolbar 按钮。
* **插件贡献的 EditorAction** 通过 EditorActionRegistry 渲染右侧,有 icon 用
  IconButton,否则 ghost Button。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/EditorHeader.tsx` | UI |
| `src/plugins/registries/EditorActionRegistry.ts` | actions 注册 + filterVisible |

## 关键行为

### tab 数量

- tabs.length=0 → return null
- tabs.length≥1 → 统一 TabNav,所有 tab 同款 TabNavItem(VSCode 对齐:
  单 tab 不撑满整行,按内容宽收紧)

### autoSave 切换

- autoSaveEnabled=true → 显示 mode SegmentedControl(Edit/Source/Preview)
- autoSaveEnabled=false → 不显 SegmentedControl
- 不论 autoSaveEnabled 真假、dirty 真假,都不显文字「保存」按钮(VSCode 对齐)

### tab 操作

- 点 TabNavItem → switchTab(id)
- 点 TabNavItem 自带 close 叉 → onCloseRequest(tab)

### 插件 EditorAction

- 订阅 coApp.editorActions;dispatch 时按 ctx 过滤
- 有 icon → IconButton,无 icon → ghost Button
- 点击调 spec.fn()

### activeTab.filePath null

- basename 显示「未命名」
