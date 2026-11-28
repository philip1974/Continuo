# 编辑器拆分(多编辑器组)

对齐 VSCode editor groups:编辑区可以有多个**编辑器组**,每组有自己的打开文件列表与活动文件;同一文件在多组打开时
共享同一文档(内容、脏状态、保存),一处编辑另一处实时同步。

## 参考:VSCode 的做法

| VSCode | 行为 |
|---|---|
| `workbench.action.splitEditor`(⌘\ / Ctrl+\) | 在活动组右侧新建组,把当前编辑器复制过去(含视图状态),新组成为活动组并获焦 |
| `workbench.action.splitEditorDown`(⌘K ⌘\,本实现无默认键) | 同上,向下 |
| 编辑器 tab 右键「向右拆分」 | 以该 tab 的文件拆分 |
| `workbench.action.focusFirst…EighthEditorGroup`(⌘1 … ⌘8) | 聚焦第 N 个组(激活其面板、聚焦其活动编辑器);N 恰为「组数 + 1」时在最后一组右侧新建**空**组。只按**触发窗口自己的**编辑器组编号(多窗口时各窗口各自编号) |
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
  (closeEmptyGroups),活动组落到**最近使用的组**(`groupMru`,VSCode mostRecentActiveGroups;无记录才落到左邻,见
  `src/__tests__/editor-tab-management/`)。只剩一个组 → 回到单组模式(`tabs` 按该组顺序排列)。
- 删除路径 / 改名 / 切 root 对每个组按同一规则重算其列表与活动 tab(脏 tab 保留、活动 tab 落到相邻项),变空的组同样关闭。
- dock 面板(组)被用户关掉(dock tab × / 中键 / ⌘W 关空组等所有 `api.close` 入口)且不是唯一组:**照 VSCode 先确认**只在该组
  打开的脏文档(关闭守卫 `editorGroupCloseGuard`,确认框在该组面板里):一个文件「保存 / 不保存 / 取消」,多个文件合并一个框
  「全部保存 / 不保存 / 取消」(与关闭脏 tab 同一套文案);取消 / 保存失败 → 组不关;保存 / 不保存 → 组关闭、其文档全部关闭
  (「不保存」的修改在重新打开后可 ⌘Z 找回,同关闭脏 tab)。关闭时自动保存的文档直接保存、不进框。仍在别的组打开的文档不算
  随之关闭、不确认。命令面板「关闭编辑器组」(closeEditorsAndGroup)同一确认。未经守卫的移除(防御)仍把脏文档移到最近使用的组。
  唯一组的面板被关 → 文档保留(与历史一致,下次打开文件时面板补建)。popout 子窗关窗时面板回到主窗,不是关闭,不确认。

## 共享文档方案

- **CodeMirror**:各组各自一个 `EditorView`,文本源是 store 里同一份 `content`。A 组输入 → `updateContent` → B 组
  `CodeEditor` 的 value 同步 effect 以**最小差异**(公共前后缀之外的一段)派发到 B 的视图:B 的光标 / 选区随变化映射,
  不跳动;B 自己的 `onChange` 被抑制,不回写。
- **Milkdown**:各组各自一个 Crepe 视图。B 组发现 store 内容被**别处**改了(不是自己最近上抛 / 回写的)→ 把新内容解析成
  ProseMirror 文档,只替换与当前文档不同的那一段(`findDiffStart` / `findDiffEnd`,不重挂载):B 的光标 / 选区随事务映射
  (VSCode 各编辑器保留自己的光标);该事务不进撤销栈,B 已有的撤销历史被映射过去 —— 在 B 撤销只撤 B 自己的输入
  (VSCode 撤销栈属于 text model、跨组共享,这里按视图独立);套用的内容即 B 的新基线,不再上抛。只读预览同样增量套用。
  外部进程改盘 / 还原文件(reloadEpoch 递增)同样就地套用但**进撤销栈**、自成一组(⌘Z 找回重载前的内容,见 `editor-revert-file`)。已知限制:两组几乎同时在同一 Markdown 里输入(防抖窗口内切组继续打)时,后上抛者覆盖
  (B 尚未上抛的输入被套用覆盖)。`editor-groups-milkdown-sync.spec.tsx` 用真实 Crepe 钉住。
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

