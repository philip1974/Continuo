# explorer-tree (M-Explorer Step 4)

行为契约:**资源管理器 UI 层**(Explorer 容器 + EmptyWorkspace + FolderTree + FileRow)。

本主题**只测 `tree-config.ts` 的纯逻辑**(dataLoader + 配置工厂),
React 组件渲染 / 虚拟滚动 / 真键盘交互留 Step 7 smoke E2E。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Explorer/tree-config.ts` | `createTreeConfig({ root, fs })` 工厂,组装 headless-tree 的 TreeConfig |
| `src/panels/Explorer/index.tsx` | 容器:根据 `workspaceRoot` 路由 EmptyWorkspace ↔ FolderTree |
| `src/panels/Explorer/EmptyWorkspace.tsx` | 中央"打开文件夹"按钮,调 `fs.selectDirectory` |
| `src/panels/Explorer/FolderTree.tsx` | `useTree` + `@tanstack/react-virtual` |
| `src/panels/Explorer/FileRow.tsx` | 单行(`Folder` / `Document` 图标 + 名称 + 状态) |

## 关键行为(tree-config 层)

- `rootItemId` 等于传入的 `root`
- `features` 启用:`asyncDataLoaderFeature` + `selectionFeature` + `hotkeysCoreFeature`
- `dataLoader.getItem(root)` 返回构造的 root entry(`name` = `basename(root)`,`isDirectory: true`)
- `dataLoader.getChildrenWithData(parentPath)` 调 `fs.listDir(parentPath)`:
  - 成功:把 `FileEntry[]` 映射为 `{ id: entry.path, data: entry }[]`
  - 失败:返回 `[]`,`onIpcWarn(message, code, 该目录)` 回调被调(默认 console.warn)
  - `showHidden()` 返回 false 时去掉 `.` 开头的项(每次加载时读取;缺省不过滤)。在 loader 层而非只在渲染时过滤:
    headless-tree 的 ↑/↓/Home/End、全选、Shift 范围选都基于 `tree.getItems()`,须与渲染一致
  - 每次结果回报 `onChildrenLoad(itemId, failure | null)`(成功 null;失败 / 抛错带 code + message),
    调用方据此区分读取失败与空目录
- `dataLoader.getItem(child)`(非 root)调 `fs.listDir(parent)` 查找,找不到时降级返回最小信息
- `getItemName(item)` 返回 `item.getItemData().name`
- `isItemFolder(item)` 返回 `item.getItemData().isDirectory`
- 重命名:IME 组合中(`isComposing` / `keyCode 229`)的 Enter / Escape 不提交、不中止(覆盖 `hotkeys.completeRenaming` / `abortRenaming`,须带全 preset 字段);普通 Enter / Escape 照常

## FileRow 渲染隔离(perf,`folder-tree-row-memo.spec.tsx`)

- `FileRow` 是 memo 组件;FolderTree 经 `readFileRowState(item, tree)` 把行状态(data / isDir /
  isSelected / isFocused / isExpanded / isLoading / isRenaming / renamingValue / level / posInSet /
  setSize / isDraggingOver)以 primitive 下传,定位只传 `start`(行内构造 style)
- 滚动(virtualizer range 变化)时一直在视口的行不重渲;新进入的行按 start 定位
- 键盘移动焦点只重渲新旧焦点行,tabIndex 跟随
- 选中 / 展开 / 剪切灰显 / 重命名受控输入 / 兄弟增删后的 aria-setsize 均正确反映到对应行
- OS 文件拖过同一行:行内子元素冒泡的多次 dragenter 回报同一落点(path + isDirectory 相同)时
  FolderTree 不逐次重渲;换行照常更新落点
- 选中集合不作为 prop 下传:行接稳定的 `getSelectedPaths()`,只在右键(contextmenu 事件)时取快照给本行
  ContextMenu —— 方向键让选中高频变化,只重渲新旧选中行;右键多选中的一项,菜单仍按整组
- 已知:剪贴板空↔非空翻转仍会重渲全部可见行(hasClipboard 供每行 ContextMenu 使用),属低频交互

## 键盘导航滚动到窗口外的行(`folder-tree-scroll-to-item.spec.tsx`)

- headless-tree `updateDomFocus` 在焦点变化后调 `config.scrollToItem`,再轮询最多 500ms 等目标行挂载,
  超时把焦点打回首项;FolderTree 将其接到 `virtualizer.scrollToIndex(下标, { align: 'auto' })`
- 下标取**实际渲染的 items**(`selectVisibleTreeItems` 过滤隐藏文件后)中的位置,不是 `getItemMeta().index`
- 长列表按 End → 滚到末项且 DOM 焦点落在末项;显示隐藏文件时下标包含隐藏项
- 拖放结束不滚动:库在行 drop(内部移动 / OS 文件拖入)后 `setFocused` + `updateDomFocus` 会调
  `scrollToItem`(无焦点时回退首项)→ 该次跳过,列表不跳回源行或首项;库未调用时一次性标志随即清除,
  之后键盘导航照常滚动
- 长列表 drop 后焦点落在实际松手的那一行(库 updateDomFocus 轮询取不到焦点项会重置到首项):内部拖动源行已滚出
  窗口 / OS 文件拖入,焦点都在松手行、列表不跳回;之后方向键从该行继续

## 键盘操作(`folder-tree-keyboard.spec.tsx` + `tree-keyboard.spec.ts`,对齐 VSCode Explorer)

焦点在树内(非输入框)时,`tree-keyboard.ts` 的 `handleTreeKeyDown` 挂在树容器 keydown 冒泡阶段
(晚于 headless-tree hotkeys 的原生监听):

- Enter:文件 → 打开(与单击同一 `openFileByPath`),打开成功后 DOM 焦点交给编辑器(VSCode Windows/Linux 键位
  `explorer.openAndPassFocus`,同双击;打开失败焦点留在树里);目录 → 切换展开。不接库的 `onPrimaryAction`:
  库在每次行单击(含 ⌘ / Shift 多选单击)都调它
- 方向键 / Home / End:库移动焦点后选中改为焦点项(Shift 扩选仍由库处理)
- →(VSCode `list.expand`,when = 可展开 || 有子项):折叠的目录 → 展开;已展开且有子项 → 焦点到第一个子项;文件 / 已展开的空目录
  → 无动作(焦点、选中都不动;库默认 `expandOrDown` 会移到下一行,`tree-config` 覆盖该热键)
- PageDown / PageUp(VSCode `list.focusPageDown` / `focusPageUp`,`listWidget.focusNextPage` / `focusPreviousPage`,`pageFocusTarget`):
  焦点不在可视区末行(首个完整可见行)→ 先移到那里;已在 → 滚一整页再移到新一页的末行(首行);落点是读取失败行则就近找;
  选中跟随;preventDefault(浏览器不再滚一次)。Shift+PageDown / PageUp 在 VSCode 无绑定 → 不处理
- Delete(mac 另有 ⌘⌫):移到废纸篓,与右键「移到废纸篓」同一 `onTrash`;多选且焦点在选中集内时作用于整组;
  确认后焦点与选中移到下一项(没有则上一项),取消则不动;按住不放的自动重复(`e.repeat`)不连删
- 删除确认(VSCode `explorer.confirmDelete`,默认开,设置页可关):键盘与右键共用一处 `ConfirmDialog`(destructive,
  初始焦点在「移到废纸篓」:`defaultAction='confirm'`,可从废纸篓恢复,回车即执行,同 VSCode 删除确认的主按钮默认)。单项标题「确定要删除“x”吗?」/ 文件夹「…及其内容吗?」;多项「确定要删除以下 N 个文件 /
  文件夹吗?」并列出名字(最多 10 个,其余「另有 N 项未列出」);说明「可以从废纸篓恢复」;确认按钮「移到废纸篓」
- 未显示隐藏文件时(loader 已过滤),方向键 / Home / End 不会把焦点 / 选中落到隐藏项;防御:焦点项不在实际渲染的
  行里时 Delete / 复制 / 剪切 / 粘贴都不执行;多选里不在渲染行中的项也被剔除(只作用于可见的选中项)
- 切换「显示隐藏文件」→ 刷新全部已加载目录(loader 缓存按旧设置过滤),隐藏项随之出现 / 消失;关掉时把隐藏项
  (及隐藏目录下的项,`isHiddenWithinRoot`)移出选中集合 —— 右键菜单 / 拖动按选中集合作用,不会再带上看不见的项
- 右键「移到废纸篓」:右键先把树焦点移到该行(VSCode 同款,选中不变);菜单关闭跳过 Radix 焦点还原(否则其 setTimeout
  会抢走确认框的自聚焦,焦点落在遮罩后的树行)。确认框打开期间焦点在框内;取消(Esc)→ 焦点显式回到该行
  (`updateDomFocus`,不依赖 Modal 记录的 prevFocus —— 那是已卸载的菜单项);确认 / 无需确认 → 焦点与选中移到相邻项
- Shift+F10 / 菜单键(VSCode 列表同,`isContextMenuKey`):在焦点行左下角派发 contextmenu(`dispatchContextMenuAt`),
  与鼠标右键同一路径 —— 文件 / 目录各自的菜单,多选且焦点行在选中集内时作用于整组;Esc 关闭后焦点回到该行
- mod+C / mod+X / mod+V(mac ⌘、其它 Ctrl,平台判定同全局命令热键 `matchesHotkey`):与右键剪切 / 复制 /
  粘贴同一实现;粘贴落点 = 焦点目录,焦点是文件则其父目录
- macOS 按住 ⌘ 时其它键无 keyup:按 ⌘ 组合后从库的 pressedKeys 摘掉该键,之后方向键照常
- 键入可打印字符:跳到名称以已键入前缀开头的项(不分大小写、环绕;停顿 800ms 重置;同一字母重复按则在
  同首字母项间循环),选中跟随
- 重命名输入框内的按键、重命名进行中:以上都不触发

## 行的键盘焦点样式(`file-row-focus-style.spec.ts`)

- 行 `outline-none` 去掉浏览器默认焦点环(macOS 为系统强调色框);`:focus-visible` 时 1px 内嵌 `focus-ring` 轮廓
  (`--md-focus-ring`,经 theme.css `@theme inline` 暴露为 `--color-focus-ring`,两主题各有取值)

## 修饰键单击(`folder-tree-click-modifiers.spec.tsx`)

- 普通单击文件 → 打开;⌘ / Ctrl / Shift + 单击文件只改选中(selectionFeature 的多选语义),不打开(VSCode 同款)

## 行内重命名(`folder-tree-rename-input.spec.tsx`,VSCode 同款)

- F2 进入:输入框聚焦并预选主名 —— 文件选 `[0, 最后一个点)`,目录 / 无扩展名 / 点只在开头(`.env`)全选
  (`path-utils.renameStemEnd`);预选只在输入框挂载时做一次,键入不会把光标打回
- 失焦 = 提交(库默认失焦是放弃);提交不把焦点拉回树(用户点到编辑器等处,焦点留在那里)
- Esc 放弃,其后的失焦不提交;Enter 提交只发一次重命名
- Enter 提交成功 → 焦点与选中留在改名后的新项(VSCode);旧 id 随父目录刷新消失,不用库 `completeRenaming` 的
  `updateDomFocus`(它轮询 500ms 等旧项挂载,超时把焦点打回首项),改为 `tree-config.commitRenaming` + 聚焦原项,
  新项出现时再经「新建后定位」同一机制(`pendingReveal`)移过去;失败(如同名冲突)→ 焦点留在原项
- 失焦提交成功 → 新项成为树的焦点 / 选中项,但 DOM 焦点已在树外时不拉回

## 新建文件 / 文件夹(`folder-tree-create.spec.tsx`,VSCode 同款)

- 成功:关输入框 → 父目录(非 root 且折叠时)展开 → 新项一出现在渲染列表就成为树的焦点与唯一选中项
  - 文件:随即在编辑器打开,打开成功后 DOM 焦点进编辑器(可接着输入,VSCode 同款;见 `editor-focus-on-open`);
    树只把新行设为树焦点 / 选中并滚动到新行
  - 文件夹:DOM 焦点落在新文件夹行,不打开任何文件
  - 新项始终不出现(如隐藏文件)时 3s 后放弃定位
- 放弃(Esc / ✕ / 空名 Enter)→ 输入框卸载,DOM 焦点回到树的焦点行(`updateDomFocus`;无焦点行则首项;树为空不动),
  不掉到 body(VSCode:取消后焦点回资源管理器树)
- 失败(含同名冲突 FS_EEXIST):输入框与已输入的名字保留,下方 `role="alert"` 显示按错误码本地化的原因
  (`localizeErrorByCode`),不弹 toast;改名后提示消失,Enter 重试;Esc 放弃(输入框与提示一并消失)
- 再次新建(输入条已开着,不论是否获焦;右键菜单 / 标题栏按钮 / 命令面板「资源管理器: 新建文件…」)→ 换成新的输入条:清空、
  类型与目录随之改变,焦点进新输入框(`creating.seq` 递增作 key 重挂载;VSCode 每次新建都是新的行内输入框并聚焦)
- 失焦(VSCode `InlineEditInputBox`):有名字 → 提交新建(同 Enter);空名 → 放弃,焦点留在用户点的地方(不拉回树)。
  失焦提交尚未完成时又开了新的新建 → 那次提交的成功 / 失败只回写它自己(按 seq),不关掉新输入条
- 实时重名校验(VSCode `validateFileName`「已存在」,`parent.getChild` 平台感知大小写):输入与父目录**已加载**子项同名(文件
  或文件夹;macOS / Windows 忽略大小写,Linux 区分)→ 输入框下方即时提示「已存在」,Enter 不创建;失焦 → 放弃,不创建,焦点
  留在用户点的地方。嵌套名(`a/b.ts`)不在此判
- 失焦触发的提交在 main 端失败(未加载 / 隐藏的同名项、权限等)→ 输入条直接关闭并 toast「无法创建文件「名字」：原因」(文件夹另一条;输入条已消失,须带名字。VSCode 文件服务报错含资源名;失焦时输入无效即取消),
  不留无焦点、带错误的孤立输入条;Enter 提交失败仍保留输入并内联提示(可改名重试)
- 输入框组件契约(重试守卫 / aria-invalid / onEdit / 失焦)见 `create-input` 主题

## 空列表三态(`folder-tree-load-state.spec.tsx`,VSCode 同款)

- 根目录尚未读到(loader 未经 `onChildrenLoad` 回报;点「重试」后也回到此态)→ 「加载中」(`common.loading`,role=status)
- 读取成功但无可显示项 → 「此文件夹为空」
- 根目录读取失败(`onChildrenLoad` 回报)→ `role="alert"` 显示「无法读取此文件夹:{按错误码本地化的原因}」+
  「重试」按钮(与 Header「刷新」同一 `refreshAll`);重试成功后列出文件、失败态消失。不经 loader 的
  `refreshParent` 读到根目录时同样置为已读到
- 根目录失败只走内联提示,不另弹 toast(两个 role=alert 读屏会播报两次)
- 子目录读取失败(VSCode:展开失败的目录下显示错误行):展开着的失败目录之后插入一行内联错误(`DirLoadErrorRow`,
  同根目录文案的普通文本 + 「重试」),不弹 toast;重试 → 焦点先回到该目录行,再重新读取,成功后列出子项、错误行消失
  - 读屏播报:每次读取失败经全局常驻播报区(`src/lib/announce` 的 `announce(text, { politeness: 'assertive' })`,与 toast / Debug 共用)播一次「无法读取“目录名”:原因」;
    错误行自身不是 live region —— 随虚拟滚动出入 overscan、收起再展开重新挂载时不重播
  - 「重试」上的按键不触发树命令:Enter / ← / → / F2 / Delete / Ctrl(⌘)+C 等不收起、不改名、不删除、不复制失败目录,
    焦点留在「重试」;按钮自身的 Enter / 空格激活照常重试(`handleTreeKeyDown` 只处理来自行本身的按键;
    headless-tree 在树容器上的原生 hotkeys 由错误行截住树用到的无修饰键 —— 方向键(含 Shift)/ Home / End / F2 / Enter /
    Delete / 空格(`TREE_ITEM_PLAIN_KEYS`);F5、单字母、Esc 等其它无修饰键与带 ⌘ / Ctrl / Alt 的组合键照常冒泡到全局热键,
    用户自绑的单键全局命令在「重试」上仍生效)。截键在错误行提交时即生效:行刚显示、其 effect 尚未执行就按键
    (主线程繁忙)同样不动失败目录
- 已折叠目录的后台刷新失败(看不到错误行)→ 限流 toast「无法读取“目录名”:{按错误码本地化的原因}」,不含原始诊断串
- 点「重试」后焦点不掉到 body:成功且有项 → 树的焦点行;成功但为空 → 空态提示(tabIndex=-1);仍失败 → 新的「重试」按钮。
  每种结果都清掉待定标记 —— 残留会在之后根目录出现文件时把用户在编辑器 / 终端的焦点拉回树。
  「重试」在显示它的那次渲染的 effect 尚未执行时就点下(手快 / 主线程繁忙),落点照样按本次重试的结果
  (旧的失败结果不会提前消费标记)。空根目录重新读取期间来的 focusTree 请求,读完后落到空态提示。
  focusTree 请求之后、落点之前焦点被移到别处(不是请求时的焦点元素、也没丢失;如切换文件夹后立刻打开「更多操作」菜单)→
  不抢(focusWithinOrLost);「重试」不受此限

## 不在本主题验证

- 真实浏览器虚拟滚动行为(留 E2E)
- selection feature 的内部 state 流转(headless-tree 自带覆盖)
- `EmptyWorkspace` 按钮点击 → fs.selectDirectory → setRoot 的真实 IPC 路径(留 E2E)
- `initExplorerPersistence` 在 main-app.ts 的接入(已在 explorer-stores 主题测过)

## 焦点行滚出视口仍渲染(`folder-tree-focus-pinned.spec.tsx`)

- 鼠标滚轮把 DOM 焦点所在行滚出视口时,虚拟列表不卸载它:virtualizer 的 `rangeExtractor` 在
  `defaultRangeExtractor(range)` 结果中并入焦点行下标(`rangeWithPinnedIndex`,升序去重;越界原样返回)
- 未聚焦过时(headless-tree `getFocusedItem` 回落首项)首项同样常驻,Tab 进树仍有落点
- 滚出视口后 DOM 焦点仍在该行(不掉到 body),↓ / Shift+F10 / ⌘C 等照常;按 ↓ 焦点移到下一行并滚回(VSCode 列表滚动不丢焦点)

## 焦点项不再显示时的修正(`folder-tree-focus-repair.spec.tsx`)

- 焦点项从渲染行里消失(「折叠全部」/ 折叠其祖先 / 外部删除 / 关掉显示隐藏文件)→ 焦点项修正到最近的显示中祖先目录,
  没有(在根下)则原下标处的行(越界取末行,跳过读取失败行;`focusFallbackIndex`)—— 始终有一行 tabIndex=0,Tab 能进树
  (VSCode 列表容器本身可 Tab 进入、焦点为空时 ↓ 从首项起;这里是 roving tabIndex,须修正焦点项)
- DOM 焦点原在被移除的行上(focusin 记录)且已丢失(落到 body)→ 同时移到新焦点行,↓ / ↑ 照常;DOM 焦点在树外 → 只修正 tabIndex,不抢焦点
- 父目录正在重新读取(子项暂缺)不算移除,读完再判断
