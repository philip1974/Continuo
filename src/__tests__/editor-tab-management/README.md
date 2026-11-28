# 编辑器 tab 与编辑器组管理(移动 / 固定 / 跨组切换 / 组 MRU / 组管理命令 / 按序号直达)

对齐 VSCode 编辑器组的「重度用户」操作:不用鼠标拖动就能把 tab 移到别的组、组内排序、固定常用文件、在组之间连续切换、
关掉一组后回到最近用过的组、一次关闭 / 合并全部组。编辑器组模型见 `src/__tests__/editor-groups/`。

## 参考:VSCode 的做法(microsoft/vscode main)

| VSCode | 行为 | 出处 |
|---|---|---|
| `moveEditorToNextGroup` / `PreviousGroup`(mac ⌃⌘→ / ⌃⌘←,Win/Linux Ctrl+Alt+→ / ←) | 移到下一个 / 上一个组;没有 → 向右 / 左**新建组**再移;目标组激活并获焦 | `editorActions.ts`、`editorCommands.ts` moveCopyEditorsToGroup |
| `moveEditorToFirstGroup` / `LastGroup`(mac ⌃⌘1 / ⌃⌘9,Win/Linux Shift+Alt+1 / 9) | 移到第一个 / 最后一个组;已是 → 不动,不新建 | 同上 |
| `moveEditorLeftInGroup` / `RightInGroup`(mac 和弦 ⌘K ⇧⌘← / →,Win/Linux Ctrl+Shift+PageUp / PageDown) | 组内左 / 右移一位,到头收住;越过固定区边界随之固定 / 取消固定 | `editorCommands.ts` moveTab、`editorGroupModel.ts` moveEditor |
| 跨组移动 | 固定状态保留(复制 / 拆分不保留);以常驻(pinned)打开;目标组已有该文件 → 用目标组那个(源固定则它也固定),源组关掉自己的 | `editorGroupView.ts` doMoveOrCopyEditorAcrossGroups、`editorGroupModel.ts` openEditor |
| `pinEditor` / `unpinEditor`(和弦 ⌘K ⇧Enter,无非和弦默认键) | 固定:先转常驻,移到固定区末尾;取消:移到第一个非固定位置 | `editorGroupModel.ts` doStick / doUnstick |
| 固定 tab 外观(`pinnedTabSizing` 默认 normal) | 宽度同普通 tab;关闭按钮换成「取消固定」图钉(`tabActionUnpinVisibility` 默认 true);读屏名「…，已固定」 | `multiEditorTabsControl.ts`、`editor.ts` |
| ⌘W(`closeActiveEditor`,`preventPinnedEditorClose` 默认 keyboardAndMouse) | 键盘 / 菜单触发遇固定的活动编辑器:不关,改打开组内最近使用的非固定编辑器,组内没有再去所有组找;都没有 → 不动。tab 右键「关闭」照常关;中键也不关 | `editorCommands.ts` closeEditorHandler |
| 关闭其他 / 关闭右侧 / 关闭已保存 / 组内全部关闭 / `closeAllEditors` | 都跳过固定的(excludeSticky) | `editorCommands.ts`、`editorActions.ts` |
| `closeAllGroups`(和弦 ⌘K ⇧⌘W) | 不跳过固定的,关完后空组移除 | `editorActions.ts` |
| `closeAllEditors`(和弦 ⌘K ⌘W) | 跨组收集脏编辑器,**一个**保存确认框(保存 / 不保存 / 取消),取消则都不关 | `editorActions.ts` AbstractCloseAllAction |
| `closeEditorsAndGroup`(命令面板「关闭编辑器组」) | 关闭组内全部编辑器(含固定),组变空才移除 | `editorCommands.ts` |
| `joinTwoGroups` / `joinAllGroups`(无默认键) | 活动组并入相邻组(依次找右 / 下 / 左 / 上)/ 其它组都并入活动组;固定状态保留 | `editorActions.ts`、`editorPart.ts` doMergeGroup |
| `nextEditor` / `previousEditor`(mac ⌥⌘→ / ⌥⌘←、⇧⌘] / ⇧⌘[,Win/Linux Ctrl+PageDown / PageUp) | 到组尾 / 组首 → 下一个 / 上一个**非空**组的第一个 / 最后一个编辑器,首尾相接 | `editorActions.ts` OpenNextEditor |
| `nextEditorInGroup` / `previousEditorInGroup`(和弦) | 组内循环 | 同上 |
| 移除组 | 活动组被移除 → 激活 `mostRecentActiveGroups` 里的下一个;MRU 随布局持久化 | `editorPart.ts` doRemoveGroup / createState |
| `openEditorAtIndex1..9`(mac ⌃1…⌃9,Win/Linux Alt+1…Alt+9) | 活动组第 N 个编辑器(9 = 第 9 个);不在 `commandsToSkipShell` → 终端获焦时交给 shell | `editorCommands.ts`、`terminal.ts` |
| `lastEditorInGroup`(mac ⌃0 + ⌘9,Win/Linux Alt+0) | 组内最后一个;在 commandsToSkipShell | `editorActions.ts` |
| `focusFirst…EighthEditorGroup`(⌘1…⌘8) | 聚焦第 N 组;N = 组数 + 1 → 新建组;更大 → 不动;都在 commandsToSkipShell | `editorCommands.ts` |
| 菜单 | 菜单栏没有 closeAllEditors / join / move(「转到 ▸ 切换组」有第 1–5 组);tab 右键有「固定 / 取消固定」(3_preview)与「拆分并移动 ▸」 | `editor.contribution.ts` |

