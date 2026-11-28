# 窗口位置 / 尺寸 / 焦点的重启恢复

对齐 VSCode(`windowsStateHandler` + `WindowStateValidator.validateWindowState` + 辅助窗口 `auxiliaryWindowsMainService`):
每个窗口记住自己的位置、尺寸、最大化 / 全屏;重启按显示器校验后恢复;恢复后键盘焦点在主窗活动编辑器。

## 1. 主窗口几何(`window-state.spec.ts`、`window-state-persist.spec.ts`)

- explorer.json 每个窗口段有 main 独占字段 `windowState`:`{ bounds: {x,y,width,height}, isMaximized?, isFullScreen? }`。
  `bounds` 取 `getNormalBounds()`(最大化 / 全屏前的普通矩形),最大化 / 全屏另记布尔。
- 记录时机:窗口关闭(`close` 时窗口可见才取,隐藏中的窗口状态不可信)与 ⌘Q 退出(flush 通过后、隐藏窗口前取,并在退出流程里
  **等待落盘** —— 关窗 `closed` 的异步写在退出时不被等待)。
- 字段是 main 独占的(同 `layout` / `lastClosedAt`):renderer 写盘合并时保留盘上值,`explorer:read` 返回前剥离。
- 向后兼容:旧文件没有该字段 → 按新窗口处理(默认尺寸)。字段畸形(非有限数 / 非正尺寸)→ schema 拒(整个段按既有损坏处理)。
- 建窗时(VSCode `validateWindowState` 思路):保存的矩形与某个显示器**工作区**的交集在两个方向都 ≥ 128px(窗口本身更小则取
  窗口尺寸)才采用 —— 取交集最大的那块显示器,尺寸收进其工作区、位置平移进其工作区(标题栏总可达);没有显示器满足(拔掉了
  外接屏 / 分辨率变了)→ 弃用保存值,按新窗口处理。最大化 / 全屏在建窗后立即恢复(同 VSCode `CodeWindow` 构造里
  `maximize()` / `setFullScreen(true)`)。
- 新窗口(⇧⌘N / 无保存值,VSCode `getNewWindowState`):默认 1280×800(不超过工作区),在鼠标所在显示器居中;再按
  VSCode `ensureNoOverlap` 错开 —— 只要有已开窗口与它同 x 或同 y,就各 +10px,直到不重合。

## 2. popout 子窗口(`window-state.spec.ts`、`popout-restore-position.spec.ts`、`popout-restore-focus.spec.ts`、`popout-restore-settle.spec.ts`)

- dockview 6 的 `PopoutWindow.dimensions()` 把子窗序列化成**屏幕绝对坐标**(`screenX/screenY` + `innerWidth/innerHeight`),
  但恢复时 `addPopoutGroup` 又加了一次主窗原点(`window.screenX + box.left`)→ 每次重启往右下漂主窗原点的距离。
  renderer 在 `fromJSON` 前把 popout 位置换算成相对主窗原点(`popoutPositionsRelativeToWindow`),dockview 加回原点后即原值。
- 主进程不再用固定 800×600 覆盖 `window.open` features:解析 `left/top/width/height`(屏幕坐标;width/height 是内容尺寸 →
  `useContentSize`),尺寸不小于子窗最小尺寸 400×270,位置按与主窗同一显示器校验(看得见的收进所在工作区,同主窗);校验不过
  (屏已拔掉 / Windows 上的负坐标)或缺失 → 默认 800×600(不超过工作区)在**主显示器**工作区居中,**明确给出 x / y**(VSCode
  `validateWindowState(...) ?? defaultAuxWindowState()`;只给尺寸时 features 里不可用的位置仍可能被采用,窗口拖不回来)。
- 恢复出来的 popout 以不抢焦点的方式显示(`showInactive`),主窗保持键盘焦点(VSCode 恢复辅助窗口后焦点仍在主窗)。
  主进程在 `layout:read` 返回布局时登记该窗口将恢复的 popout 数(限时),随后由该窗口打开的那么多个子窗走不抢焦点显示;
  用户主动弹出的子窗照常获焦。
