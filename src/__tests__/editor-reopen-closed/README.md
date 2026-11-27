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
   **改名 / 移动**(资源管理器改名 / 移动 / 撤销,`renamePath`):该路径及其下的条目改写为新路径(顺序不变;与已有条目重复
   → 只留更近关闭的那条),⇧⌘T 打开新位置。取舍:VSCode 的 `move` 不改写 `recentlyClosedEditors`,旧条目随 watcher
   的删除事件被移除;改写比丢失更有用,成本只是一次映射。
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
6. **popout 子窗里按 ⇧⌘T**:命令在子窗分发(同 ⌘W,`POPOUT_HOTKEY_COMMAND_IDS`),重开**落在该子窗里**(VSCode:辅助窗口
   里重开落到该窗口的编辑器组;否则文件在主窗打开而子窗毫无反馈,renderer 也无激活主窗的通路)。是否「在子窗里触发」按**按键所在
   窗口**判定(热键分发经 `runInCommandDocument` 标明,命令开头在第一个 await 前读 `getCommandDocument`),不看 dock 全局活动
   面板:点子窗标题栏 / ⌘` 切到子窗不改活动组,反之从子窗切回主窗时活动组仍在子窗(此前前者重开到主窗、后者在主窗按却在
   子窗新建编辑器组)。目标组:原组在该子窗 → 原组;否则该子窗里的编辑器组(活动组优先);子窗里没有编辑器组
   (如原组随最后一个 tab 关闭已移除、子窗只剩终端)→ 在子窗的该 dock 组里新建一个编辑器组(同子窗里拆分)打开;组数已达上限
   → 落到活动组。焦点进重开的编辑器。主窗里触发不变(原组还在 → 回原组,即使原组在子窗;此时子窗被聚焦,见 popout-open-target
   「打开文件」);原组已不在 → 主窗的编辑器组,主窗没有编辑器组而活动编辑器组在子窗 → 在主窗新建一个(同打开文件)。

7. **恢复撤销栈**(VSCode `files.restoreUndoStack`,默认开;`src/vs/editor/common/services/modelService.ts`:模型销毁时有撤销 /
   重做元素就按 URI 留下并记内容 SHA1,重新创建同 URI 的模型时 SHA1 相同 → 恢复撤销栈,不同 → 丢弃;留存总量上限
   `MAX_MEMORY_FOR_CLOSED_FILES_UNDO_STACK = 20MB`,超出淘汰最早关闭的;超过 10MB 的模型不留):
   - 文件的最后一个编辑器关闭(`closeTab` / `removeGroup` 入最近关闭栈的同一处;别的组还开着它则不算)且 CodeMirror 有撤销 / 重做
     历史 → 按路径留下整个 `EditorState`(挂着的视图取当前状态,未挂着的取本组会话缓存)。
   - 之后以任何方式重新打开该路径(⇧⌘T、资源管理器、⌘P…;VSCode 同,不限于 ⇧⌘T):CodeEditor 挂载时取出,磁盘内容与留存的文档
     相同 → 复用(⌘Z 可撤销关闭前的编辑,光标 / 折叠同关闭时),不同(外部修改)→ 丢弃。取出即移除。
   - 脏文件关闭时选「不保存」(关闭时 tab 仍脏;「保存」的在关闭前已不脏):VSCode `editorGroupView` 的 `ConfirmResult.DONT_SAVE`
     先 `editor.revert()`(`textFileEditorModel` 重新读盘 → `ModelService.updateModel`:前后 `pushStackElement`、以最小差异
     `pushEditOperations` 套进模型),再随模型销毁按上条留存。这里同理:留存前对该状态以最小差异的一步换回已保存内容(单独成组、
     进撤销历史),重开(磁盘未变)后内容为已保存版本、不脏,⌘Z 一步回到丢弃的未保存内容并标脏,再 ⌘Z 继续撤销更早的编辑。
     留存的状态不是这份未保存内容(Markdown 编辑模式里改的,留下的是更早的源码模式状态)→ 不套,原样留存(重开时按上条比对)。
   - 上限:总量按文档 UTF-16 字节估算 ≤ 20MB(`CLOSED_UNDO_MEMORY_MAX`,超出淘汰最早关闭的),文档超过 10M 字符不留
     (`CLOSED_UNDO_DOC_MAX_CHARS`)。撤销历史本身的大小无从精确计量,按文档大小近似(VSCode 按撤销元素的 heapSize)。
   - 作废:文件 / 目录被删除、改名 / 移动(旧路径的留存作废,不随移动)、切换工作区根(不在新根下的作废)—— 与最近关闭条目同一处。
   - 只做代码编辑器与 Markdown 源码模式;Markdown 编辑 / 预览(Milkdown)的撤销历史在 ProseMirror 插件 state 里,跨 Crepe 实例不复用,
     重开后没有撤销历史。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/recently-closed-editors.ts` | 每窗口最近关闭编辑器栈(上限 / 去重 / 失效),不依赖 store |
| `src/stores/editor.store.ts` | `closeTab` / `removeGroup` 入栈;`removePaths` / `closeTabsOutsideRoot` 失效;`renamePath` 改写;`openTab` 的 `index` 选项 |
| `src/panels/Editor/reopen-closed-editor.ts` | 重新打开栈顶(目标组 / 跳过 / 读盘 / 视图状态回填 / 焦点) |
| `src/panels/Editor/editor-commands.ts` | 命令 spec |
| `src/panels/Terminal/terminal-hotkeys.ts` | 终端让出 `⇧⌘T`(仅带 Meta) |
| `src/panels/Editor/editor-view-state-cache.ts` | 关闭文件的撤销历史留存(上限 / 淘汰 / 作废) |
| `src/panels/Editor/CodeEditor.tsx` | 挂载时取回留存、内容相同才复用 |

## 可执行规范

- `reopen-closed-editor.spec.ts`
- `reopen-undo-stack.spec.tsx`:第 7 条(恢复撤销栈 / 内容不同丢弃 / 「不保存」关闭后找回 / 作废 / 上限)
- `reopen-closed-editor-popout.spec.ts`:popout 子窗里 ⇧⌘T(子窗分发、回原组、落到子窗的组、子窗无编辑器组时新建)
