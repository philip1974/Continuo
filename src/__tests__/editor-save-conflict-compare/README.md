# editor-save-conflict-compare

对齐 VSCode 保存冲突的「Compare」(`textFileSaveErrorHandler.ts`:`ResolveSaveConflictAction` 打开
「{file} (in file) ↔ {file} (in Code) - Resolve save conflict」差异编辑器;标题栏动作 `acceptLocalChangesCommand`
「Use your changes and overwrite file contents」/ `revertLocalChangesCommand`「Discard your changes and revert to file contents」,
执行后回到原编辑器并关闭差异编辑器)。

## Contracts

1. 冲突确认框(⌘S 遇 EDITOR_DISK_CHANGED)按钮依次 [比较, 放弃更改并重新加载, 取消, 覆盖](三语),初始焦点仍在「取消」
   (覆盖不可恢复;比较 / 放弃也都不由回车误触)。说明文案提到比较。
   - 比较 → 确认框关闭,不写盘、tab 内容与脏态不变,打开差异 tab;来自关闭脏 tab 时的「保存」→ 这批关闭结束(同取消),tab 不关。
2. 差异 tab = dock 面板(type `conflict-diff`,id `conflict-diff:<tabId>`),落在原编辑器组面板所在的 dock 组里并获得焦点;
   同一文档已有差异 tab → 只激活它,不重建。标题「{name}（在磁盘上）↔ {name}（你的版本）」三语,随界面语言切换
   (params.titleKey + titleArgs,useDockLocaleSync)。
   面板类型注册为 hidden(不进 Dock「⋯」菜单,插件 app.dock.openPanel 按 type 打开也忽略)+ multiInstance。
3. 差异视图(懒加载 chunk,@codemirror/merge):
   - 左 = 磁盘当前内容,只读(可聚焦);右 = 原 tab 的同一文档:右侧输入即改原 tab(变脏、内容同步),原 tab 的编辑也同步到右侧。
   - 逐行高亮 + 行内差异;工具栏显示差异数 / 当前第几处;上一处 / 下一处差异按钮与编辑器内 Alt+F5 / Shift+Alt+F5
     (VSCode compareEditor.nextChange / previousChange)循环跳转,跳转后读屏播报「第 n 处差异，共 m 处，第 L 行」,无差异播报「没有差异」。
   - 读屏名称:两侧文本区「{name}（在磁盘上，只读），编辑器」/「{name}（你的版本），编辑器」;工具栏 role=toolbar 有名称。
   - 磁盘再次变化(fs:dir-changed 命中该文件,或 watcher 恢复覆盖它)→ 重读,左侧更新;读失败 → 提示原因,左侧为空。
   - Markdown 按源码文本比较(markdown 高亮,不进 Milkdown)。
   - 两侧合计超过 `CONFLICT_DIFF_MAX_CHARS` → 不计算差异,显示提示;接受 / 使用磁盘版本仍可用。差异计算另有单次超时上限。
4. 动作(工具栏按钮 + 命令面板命令 `workbench.files.action.acceptLocalChanges` / `workbench.files.action.revertLocalChanges`,
   「文件」分类、无默认键、三语标题;命令作用于触发窗口的活动差异 tab,活动面板不是差异 tab → 什么也不做):
   - 接受我的版本 → 强制写盘(不再比较磁盘)、tab 干净;关闭差异 tab,原 tab 在其编辑器组激活并聚焦。
   - 使用磁盘版本 → 重读磁盘替换 tab 内容、tab 干净、不写盘;同样关闭差异 tab、回到原 tab。
   - 失败 → 按 code 提示,差异 tab 保留。
5. 原 tab 关闭(含改名:tab id 随路径变)→ 差异 tab 自动关闭。
6. 不持久化:写盘的 dock 布局剥离 `conflict-diff` 面板(同终端),重启不恢复(VSCode 的冲突比较内容来自一次性的冲突状态,
   这里不尝试恢复)。

## 与 VSCode 的差异

- VSCode 冲突提示是通知(Compare / Overwrite),Continuo 沿用模态确认框,多一个「比较」按钮;「放弃更改并重新加载」保留。
- VSCode 两个动作只在差异编辑器标题栏;这里另进命令面板。
- 差异 tab 是 dock 面板(与「编辑器」面板并列的 dock tab),不是编辑器组内的文件 tab。

## Modules

| File | Role |
|---|---|
| `src/panels/Editor/conflict-diff-constants.ts` | 面板 type / id / params |
| `src/panels/Editor/conflict-compare.ts` | 打开差异 tab、接受 / 放弃、原 tab 关闭时自动关闭、命令 |
| `src/panels/Editor/conflict-diff-model.ts` | 纯逻辑:大小上限、差异块定位、dir-changed 命中 |
| `src/panels/Editor/ConflictDiffPanel.tsx` | 差异视图(MergeView)与工具栏 |
| `src/panels/Editor/EditorPanel.tsx` / `src/lib/ConfirmDialog.tsx` | 冲突确认框的「比较」按钮(extraActions) |
| `src/shell/dock/strip-terminal-layout.ts` | 布局持久化剥离 |
| `src/shell/dock/useDockLocaleSync.ts` | 标题 titleArgs |
| `conflict-dialog.spec.tsx` | 契约 1 |
| `conflict-compare.spec.ts` | 契约 2、4、5 |
| `conflict-diff-panel.spec.tsx` | 契约 3 |
| `conflict-diff-persistence.spec.ts` | 契约 2(标题随语言)、6 |
| `conflict-diff-model.spec.ts` | 纯逻辑单元(TDD) |
| `tests/e2e/editor-save-conflict-compare.spec.ts` | 真实 Electron:冲突 → 比较 → 内容正确 → 接受 / 使用磁盘;Markdown 比较 |
