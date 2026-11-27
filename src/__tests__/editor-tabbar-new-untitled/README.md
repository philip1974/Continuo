# 双击编辑器 tab 栏空白处新建无标题文件

此前双击 tab 栏空白处无反应。VSCode(`multiEditorTabsControl`:tab 容器上的 dblclick,目标是容器本身时)在**该编辑器组**末尾打开一个
新的无标题文本文件(`openEditor({ resource: undefined, options: { pinned: true, index: count } }, group)`),与 ⌘N 相同的无标题编辑器。

1. **只在空白处**:tab 之后的空白、tab 之间的缝(目标是 tab 栏容器 / tablist 本身)。双击 tab 本身(预览 tab → 常驻,原有行为)、
   tab 上的关闭按钮、右侧编辑器动作按钮不新建。
2. **落在双击所在的编辑器组**(多个组 / popout 子窗里的组同样),排在末尾、常驻(非预览)、获得焦点可直接键入,
   命名同 ⌘N(`Untitled-N` / `无标题-N`,取最小未占用编号)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/EditorHeader.tsx` | `isTabBarBlankTarget` 判定 + tab 栏 dblclick |
| `src/panels/Editor/untitled.ts` | `newUntitledFile(groupId)`(⌘N 同一实现) |

## 规范

- `tabbar-dblclick.spec.tsx`:空白处双击新建(本组、末尾、常驻)、双击 tab / 关闭按钮不新建
- e2e `tests/e2e/editor-tabbar-dblclick-new-untitled.spec.ts`:真实鼠标双击 tab 栏空白处