## 行为

1. **移动 tab**(`editor.store.moveTab` + `editor-groups-actions.moveEditor`)
   - 跨组:脏内容(同一份文档)、视图状态(光标 / 选区 / 滚动 / 折叠 / 撤销历史;隐藏 tab 取缓存)随之到目标组;预览 tab 转常驻;
     固定的仍固定(排在目标组固定区末尾);目标组已有该文件 → 用目标组那个;源组变空即关闭;目标组成为活动组、编辑器获焦;
     不进最近关闭栈。
   - 「下一组 / 上一组」按所在窗口的空间顺序(同 dock 标题「编辑器 N」,popout 子窗只在自己的组间);没有 → 向右 / 左拆出新组再移;
     「第一组 / 最后一组」已是本组 → 不动。组内左移 / 右移到头收住,越过固定区边界随之固定 / 取消固定。
   - 入口:命令(各平台默认键同 VSCode;mac 组内左右移是和弦 → 无默认键)、tab 右键「移到上一组 / 移到下一组」。
2. **固定 tab**:命令 pinEditor / unpinEditor(无默认键)、tab 右键「固定 / 取消固定」;固定的排在最左、图钉代替 ×(点图钉取消固定;
   中键 / Delete 不关);「关闭其他 / 右侧 / 已保存 / 全部关闭」与 closeAllEditors 跳过,closeAllGroups / 「关闭编辑器组」不跳过;
   ⌘W 不关(打开最近使用的非固定编辑器);改名 / 另存为后仍固定;拆分出的副本不固定;随会话持久化(单组 `stickyPaths`,多组各组
   `stickyPaths`),重启保留。与「预览转常驻」区分:后者是 `keepTab`(原 `pinTab`)/ `workbench.action.keepEditor`。
3. **下一个 / 上一个编辑器跨组**(⌥⌘→ / ⌥⌘←):到组尾 / 组首跳到相邻非空组,首尾相接;nextEditorInGroup / previousEditorInGroup 保留组内循环。
4. **组 MRU**:`groupMru` 随活动组变化维护;活动组被关闭 / 移除(含 dock tab ×、组内最后一个 tab 关闭、移走最后一个 tab)→ 落到 MRU
   里的下一个组(无记录才回退左邻);dock 面板 × 时脏文档的去处同为 MRU 组;多组时随会话持久化(`groupMru`)。
