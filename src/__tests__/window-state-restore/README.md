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

## 2. popout 子窗口(`window-state.spec.ts`、`popout-restore-position.spec.ts`、`popout-restore-focus.spec.ts`)

- dockview 6 的 `PopoutWindow.dimensions()` 把子窗序列化成**屏幕绝对坐标**(`screenX/screenY` + `innerWidth/innerHeight`),
  但恢复时 `addPopoutGroup` 又加了一次主窗原点(`window.screenX + box.left`)→ 每次重启往右下漂主窗原点的距离。
  renderer 在 `fromJSON` 前把 popout 位置换算成相对主窗原点(`popoutPositionsRelativeToWindow`),dockview 加回原点后即原值。
- 主进程不再用固定 800×600 覆盖 `window.open` features:解析 `left/top/width/height`(屏幕坐标;width/height 是内容尺寸 →
  `useContentSize`),尺寸不小于子窗最小尺寸 400×270,位置按与主窗同一显示器校验;校验不过 → 不给位置(居中)。
- 恢复出来的 popout 以不抢焦点的方式显示(`showInactive`),主窗保持键盘焦点(VSCode 恢复辅助窗口后焦点仍在主窗)。
  主进程在 `layout:read` 返回布局时登记该窗口将恢复的 popout 数(限时),随后由该窗口打开的那么多个子窗走不抢焦点显示;
  用户主动弹出的子窗照常获焦。

## 3. 重启后焦点(`restore-focus.spec.ts`)

- 启动恢复(explorer 段 + 编辑器 tab 读盘)结束且 dock 布局已恢复后:若有活动编辑器 tab、主窗活动面板是编辑器、焦点仍在
  `body` → 把焦点交给编辑器内容(可直接键入;编辑器懒加载未挂上时逐帧等,限时后退到面板默认落点)。
- 不抢:用户在此期间按过键 / 点过鼠标,或焦点已在别处(非 body),或活动面板不是编辑器(终端等),或没有打开的 tab。
  VSCode 没有编辑器时焦点落在空编辑组;Continuo 的空编辑组没有可键入目标,不做额外聚焦。