## 组的空间顺序(`src/shell/dock/editor-group-order.ts`)

对齐 VSCode `GroupsOrder.GRID_APPEARANCE`:用户可感知的「第 N 组」一律按位置 —— dock 标题「编辑器 N」、⌘1/⌘2/⌘3(及「组数 + 1」
新建组时以空间上最后一组为参照)、重置布局的分栏次序、读屏名称里的组号。

- 主窗:dockview 序列化网格树(`toJSON().grid.root`)深度优先 —— 横向分支从左到右、纵向分支从上到下;同一 dock 组里叠放的
  多个编辑器组按 tab 顺序;浮动组排在网格之后;网格里找不到位置的(瞬时状态)按 store 组顺序兜底。不看 DOM 坐标。
- popout 子窗:各子窗按其 dock 组的 tab 顺序各自从 1 编号,不计入主窗。
- **store 的组顺序不随拖动改写**:`groups` 仍按创建 / 插入顺序(拆分插在源组之后),只用于持久化与内部查找;位置相关的
  功能都从 dock 现场求,dock 布局本身随会话持久化,重启后编号与位置仍一致。不同步 store 顺序 → 拖动换位不触发编辑器会话写盘,
  也不会与 popout 子窗各自编号的口径冲突。

## 适配点(按「活动编辑器组」语义)

| 功能 | 处理 |
|---|---|
| 打开文件(Explorer / Quick Open / 终端链接 / SDK openFile) | `openTab` / `switchTab` 缺省落到活动组 |
| 标题栏 / 状态栏 / autoReveal | 读镜像的 `activeTabId`;非编辑器面板判定按「组 id 形态」而非固定 `'editor'` |
| dock 面板激活 / 编辑区获焦 | 设为活动组(`setActiveGroup`) |
| DockShell 打开文件激活编辑器 | 激活 / 补建**活动组**的面板 |
| ⌘W / ⌘S / 下一个·上一个编辑器 | 作用于活动 dock 面板所在组 / 活动组(EditorPanel 动作按组登记) |
| Markdown 自动保存 | 每个组面板各自调度其活动文件;同一文档的保存按文档串行(saveChains),两组同时到点也只写一次盘 |
| 终端里的 ⌘\ / ⌘1–8 | 让出给命令(focus*EditorGroup 同 VSCode commandsToSkipShell;拆分只在带 ⌘ 时让出,Ctrl+\ 仍是 shell 的 SIGQUIT) |
| 组内批量关闭(右键关闭其他等) | 只关本组;仍在别组打开的脏文档不弹确认 |
| 关窗脏确认 / 外部文件同步 | 按文档(全部组)—— 未改 |
| F6 / 面板聚焦 | 每个组面板都有 `data-editor-panel-root`;e2e 定位多组时取活动组 |
| 启动后聚焦活动编辑器 | 活动面板是任一编辑器组即可 |
| popout | 编辑器组面板可弹出(面板 id 不变,组随之);在 popout 组里拆分 → 新组作为同一 dock 组里的另一个面板(popout 组不能再分栏);⌘1/⌘2/⌘3 只在主窗分发,只数主窗(grid / floating)里的组,不够时以主窗最后一组为参照新建 —— 子窗里的组既不计入也不作参照 |
| tab 栏样式 | 非活动组的活动 tab 用 design `TabNav` 的 `unfocused`:保留选中底色、去掉强调下划线、文字 fg-muted(VSCode `tab.unfocusedActive*`);活动组判定 = `activeGroupId` |
| 单例面板去重 | `editor:N` 不当成旧版多开的重复编辑器面板关闭 |
| dock 面板标题 | 「编辑器 N」的 N = 该组在所在窗口里的**空间位置**(与 ⌘1/⌘2/⌘3、重置布局、读屏组号同一来源 `editorGroupNumbers`,见下「组的空间顺序」),第一位为「编辑器」不带号;**不是组 id 的号码**(`nextEditorGroupId` 复用最小空号)—— 对齐 VSCode EditorGroupView「Group N」按 GRID_APPEARANCE 位置、增删 / 换位后重新编号。主窗(grid / floating)一起编号;popout 子窗里的组按各自子窗的 tab 顺序编号(⌘N 不在子窗分发,VSCode 辅助窗口也各自从 Group 1 起)。组增删 / 拖动换位 / 移入移出 popout(含重启恢复的子窗挂上与关闭 —— dockview 此时不保证发布局事件,另订阅各编辑器组面板的 `onDidLocationChange`)/ 恢复布局 / 切 locale 时重算(`panels.editor.title_numbered`,`useDockLocaleSync`)。用途:popout / 浮动组里拆分、拖进同一 dock 组时多个编辑器组面板叠成同组 tab 可区分(`i18n-strings-r2/dock-locale-sync.spec.tsx`,e2e `editor-split.spec.ts`、`editor-group-order.spec.ts`) |
| 读屏名称 | 所在窗口有多个编辑器组时编辑区名称「<文件名>，编辑器组 N」(VSCode「<name>, Editor Group N」),N 同 dock 标题;单组不变(见 `src/__tests__/editor-accessible-name/`) |
| 视图:重置布局 | 编辑器组不合并,保持左右分栏(见 `src/__tests__/dock-reset-layout/`) |

