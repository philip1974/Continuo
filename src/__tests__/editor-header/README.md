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
| `src/panels/Editor/tab-label-description.ts` | 同名 tab 的最短区分父路径后缀(纯函数,`tab-label-description.spec.ts`) |
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

### 点 tab 后焦点回到编辑区

- 鼠标点击 tab(含已激活 tab)→ 切换后下一帧把焦点交给编辑面板里 tab 行之外的首个落点(CodeMirror /
  ProseMirror 的 contenteditable、输入框、只读图片预览 `data-editor-focus-target`;选择器与 dock 面板聚焦共用
  `src/lib/content-focus-target.ts`)—— VSCode:点编辑器 tab 即聚焦该编辑器,可直接继续输入;否则焦点停在
  tab 上,接着打字的按键落在 tab(与 dock tab SharedTab 同规则)
- 键盘激活(Enter / Space 合成 click,detail=0)焦点留在 tab(tablist 键盘模型);经 design `TabNavItem.onMouseSelect` 接线
- 找不到落点(Markdown 预览 / 编辑器仍在加载)→ 焦点留在 tab;焦点已丢到 body(面板内容被 dock 激活重挂)时回到活动
  tab;焦点已被移到面板外 → 不抢 —— 无害,tab 上只有 Delete 会关闭

### 同名文件 tab 区分(VSCode labelFormat=default)

- basename 重复的 tab 在文件名后用 `text-fg-dim`(对 tab 底色 surface / surface-container-high 均 ≥ 4.5)显示能区分
  彼此的**最短**父路径后缀:`a` / `b`,父目录同名时向上取 `a/src` / `b/src`;各 tab 各自取最短;不重名的不显示
- 父链用尽仍不能区分(一个是另一个的后缀路径、同一路径重复)时显示完整父目录;Windows 路径按 `\` 分段并沿用 `\`

### tab 栏溢出

- tab 栏横向滚动(`overflow-x-auto`,不显示滚动条;竖向滚轮也横向滚动,VSCode 同款)
- 两侧 `from-canvas` 渐隐遮罩(`aria-hidden`):只在该方向确有被遮住的 tab 时显示(按 scrollLeft / clientWidth /
  scrollWidth,滚动与尺寸变化时更新)
- 激活 tab 总在可见区(VSCode revealActiveTab):激活 tab 变化(切换 / 新开 / 关闭后落到别的 tab)以及 tab 栏尺寸变化
  (窗口 / 面板缩小,ResizeObserver)时,按 tab 与 tab 栏的可视矩形直接设 tab 栏 `scrollLeft` —— 在左侧外左缘贴齐、
  在右侧外右缘贴齐、已可见不动。不用 `scrollIntoView`(会连带滚动 dock 等外层容器,且尺寸变化后不再校正)
