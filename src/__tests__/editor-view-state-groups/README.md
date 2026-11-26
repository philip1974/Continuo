# 编辑器视图状态按「编辑器组 + 文件」保存(含折叠区域)

## 参考:VSCode 的做法

| VSCode | 行为 |
|---|---|
| `EditorMemento`(`workbench/browser/parts/editor/editorPane.ts`) | 视图状态按 **资源 → 组 id → 状态** 存;同一文件在两个组各有一份,互不覆盖;随工作区存储跨重启 |
| `loadEditorState(group, resource, fallbackToOtherGroupState)` | 本组没有时可回退到别的组的状态(文件新开进一个组) |
| 组移除(`onDidRemoveGroup` → memento 清理) | 已关闭组的状态丢弃 |
| `ICodeEditorViewState.contributionsState`(FoldingController) | 视图状态包含**折叠区域**;恢复时只折叠仍对得上的区域(文档变了不乱折) |
| 拆分(splitEditor) | 新组从源组的视图状态起步(光标 / 滚动 / 折叠) |

## Continuo 实现

- 会话内缓存 `src/panels/Editor/editor-view-state-cache.ts`:键 = 组 id + tab id(CodeMirror 状态、Markdown 滚动 / 切模式锚点、
  图片缩放)。取用顺序:本组本会话 → 上次会话留给本组的摘要 → 别的组本会话最近的状态 → 上次会话不分组的摘要。
- 视图登记 `editor.store` 的 `registerView(tabId, view, groupId)`;`liveEditorViewOf(tabId, groupId)` 按组取视图。
- 磁盘契约 `editor.viewStates[]`(`electron/shared/explorer-persistence-schema.ts`):
  - `group?`:多于一个组时每个组各写一条(组 id 随 `editor.groups` 持久化,重启原样恢复,故稳定);只有一个组时不写
    (旧形态;该组 id 不持久化)。缺省 = 各组的回退值(旧数据照常读)。
  - `folds?: {from, to}[]`:CodeMirror 折叠区域(`foldedRanges`),≤ `EDITOR_VIEW_FOLDS_MAX`(500)条。
- 组关闭(含收拢回单组)→ 丢弃该组的视图状态;会话恢复期间为尚未建出的组回填的状态不受影响。
- 主窗与 popout 子窗的编辑器组在同一个 store,一并覆盖。

## 行为(`editor-view-state-groups.spec.tsx`)

### 同一文件在两个组
- 写快照:每个组各一条,各取该组自己的视图(而非「最后登记的那个视图」)
- 只有一个组:不写 group(旧形态不变)
- 恢复:每个组按自己的条目恢复光标;不做操作再写快照,与上次一致(连续重启不退化)
- 旧数据(无 group)+ 多个组:各组都用这一条
- 会话内:一个组切走再切回,取回的是本组的状态,不被另一组覆盖
- 关闭一个组 → 该组的视图状态丢弃

### 视口跟随(未布局的视图)
- 视图带初始滚动创建、尚未布局(所在面板隐藏 / 未显示,scrollDOM 高 0)时写快照 → 记初始滚动的首行,而不是「滚在顶部」
- 已布局时滚动过、随后被隐藏 → 记隐藏前的位置
- 顶部可见行按滚动位置扣掉内容区上内边距计算(部分可见的那一行即首行)

### 折叠
- 写快照带上折叠区域;恢复时把仍可原样折叠的区域折叠
- 区间越界 / 该处已不可折叠(文件在外部改过)→ 丢弃该项,不抛
- schema:`folds` 超上限 / 畸形 / `group` 不是组 id → 读写都拒

## 端到端
- `tests/e2e/editor-view-state-groups-restart.spec.ts`:⌘\ 拆分后两组各自光标 → 连续两次重启各组都恢复且光标在视口内;
  ⌥⌘[ 折叠后重启,折叠仍在