5. **组管理命令**(命令面板三语,无默认键 —— VSCode 的都是和弦或无键):关闭所有编辑器、关闭所有编辑器组、关闭编辑器组、
   将编辑器组与下一组合并、合并所有编辑器组。跨组关闭的脏文档合并成一个确认框。
6. **按序号直达**:openEditorAtIndex1..9(mac ⌃1…⌃9,Win/Linux Alt+1…Alt+9;终端获焦时交给 shell)、lastEditorInGroup(⌃0 / ⌘9 / Alt+0);
   聚焦第 N 个编辑器组扩到 ⌘1…⌘8(终端里让出);「转到 ▸ 切换组」补第 4 / 5 组。
7. **编辑器组被非编辑器面板挡住时**:触发窗口的活动 dock 面板是设置页 / 冲突比较页等非编辑器面板,且编辑器组与它叠在同一 dock 组里
   (看不见)→ 移动编辑器(⌃⌘← / → / 1 / 9、组内左右移)、按序号打开(⌃1…⌃9 / ⌃0 / ⌘9)、下一个 / 上一个编辑器(⌥⌘← / →)、组内循环
   不做事,不去动藏在后面的文件;编辑器组可见(焦点在别的组的终端等)→ 照旧作用于它;tab 右键「移到…」不受影响。⌘W(关闭活动面板,
   即设置页本身)、⌃Tab(先激活编辑器组再切换)行为不变。

## 刻意差异

- tab 右键用「移到上一组 / 移到下一组」(按组的空间顺序,同命令)代替 VSCode「拆分并移动 ▸ 左 / 右 / 上 / 下」:编辑器 tab 不能拖到
  别的组(见排除清单),菜单是鼠标入口。
- 跨组移动的插入位置:目标组末尾(Continuo 打开新 tab 一律追加在末尾,VSCode 默认插在活动编辑器右侧)。
- `joinTwoGroups` 的相邻组按空间顺序(先下一个、再上一个),不分右 / 下 / 左 / 上四向。
- openEditorAtIndex1..9 出现在命令面板(VSCode 只是快捷键命令),便于发现 / 改键。
- 关闭含脏文件的组 / 全部关闭:多个脏文件合并一个框(VSCode 关单个组是逐个确认;用户选定合并)。
- 设置页 / 冲突比较页在 VSCode 里本身是编辑器,上述命令作用于它们;Continuo 里它们是 dock 面板、不归编辑器组管,命令改为不做事
  (不移动 / 切换看不见的文件)。
- 和弦默认键(⌘K ⇧Enter、⌘K ⌘W、⌘K ⇧⌘W、⌘K ⇧⌘← 等)不支持 → 这些命令无默认键,可自行绑定。

## 规范

| 文件 | 覆盖 |
|---|---|
| `tab-management-store.spec.ts` | moveTab(跨组 / 组内 / 目标已有 / 固定与预览跟随 / 源组关闭)、pin / unpin 排序、关闭类跳过固定、组 MRU 落点、改名后仍固定 |
| `tab-management-commands.spec.ts` | 命令注册与各平台默认键、⌥⌘→ 跨组首尾相接、组内循环、按序号直达、移动命令、合并组、⌘W 遇固定 tab、全部关闭(跨组一个确认 / 跳过固定)、终端让出 / 交给 shell |
| `hidden-group-tab-commands.spec.ts` | 设置页 / 比较页挡住编辑器组时 tab 级命令 no-op;编辑器组可见时照旧;tab 右键「移到…」不受影响 |
| `tab-management-persist.spec.ts` | stickyPaths / groupMru 写出与恢复(单组 / 多组)、schema 接受、工作区快照按 root 剔除 |
| `pinned-tab-header.spec.tsx` | 固定 tab 的图钉代替 ×、点图钉取消固定、中键不关、右键「固定 / 取消固定」、读屏后缀、「关闭其他」保留固定的 |
| `tests/e2e/editor-tab-management.spec.ts` | 真实应用:⌃⌘→ 移动保持光标与脏内容、固定后「关闭其他」保留且重启仍固定、⌥⌘→ 跨组、关组后焦点到 MRU 组、⌃1 / ⌃9 |
