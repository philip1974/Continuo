# 重新打开已关闭的编辑器(⇧⌘T)

对齐 VSCode `workbench.action.reopenClosedEditor`(mac `⇧⌘T`,Windows / Linux `Ctrl+Shift+T`)。

## 参考:VSCode 的做法(`HistoryService`)

- `recentlyClosedEditors`:最多 20 条(`MAX_RECENTLY_CLOSED_EDITORS`),超出丢最早的;同一编辑器再次关闭先移除旧条目再入栈。
- 关闭编辑器时记录(`REPLACE` / `MOVE` 不记,即替换与跨组移动不算关闭):资源、在组内的索引、是否固定。
- 重新打开:取栈顶,在**活动组**按记录的索引打开(`pinned`、`index`);活动组已有该编辑器 → 不打开,丢掉这条取下一条;
  打开失败(如文件已删除,`ignoreError`)→ 同样取下一条。文件被删除时从栈里移除。
- 文本编辑器的光标 / 滚动按资源保存在编辑器 memento 里,关闭后重开仍恢复。

## 行为

1. **记录**(每个窗口各自一份,只在本次会话内存里):
   - 关闭单个 tab(× / ⌘W / 中键)、批量关闭(右键「关闭其他 / 右侧 / 已保存 / 全部」、⌘W 批量确认后)每关一个 tab 记一条;
     关闭编辑器组(dock 面板 × / 组整体关闭)时,该组里随之关掉的 tab 各记一条(移到相邻组的脏 tab 不记)。
   - 每条记:路径、所在编辑器组 id、在组内的位置、关闭前的视图状态(CodeMirror 选区 + 顶部可见行、Markdown 滚动、
     图片缩放 —— 与跨重启恢复同一份可序列化摘要)。
   - 最多 20 条,超出丢最早的;同一路径再次关闭 → 旧条目移除,新条目入栈顶。
   - 不记:插件经 SDK 打开的 tab(同会话快照,其路径受主进程内存记录保护,不按路径重新读);
     切换工作区根而关闭的 tab、删除文件而关闭的 tab。
   - 关整个窗口不记(栈随窗口消失)。
2. **失效**:删除文件 / 目录 → 该路径及其下的条目移除;切换工作区根 → 不在新根下的条目移除(根为空 → 全部移除)。
3. **重新打开**(命令 `workbench.action.reopenClosedEditor`,默认键 `mod+shift+t`,三语标题,View 分类):
   - 取栈顶。原编辑器组还在 → 回原组;否则落到当前活动组。按记录的位置插回组内(越界收进范围)并激活,该组成为活动组,
     焦点进入重开的编辑器。
   - 目标组已打开该文件 → 跳过这条,取下一条(VSCode 同);文件已在别的组打开 → 在目标组再打开它(共享同一文档)。
   - 文件读不到(已删除等)→ 跳过这条,取下一条,不提示(VSCode `ignoreError`)。
   - 视图状态恢复:光标 / 顶部可见行 / Markdown 滚动 / 图片缩放回到关闭前(复用跨重启恢复的回填);
     Markdown 编辑 / 源码 / 预览模式按现有窗口级规则(不随条目记录)。
   - 弃改关闭的脏文件按磁盘内容重开(不恢复未保存的修改)。
   - 栈空 → 什么都不做。
   - 读盘期间用户又打开 / 切到别的文件 → 只在后台插回,不抢激活与焦点(同 openFileByPath 的用户激活代际)。
4. **快捷键冲突**:默认键 `⇧⌘T` / `Ctrl+Shift+T` 此前无任何命令、编辑器引擎(CodeMirror / Milkdown)键表、应用菜单占用。
   焦点在终端时:mac 上 `⇧⌘T` 让出给命令(带 ⌘,同 ⌘W / ⌘S);Windows / Linux 上 `Ctrl+Shift+T` 照常进 shell
   (VSCode 的 `commandsToSkipShell` 默认列表不含本命令)。
5. **不持久化**:栈只在会话内存(取舍:跨重启需要扩会话快照 schema 与主进程校验,收益低)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/recently-closed-editors.ts` | 每窗口最近关闭编辑器栈(上限 / 去重 / 失效),不依赖 store |
| `src/stores/editor.store.ts` | `closeTab` / `removeGroup` 入栈;`removePaths` / `closeTabsOutsideRoot` 失效;`openTab` 的 `index` 选项 |
| `src/panels/Editor/reopen-closed-editor.ts` | 重新打开栈顶(目标组 / 跳过 / 读盘 / 视图状态回填 / 焦点) |
| `src/panels/Editor/editor-commands.ts` | 命令 spec |
| `src/panels/Terminal/terminal-hotkeys.ts` | 终端让出 `⇧⌘T`(仅带 Meta) |

## 可执行规范

- `reopen-closed-editor.spec.ts`
