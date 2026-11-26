# 资源管理器入口命令(VSCode 对齐)

键盘用户不靠鼠标也能新建文件 / 文件夹、打开文件夹、回到资源管理器。命令 id 照抄 VSCode,三语标题,命令面板可搜。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/explorer-commands.ts` | 四条命令的 spec(ExplorerTabPlugin 注册)、`showExplorer` |
| `src/panels/Explorer/explorer-requests.ts` | 命令 → FolderTree 的请求通道(带挂起:文件树未挂载时等它挂载后兑现) |
| `src/panels/Explorer/FolderTree.tsx` | 订阅请求:新建 → 复用 creating 流程;focusTree → 复用「重试」的焦点落点 |
| `src/panels/Explorer/hooks/useSelectWorkspaceFolder.ts` | `selectWorkspaceFolder`:空态按钮 / 头部「切换文件夹」/ 命令共用;选定后发 focusTree |
| `src/panels/Explorer/tree-keyboard.ts` | `focusedTargetDir`:树焦点项的目标目录(键盘粘贴与新建共用) |
| `electron/shared/window-channels.ts` | `MENU_COMMANDS`:应用菜单项即 renderer 命令的登记表(命令 id → accelerator);`RUN_MENU_COMMAND` 通道 |
| `electron/main/lib/menu-command.ts` | 菜单点击 → 目标主窗(popout 子窗 → 打开它的主窗)→ 发 `RUN_MENU_COMMAND` |
| `src/shell/menu-commands.ts` | renderer 收到请求 → 经命令注册表执行(`useMenuCommands` 挂在 MainApp) |

## 行为

### 1. 命令与默认键(`explorer-commands.spec.ts`)

| 命令 id | 标题(en) | 分类 | 默认键 | 取舍 |
|---|---|---|---|---|
| `explorer.newFile` | New File… | 资源管理器 | 无 | 同 VSCode(无默认键);⌘N 在 VSCode 是 `newUntitledFile`,Continuo 无 untitled 编辑器,不占用 |
| `explorer.newFolder` | New Folder… | 资源管理器 | 无 | 同 VSCode |
| `workbench.action.files.openFolder` | Open Folder… | 文件 | mod+O | VSCode mac ⌘O = 打开文件 / 文件夹;Continuo 没有「打开文件」,⌘O 只开文件夹 |
| `workbench.view.explorer` | Show Explorer | 查看 | mod+⇧E | 同 VSCode |

- 默认键(mac / 其它平台)不与任何其它命令的默认键、Quick Open / 命令面板保留键(⌘P / ⌘⇧P)、应用菜单 accelerator 重合

### 2. 新建文件 / 新建文件夹(`explorer-commands-tree.spec.tsx`)

- 在树焦点项所在目录打开 FolderTree 现有的新建输入框(同右键「新建」):目录 → 自身;文件 → 所在目录;用户还没在树里
  移动过焦点 → 工作区根。提交 / 失败 / 放弃的后续行为与右键新建完全相同(`explorer-tree/folder-tree-create.spec.tsx`)
- 资源管理器标题栏「新建文件 / 新建文件夹」按钮与命令同一落点(`header-new-target.spec.tsx`;VSCode 标题栏按钮即同一命令):
  选中 / 焦点在文件夹 → 建在里面;在文件 → 建在所在目录;用户还没在树里移动过焦点 → 根
- 侧栏隐藏 → 先显示;启动即关闭(文件树尚未挂载)时请求挂起,文件树挂载后打开输入框并获焦
- 没有工作区 → 不出输入框,等同「显示资源管理器」(焦点到「打开文件夹」)

### 3. 显示资源管理器(⌘⇧E)

- 侧栏隐藏时打开;有工作区 → 焦点进树的焦点行(树还在加载则加载完再给;空文件夹 → 空态提示;读取失败 → 重试按钮);
  无工作区 → 焦点到空态的「打开文件夹」

### 4. 打开文件夹(命令 / 空态按钮 / 头部「切换文件夹」)

- 复用同一流程(单飞锁 + 过期守卫 + 失败 toast);命令另先确保侧栏可见
- 选定后焦点交给新 root 的文件树(VSCode:打开文件夹后焦点在资源管理器),不随卸载的空态按钮掉到 body
- 取消选择 → 工作区与焦点不变
- 从「最近打开」(标题栏「更多操作」菜单 / 空态最近项)或拖文件夹进窗口切换 root 后同样把焦点交给新 root 的文件树
  (`switchToCheckedRoot` → `focusTreeAfterRootSwitch`;此前触发按钮随 root 变化卸载,焦点落到 body 并一直停在那里)。
  只在焦点仍在侧栏里或已丢失时交(focusWithinOrLost:等待探测期间用户把焦点移到编辑器 / 终端 → 不抢);该文件夹已在别的
  窗口打开(聚焦那个窗口)/ 探测失败 → 本窗口焦点不动;树加载完之前用户又把焦点移走(如立刻再开菜单)→ 落点时不抢(`explorer-tree/README.md`)(`explorer-mutate/open-recent-root.spec.ts`,真机
  `tests/e2e/open-recent-focus-tree.spec.ts`)

### 5. 应用菜单「文件 → 打开文件夹… ⌘O」(`menu-open-folder.spec.ts`、`dirty-close-confirm/close-confirm-flow.spec.ts`)

- VSCode 文件菜单有「打开文件夹… ⌘O」:位于「新建窗口」与分隔线之后、「在新窗口中打开文件夹…」之前;三语标题
- 菜单项即命令 `workbench.action.files.openFolder`:点击 → main 向聚焦主窗发执行请求,renderer 经命令注册表执行(流程同第 4 条);
  聚焦的是 popout 子窗 → 发给打开它的主窗;没有可用主窗(mac 关光窗口)→ 选定后在新窗口打开
- renderer 只执行 `MENU_COMMANDS` 登记的 id;任一文档有 Modal 打开时不执行(同工作台快捷键)
- 菜单 accelerator 等于命令默认键(`MENU_COMMANDS` 守护,`explorer-commands.spec.ts`),不与其它命令默认键 / picker 保留键 /
  其它菜单快捷键重合。一次按键只执行一次:Electron 先把 keydown 交给页面,页面全局热键执行命令并 `preventDefault` 后
  菜单 accelerator 不再触发;页面没处理(用户改了键、Modal 打开时热键让路)才由菜单执行(打开文件夹本身单飞,重复触发也只弹一次框)。
  e2e 模式无应用菜单

## 端到端

- `tests/e2e/explorer-commands.spec.ts`:⌘⇧E 聚焦资源管理器树;命令面板「新建文件」在根目录创建并打开
