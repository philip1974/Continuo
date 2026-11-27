# popout-open-target(活动组在 popout 子窗时,主窗入口打开面板的落点)

背景:dockview `addPanel` 不给 position 时落进**活动组**。面板弹出到 popout 子窗后活动组就是子窗的组,此后从主窗入口
(齿轮 / 应用菜单 / 命令面板 / ⌘, / ⌘T / 插件 `app.dock.openPanel` / 打开文件)新建的面板都落进子窗,主窗里看不到;
⌘, toggle 只看 `api.isActive`,再点一次会把子窗里看不见的设置关掉。

对齐 VSCode:**在触发的窗口打开**;已打开的编辑器在其所在窗口激活并聚焦该窗口。主窗入口(全局热键只挂主窗 document,
见 `popout-panel-keyboard`)触发的打开都按「主窗」处理。

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/group-mru.ts` | `mainWindowAddPosition(api)`:主窗入口新建面板的落点;`mainWindowActivePanel(api)`:主窗正显示的活动面板 |
| `src/shell/dock/dock-api-ref.ts` | `openOrFocusPanelNow` 未给 position 时用 `mainWindowAddPosition`;已存在 → `revealDockPanel`(在子窗则聚焦子窗与面板内容) |
| `src/lib/toggle-settings-panel.ts` | ⌘, / 齿轮 toggle:主窗正显示才关闭 |
| `src/shell/dock/DockReconciler.ts` | 新终端无 grid 参照时的落点(`gridFallbackPosition`)没有可见 grid 组 → 同上 |
| `src/shell/dock/DockShell.tsx` | 用户打开文件时补建的 editor 面板同上;显示落在子窗的编辑器组面板时聚焦子窗(`showEditorGroupPanel`) |
| `src/panels/Editor/editor-open-group.ts` | `editorGroupForOpen(doc)`:未指定组的打开落在触发窗口的编辑器组,主窗没有就新建 |

## 行为(`popout-open-target.spec.ts`,editor 补建见 `dock-reconciler-api-rebuild/restore-after-fromjson.spec.tsx`)

### 新建面板落点(无显式 position)

- 活动组在主窗(grid / 浮动组)且可见 → 照旧落在活动组
- 活动组是主窗里**隐藏的 popout 引用组**(整组弹出后 dockview 留在 grid 里的 0 宽空组;主窗关光其余面板后 dockview 兜底
  把它设为活动组)→ 同活动组在 popout 处理,不落进去(此前「显示输出」/ ⌘, / ⇧⌘F / 新终端都进了这个看不见的组:主窗
  dock 空白、空态消失)
- 活动组在 popout 子窗 → 落在主窗最近使用的组(group MRU);主窗没有带面板的组 → 可见的 grid 组;都没有 → 在主窗 grid
  新建一组
- 覆盖:设置(⌘, / 齿轮 / 命令)、经 `openOrFocusPanel` 的单例面板(插件 `app.dock.openPanel`)、新终端(⌘T / 命令,
  无 grid 终端可作参照时)、用户打开文件时补建的 editor 面板
- 显式 position(dock 标题栏「⋯」菜单 → 落在菜单所在组,含子窗里的菜单)不受影响

### 已存在的单例面板在 popout 子窗

- 主窗入口再打开 → 在其所在窗口激活,聚焦该子窗(dockview 只在活动组变化时 focus 子窗,子窗组已是活动组时不会)并把焦点交给面板内容;
  不另开、不移回主窗

### ⌘, / 齿轮 toggle

- 设置在主窗**正显示**(主窗的活动面板;活动组在子窗时取主窗最近使用组的活动面板)→ 关闭
- 设置在主窗但被别的 tab 遮住 → 激活
- 设置在 popout 子窗(即便是活动面板)→ 不关闭,在子窗激活并聚焦子窗;主窗侧栏不收起

### 打开文件(`open-file-target.spec.ts`;第五十轮审计 B 组问题 1)

背景:唯一的编辑器组经 `workbench.action.moveEditorGroupToNewWindow` 移到子窗后,全局活动编辑器组停在子窗;回主窗在资源管理器单击
文件 / ⌘P 回车,文件落进子窗的 tab 栏,焦点仍在主窗,接着打字进了主窗资源管理器。

VSCode:编辑器服务按**获焦窗口**的编辑器区(`EditorParts.activePart`,随窗口 focusin 更新)取活动组(`editorGroupFinder.findGroup`
未指定组 → `activeGroup`);主窗编辑器区总保留一个(可为空的)组(把最后一组移到新窗口后主窗留下空组),所以从主窗打开的文件落在主窗。

- 打开文件未指定组(资源管理器单击 / 双击、⌘P、搜索结果、终端链接、Markdown 链接、插件 openFile —— 都经 `openFileByPath` /
  `openFileWithContent`;⌘N 新建无标题文件;后退 / 前进与 ⇧⌘T 的原组已不在时):触发窗口(`getCommandDocument`,在第一个 await
  前读出)是主窗而活动编辑器组在子窗 → 落在主窗的编辑器组(主窗活动面板 → 最近使用的组);主窗没有编辑器组 → 在主窗新建一个
  (落点 `mainWindowAddPosition`,读盘成功且仍是最新的用户选择时才建)
- 文件已在子窗的组里开着 → 在主窗的组里也打开它(VSCode 同,不跳去别的窗口)
- 触发窗口是子窗 → 落在该子窗的编辑器组(子窗没有编辑器组 → 照旧活动组)
- 活动编辑器组本就在触发窗口 / 显式指定组(拖到某个组、后退前进回原组)→ 不改投
- 显示落在子窗的编辑器组面板(用户意图打开 / 切换后 DockShell 激活它)→ 同时聚焦该子窗,键盘随之过去;落在主窗 → 只激活

## 不在本主题验证

- 真实 Electron 子窗的系统焦点切换(e2e)
