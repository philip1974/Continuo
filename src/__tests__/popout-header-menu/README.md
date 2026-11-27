# popout 子窗里的 dock 组 header(弹出按钮 + 「⋯」菜单)

背景:dockview-react 用 `ReactDOM.createPortal` 把面板与 header 渲染进 popout 子窗 DOM,代码仍在主窗 JS
环境执行 —— 全局 `window` / `document` / `window.location` 恒为主窗。凡是「找自己所在窗口」的逻辑都必须从
dockview 的组位置(`group.api.location.type`)或元素的 `ownerDocument` 取,不能读全局。

## 行为契约

- **弹出按钮**:组位于 popout 子窗(`group.api.location.type === 'popout'`)时 header 不显示「弹出」按钮;
  grid / floating 组照常显示。不再按 `window.location` 的 `?popout=1` 判定(header 由主窗渲染,恒为主窗)。
- **「⋯」菜单(共享 DropdownMenu)**,触发按钮位于子窗时:
  - 菜单 portal 到触发按钮所在文档的 body(子窗),不出现在主窗;
  - 定位用触发按钮所在窗口的 viewport(`right = 子窗 innerWidth - 按钮 rect.right`);
  - 在子窗里点菜单 / 触发区之外 → 菜单关闭;
  - 方向键漫游按子窗的焦点元素计算(ArrowDown 从首项到第二项)。
- **空组 tab 条名称**:组内没有 tab 时(面板全弹出到子窗后主窗留下的空占位组,SharedTab 不渲染),组级 header actions
  仍给本组 `.dv-tabs-container` 补 `role=tablist` + 本地化 aria-label,切换语言后随之更新。
- 触发按钮在主窗时行为不变(既有 `dropdown-menu` / `header-actions` 规范覆盖)。

## 不在本主题验证

- 真实 Electron popout BrowserWindow 中的点击 / 键盘手感(需真机)。
