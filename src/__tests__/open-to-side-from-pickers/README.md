# Quick Open 与搜索结果「在侧边打开」(VSCode SIDE_GROUP)

VSCode:
- Quick Open(anythingQuickAccess `openAnything`):`keyMods.alt || (openEditorPinned && keyMods.ctrlCmd)` → `SIDE_GROUP`。⌘P 默认常驻
  打开(`workbench.editor.enablePreviewFromQuickOpen` 默认 false),所以 ⌘Enter(Windows / Linux Ctrl+Enter)与 ⌥Enter / Alt+Enter
  都在侧边打开;`文件:行` 同样跳到该行。
- 搜索视图 `search.action.openResultToSide`:mac ⌃Enter(WinCtrl)、Windows / Linux Ctrl+Enter,焦点在匹配 / 文件匹配上;常驻、
  侧边组获焦(`searchView.open(element, false, true, true)`)。无右键菜单项。

侧边组的规则与资源管理器「在侧边打开」相同(`explorer-open-to-side`):源组右侧紧挨着的编辑器组;没有就向右拆出新组。

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/explorer-editor-drop.ts` | `takeSideEditorGroup()`:侧边组 id(需要时先拆分);`openFilesToSide` 共用同一规则 |
| `src/plugins/quick-open/QuickOpenModal.tsx` | ⌘Enter / ⌥Enter(Ctrl+Enter / Alt+Enter)→ 打开到侧边组(含 `文件:行`) |
| `src/panels/Search/search-store.ts` · `SearchPanel.tsx` | `openSearchMatchToSide`;结果树匹配行 ⌃Enter / Ctrl+Enter |

## 行为(`open-to-side-from-pickers.spec.tsx`)

- `takeSideEditorGroup`:右边已有编辑器组 → 它;没有 → 向右拆出新组(新组成为活动组);dock 未就绪 → undefined(活动组打开)
- Quick Open:修饰键 + Enter 打开到侧边组、常驻、`文件:行` 跳行;不带修饰键 → 活动组
- 搜索结果:匹配行 ⌃Enter / Ctrl+Enter → 常驻打开到侧边组并定位到命中;Enter → 活动组