- **popout 最大化 / 全屏**(`popout-window-mode.spec.ts`;VSCode 辅助窗口 `createState()` 存 bounds + mode,
  `auxiliaryWindowsMainService` 按 `window-maximized` / `window-fullscreen` 建窗后套用):dockview 只存子窗当时的
  screenX/Y + innerWidth/Height,最大化 / 全屏时退出存下的是铺满屏幕的尺寸、也不记状态 → 重启成铺满屏幕的普通窗口,原尺寸丢失。
  - main 在子窗 maximize / unmaximize / enter-full-screen / leave-full-screen / resize / move 时(建窗时也一次)向打开它的
    主窗推 `window:popout-state`:子窗名、状态(normal / maximized / fullscreen)、普通矩形(`getNormalBounds()` 换算成
    dockview position 的口径:窗口左上角 + 内容尺寸;窗框尺寸只在普通状态下量,全屏时标题栏隐藏)。隐藏中的子窗不推
    (⌘Q 退出流程先隐藏全部窗口,其间的状态不可信,同主窗 `windowState`)。
  - renderer 写布局时,最大化 / 全屏的 popout 组 position 改用普通矩形、并标 `windowMode`;状态变了即标脏落盘(最大化 / 还原
    不一定触发 dockview 布局变更)。
  - `layout:write` 把 `windowMode` 从布局摘出,存窗口段 main 独占字段 `popoutWindowModes`(`{ id, mode, position }`;新增字段 →
    旁挂 `explorer-ext.json`;explorer.json 的布局里是普通矩形,0.2.15 照普通尺寸开子窗)。不随文件夹快照走(同 `windowState`)。
  - `layout:read` 按组 id + position 与布局对得上的项登记(降级期间旧版本挪过的子窗不套用);恢复开窗时 window.open
    features 的位置尺寸对上(容差 1px)→ 以普通矩形建窗,`did-create-window` 里先订阅状态推送(量窗框)、`showInactive`,
    再 `maximize()` / `setFullScreen(true)`(macOS 在别的窗口进出全屏空间的过渡期间会忽略全屏请求 —— 没进入就隔 1s 重试,
    最多 3 次)。还原后回到普通尺寸。用户主动弹出的子窗不套用。
- popout 恢复在途时不写残缺布局(`popout-restore-settle.spec.ts`):dockview `fromJSON` 把 popout 组逐个延时开窗、等子窗
  load 后才挂上,此前 `toJSON` 既不在 grid 也不在 `popoutGroups` 里。布局快照写盘(⌘Q / 关窗 flush、自动保存)先等恢复落定
  —— 登记的 popout 全部挂上、开窗失败(dockview 已收回主窗)或限时 5s(远小于关窗 flush 回执上限)—— 再 `toJSON`;
  否则启动后很快退出 / 关窗会把「没有 popout」的布局落盘,下次启动 popout 与其面板永久丢失。

## 3. 重启后焦点(`restore-focus.spec.ts`)

- 启动恢复(explorer 段 + 编辑器 tab 读盘)结束且 dock 布局已恢复后:若有活动编辑器 tab、主窗活动面板是编辑器、焦点仍在
  `body` → 把焦点交给编辑器内容(可直接键入;编辑器懒加载未挂上时逐帧等,限时后退到面板默认落点)。
- 不抢:用户在此期间按过键 / 点过鼠标,或焦点已在别处(非 body),或活动面板不是编辑器(终端等),或没有打开的 tab。
- 「活动面板」是**主窗正显示的**活动面板(`mainWindowActivePanel`):恢复期间 dockview 挂上 popout 子窗时把子窗的组设为
  活动组,不因此放弃(此前主窗焦点留在 body);popout 恢复落定时活动组改回主窗的组(`workbench-editor-commands` 第 8 条)。
  VSCode 没有编辑器时焦点落在空编辑组;Continuo 的空编辑组没有可键入目标,不做额外聚焦。

## 4. 多显示器建窗后再设一次 bounds(`multi-display-bounds.spec.ts`)

- VSCode `CodeWindow.applyState`(issue #74872 / #146499)/ 辅助窗口 `auxiliaryWindow.applyState`:macOS / Windows 上多于一块
  显示器时,目标屏分辨率比主屏大,构造参数给的 bounds 不一定按目标屏生效 → 建窗后再 `setBounds` 一次。单屏 / Linux 不做。
- 主窗:`new BrowserWindow` 后先再设 bounds,再恢复最大化 / 全屏(还原后回到这个普通矩形)。新窗口(默认尺寸居中)同样再设
  (bounds 总是明确的,同 VSCode 只要求四个值都是数)。
- popout:`did-create-window` 里按建窗参数(`options` 的 x / y / 内容宽高)再设,宽高按当前窗框换算成外框(`useContentSize`);
  先于量窗框 / 推状态与套用恢复的最大化 / 全屏。
