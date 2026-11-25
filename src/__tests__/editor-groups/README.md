# 编辑器拆分(多编辑器组)

对齐 VSCode editor groups:编辑区可以有多个**编辑器组**,每组有自己的打开文件列表与活动文件;同一文件在多组打开时
共享同一文档(内容、脏状态、保存),一处编辑另一处实时同步。

## 参考:VSCode 的做法

| VSCode | 行为 |
|---|---|
| `workbench.action.splitEditor`(⌘\ / Ctrl+\) | 在活动组右侧新建组,把当前编辑器复制过去(含视图状态),新组成为活动组并获焦 |
| `workbench.action.splitEditorDown`(⌘K ⌘\,本实现无默认键) | 同上,向下 |
| 编辑器 tab 右键「向右拆分」 | 以该 tab 的文件拆分 |
| `workbench.action.focusFirst/Second/ThirdEditorGroup`(⌘1 / ⌘2 / ⌘3) | 聚焦第 N 个组(激活其面板、聚焦其活动编辑器);N 恰为「组数 + 1」时在最后一组右侧新建**空**组 |
| `workbench.editor.closeEmptyGroups`(默认 true) | 关掉组内最后一个编辑器 → 关闭该组;最后一个组保留为空编辑区 |
| 打开文件(Explorer / Quick Open / 链接) | 落到**活动组**(最近活动的组);文件已在别的组打开也在活动组再开一个编辑器 |
| 同一文件多组打开 | 共享 text model:编辑实时同步、脏状态共享;关闭其中一个编辑器不提示保存(文档仍在别的组打开) |

## 组模型(`src/stores/editor.store.ts`)

- **文档** = `tabs`(每个文件一份 `EditorTab`:内容 / 基线 / 脏态 / 外部同步状态)。所有「按文件」的操作
  (编辑、保存、外部重载、改名、删除、切 root)只改这一份,天然在所有组间共享。
- **组** = `groups: EditorGroup[]`(`{ id, tabIds, activeTabId }`)+ `activeGroupId`。组 id = dock 面板 id
  (`editor`、`editor:2`…,见 `electron/shared/editor-group-id.ts`)。
- **单组模式(只有一个组)与历史完全一致**:组的 tab 列表就是 `tabs`、活动 tab 就是 `activeTabId`(`groups[0]` 只记 id)。
  既有代码 / 测试直接读写 `tabs` / `activeTabId` 的语义不变。
- **多组模式**:`groups[i].tabIds` 是各组 tab 顺序;`activeTabId` 始终镜像**活动组**的活动 tab —— 标题栏、状态栏、
  Explorer autoReveal、Quick Open 最近文件、SDK、关窗脏确认等读 `activeTabId` 的地方自动获得「活动编辑器组」语义。
  每个文档至少在一个组里;组里只放存在的文档。
- 关闭组内 tab:只从该组移除;文档不在其它组时才从 `tabs` 移除。组因此变空且不是唯一的组 → 删除该组
  (closeEmptyGroups),活动组落到相邻组。只剩一个组 → 回到单组模式(`tabs` 按该组顺序排列)。
- 删除路径 / 改名 / 切 root 对每个组按同一规则重算其列表与活动 tab(脏 tab 保留、活动 tab 落到相邻项),变空的组同样关闭。
- dock 面板(组)被用户关掉(dock tab ×)且不是唯一组:只在该组的干净文档关闭,**脏文档移到相邻组**(不丢未保存修改);
  唯一组的面板被关 → 文档保留(与历史一致,下次打开文件时面板补建)。

## 共享文档方案

- **CodeMirror**:各组各自一个 `EditorView`,文本源是 store 里同一份 `content`。A 组输入 → `updateContent` → B 组
  `CodeEditor` 的 value 同步 effect 以**最小差异**(公共前后缀之外的一段)派发到 B 的视图:B 的光标 / 选区随变化映射,
  不跳动;B 自己的 `onChange` 被抑制,不回写。
- **Milkdown**:序列化有损、视图不能增量套用外部 Markdown。B 组 Milkdown 发现 store 内容被**别处**改了(不是自己上抛的)
  → 按新内容重挂载(同外部重载的 reloadEpoch 机制);B 卸载时的回写带基线,基线已不是 store 内容 → 丢弃,
  不会用旧内容覆盖 A 的编辑。已知限制:两组几乎同时在同一 Markdown 里输入(防抖窗口内切组继续打)时,后上抛者覆盖。
- 视图状态缓存(撤销历史 / 光标 / 滚动)按文档 id 共享;拆分时先把源视图的当前状态存入缓存,新组的视图挂载时取用(VSCode
  拆分复制视图状态)。之后两个视图各自的撤销历史独立(VSCode 的撤销栈属于 text model、跨组共享;这里 B 收到的同步变更进 B 的
  历史,在 B 撤销会撤掉 A 的输入并同步回 A,效果接近)。