## 未做

- 拖文件 tab 到另一组 / 组边缘拆分(编辑器内层 TabNav 无跨组拖拽;dock 层仍可拖动整个组面板)。
- ⌘\ 拆分空组(无活动文件时为 no-op;⌘N 聚焦尚不存在的下一组仍会新建空组)。
- 调试断点 / 执行行装饰按 `viewRefs`(每个文档指向最近登记的视图)同步:同一文件在两组打开时只有其中一个视图显示装饰。
- 编辑器组全部在 popout 子窗时主窗 ⌘1 为 no-op(VSCode 主窗总有编辑器组;这里不为此在主窗补建空组)。
- ⌘K ⌘\ 和弦(向下拆分在 VSCode 的默认键):命令分发不支持和弦,向下拆分无默认键(命令面板 / tab 右键 / 可自行绑定)。

## 规范

| 文件 | 覆盖 |
|---|---|
| `editor-groups-store.spec.ts` | 组模型:拆分、组内打开 / 切换 / 关闭、关空组、共享文档、删除 / 改名、移除组、恢复布局 |
| `editor-groups-persist.spec.ts` | 会话快照按组写出、旧格式读为单组、按组恢复 |
| `editor-groups-panel.spec.tsx` | 两个组面板各自渲染自己的 tab;一处编辑另一处同步;组内关闭;tab 右键向右拆分 |
| `editor-groups-milkdown-sync.spec.tsx` | 真实 Crepe:另一组的编辑增量套进本组 Milkdown —— 不重挂载、光标映射、撤销只撤本组输入、不回抛;预览同样增量套用 |
| `editor-groups-close-dirty.spec.tsx` | 关闭含脏文件的组:无脏放行、单个 / 合并确认框、取消不关、不保存后脏文档随组关闭、保存后放行、别组仍打开的不确认 |
| `editor-groups-commands.spec.ts` | ⌘\ 拆分 / 向下拆分 / ⌘1⌘2⌘3 聚焦、命令注册与默认键、dock ↔ 组同步 |
| `editor-groups-order.spec.tsx` | 真实 dockview:空间顺序(左右 / 上下 / 叠放 / 浮动 / popout)、拖动换位后标题 / ⌘N / 重置布局 / 读屏组号跟位置走、重启恢复的 popout 子窗挂上与关闭后重新编号 |
| `tests/e2e/editor-group-order.spec.ts` | 真实应用:dock tab 拖到最左后标题 / ⌘1 跟位置、重启保留;重启恢复的 popout 子窗关掉后编号不重名;多组读屏名称带组号 |
| `tests/e2e/editor-split.spec.ts` | 真实应用:⌘\ 拆分后两组同一文件、一处编辑另一处同步、⌘1/⌘2 切组、Explorer 打开落到活动组、⌘W 关掉组内最后一个文件关闭该组、重启恢复两组 |
