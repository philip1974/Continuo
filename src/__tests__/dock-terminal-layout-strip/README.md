# dock-terminal-layout-strip — 持久化布局剥离终端 panel

## 背景 / 行为契约

终端是真实 dockview panel,`api.toJSON()` 会把它们写进持久化 layout(`explorer.json`
的 `windows[].layout`)。但既有契约是 **「终端不从持久化 layout 恢复」** —— 终端由
`DockReconciler` 依据 live session 列表重建。

旧实现一旦发现持久 layout 含终端就**整体弃用**(`sanitizePersistedDockLayout` 返 `null`),
导致两个缺陷:

1. **误报**:`onReady` 把「含终端」当作恢复失败,弹红色 toast `errors.dock.layout_restore_failed`
   (「面板布局恢复失败;已重置为默认」)。关窗时只要开着终端 = **每次启动必现**。
2. **过度丢弃**:editor 等非终端 panel 的排布被连带重置为默认。

`stripTerminalPanelsFromLayout(layout)` 改为**只摘掉终端 panel + 修补 grid 树**,让非终端
布局正常存活。读端(`sanitizePersistedDockLayout`)与写端(`writeDockLayoutSnapshot`)共用此
helper —— 写端剥离让持久化文件不再携带终端 `sessionId`/`cwd` 陈旧数据,读端剥离兜底处理历史
文件与竞态。

## grid 树为何无需塌缩单子节点 branch

dockview 反序列化(`gridview._deserializeNode`)按**深度自动分配 orientation**(每层
`orthogonal()` 翻转),与子节点数量无关。故单子节点 branch 仍能正确渲染(仅冗余一层嵌套)。
本 helper 只需保证:每个 leaf ≥1 view、每个 branch ≥1 child,并回退悬空的
`activeView`/`activeGroup` —— **不做** branch 塌缩(塌缩 branch→branch 会破坏 orientation 交替)。

## 规范要点

- 无终端 → 返回**原对象**(引用不变,回归友好)。
- leaf 含「editor + 终端」→ 剥终端,`views` 仅剩 editor;若 `activeView` 原指终端 → 回退到首个存活 view。
- leaf 仅含终端 → 整个 leaf 摘除;父 branch 子节点全空 → 父 branch 也摘除。
- `panels` map 同步剔除终端条目。
- 悬空 `activeGroup`(指向被摘除的 group)→ 清除。
- `floatingGroups` / `popoutGroups` 同样过滤 views,丢弃变空的组。
- `tabGroups`(罕见)同步剔除终端 `panelIds`,丢弃变空的 tabGroup。
- 整棵树无非终端 panel,或缺 `grid` 无法安全处理 → 返回 `null`(上层静默走默认布局,**不报错**)。
- 上层 `onReady`:`sanitize` 返回有效 layout → `fromJSON` 恢复、**不弹** error toast;
  只有真正的 `fromJSON` 抛错(结构损坏)或 `layout.read` reject/`!ok` 才报错(见
  [`dock-layout-restore-feedback`](../dock-layout-restore-feedback/README.md))。