- `viewRefs`(SDK 跳行、会话视图状态等用)每个文档指向最近登记的视图;该视图卸载时回指同一文档在别组仍挂着的视图。
- 聚焦句柄(打开文件后聚焦编辑器)按「组 + 文档」登记,`requestEditorFocus` 缺省聚焦活动组里的视图。

## 持久化(`editor` 会话段,向后兼容)

- 旧字段不变:`openFilePaths` = 全部打开的文档(各组并集,旧版本可照常恢复成单组)、`activePath` = 活动组的活动文件。
- 只有多组时追加 `groups: [{ id, openFilePaths, activePath }]` 与 `activeGroup`;单组时写出的形态与旧版逐字节一致。
- 读旧格式(无 `groups`)= 单组。读到 `groups`:先按并集恢复文档,再按组分配;读盘失败的文件跳过,变空的组丢弃。
- dock 布局里的多个 `editor*` 面板随 dock 布局恢复;组与面板在启动恢复结束后对齐:没有面板的组并入有面板的组(文档不丢),
  没有文档的多余组面板关闭。

## 适配点(按「活动编辑器组」语义)

| 功能 | 处理 |
|---|---|
| 打开文件(Explorer / Quick Open / 终端链接 / SDK openFile) | `openTab` / `switchTab` 缺省落到活动组 |
| 标题栏 / 状态栏 / autoReveal | 读镜像的 `activeTabId`;非编辑器面板判定按「组 id 形态」而非固定 `'editor'` |
| dock 面板激活 / 编辑区获焦 | 设为活动组(`setActiveGroup`) |
| DockShell 打开文件激活编辑器 | 激活 / 补建**活动组**的面板 |
| ⌘W / ⌘S / 下一个·上一个编辑器 | 作用于活动 dock 面板所在组 / 活动组(EditorPanel 动作按组登记) |
| Markdown 自动保存 | 每个组面板各自调度其活动文件;同一文档的保存按文档串行(saveChains),两组同时到点也只写一次盘 |
| 终端里的 ⌘\ / ⌘1–3 | 让出给命令(focus*EditorGroup 同 VSCode commandsToSkipShell;拆分只在带 ⌘ 时让出,Ctrl+\ 仍是 shell 的 SIGQUIT) |
| 组内批量关闭(右键关闭其他等) | 只关本组;仍在别组打开的脏文档不弹确认 |
| 关窗脏确认 / 外部文件同步 | 按文档(全部组)—— 未改 |
| F6 / 面板聚焦 | 每个组面板都有 `data-editor-panel-root`;e2e 定位多组时取活动组 |
| 启动后聚焦活动编辑器 | 活动面板是任一编辑器组即可 |
| popout | 编辑器组面板可弹出(面板 id 不变,组随之);在 popout 组里拆分 → 新组作为同一 dock 组里的另一个面板(popout 组不能再分栏) |
| 单例面板去重 | `editor:N` 不当成旧版多开的重复编辑器面板关闭 |

## 未做

- 拖文件 tab 到另一组 / 组边缘拆分(编辑器内层 TabNav 无跨组拖拽;dock 层仍可拖动整个组面板)。
- 组间移动编辑器命令、合并组、组的 MRU 激活顺序(活动组关闭后落到相邻组而非最近使用)。
- ⌘\ 拆分空组(无活动文件时为 no-op;⌘N 聚焦尚不存在的下一组仍会新建空组)。
- 组顺序按创建 / 插入顺序(拆分插在源组之后),不是 VSCode 的 GRID_APPEARANCE(网格视觉顺序);复杂网格下 ⌘N 的 N 可能与视觉位置不一致。
- 调试断点 / 执行行装饰按 `viewRefs`(每个文档指向最近登记的视图)同步:同一文件在两组打开时只有其中一个视图显示装饰。
- ⌘K ⌘\ 和弦(向下拆分在 VSCode 的默认键):命令分发不支持和弦,向下拆分无默认键(命令面板 / tab 右键 / 可自行绑定)。

## 规范

| 文件 | 覆盖 |
|---|---|
| `editor-groups-store.spec.ts` | 组模型:拆分、组内打开 / 切换 / 关闭、关空组、共享文档、删除 / 改名、移除组、恢复布局 |
| `editor-groups-persist.spec.ts` | 会话快照按组写出、旧格式读为单组、按组恢复 |
| `editor-groups-panel.spec.tsx` | 两个组面板各自渲染自己的 tab;一处编辑另一处同步;组内关闭;tab 右键向右拆分 |
| `editor-groups-commands.spec.ts` | ⌘\ 拆分 / 向下拆分 / ⌘1⌘2⌘3 聚焦、命令注册与默认键、dock ↔ 组同步 |
| `tests/e2e/editor-split.spec.ts` | 真实应用:⌘\ 拆分后两组同一文件、一处编辑另一处同步、⌘1/⌘2 切组、Explorer 打开落到活动组、⌘W 关掉组内最后一个文件关闭该组、重启恢复两组 |
