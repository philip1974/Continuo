# menu-overflow-scroll

窗口矮(如 640×300)时菜单不伸出窗口:限高 + 菜单内纵向滚动(VSCode 上下文菜单同:可用高度不够时菜单限高、出现滚动条,
滚轮 / 键盘可达每一项)。

## Contracts

1. Radix 右键菜单(编辑器 / dock tab 与列表行 `TabContextMenu`、资源管理器 `ContextMenu`、终端 `TerminalContextMenu`)的
   `ContextMenu.Content` 共用 `CONTEXT_MENU_CONTENT_CLASS_NAME`:最大高 = `--radix-context-menu-content-available-height`
   (Radix 按视口、锚点与 collisionPadding 算出的可用高度),`overflow-y: auto`(此前 `overflow: hidden`,滚轮无效)。
   源码守护:`src/` 下每个 `ContextMenu.Content` 都用该常量。
2. 触发按钮弹出的 `DropdownMenu`(资源管理器 / dock 头部「⋯」、大纲「⋯」):`position: fixed` 顶边在按钮下 4px,
   最大高 = 视口高 − 顶边 − 4px(随窗口缩放重算),同样纵向滚动。
3. 键盘:↓ / End 把焦点移到屏外的项时该项滚动到可见(focus 自带滚动;e2e `context-menu-small-window` 验证)。

## Modules

| File | Role |
|---|---|
| `src/lib/menu-surface.ts` | 共享浮层外观、Radix 内容类名、`menuMaxHeightBelow` |
| `src/lib/use-menu-anchor.ts` / `src/lib/dropdown-menu.tsx` | DropdownMenu 锚点与限高 |
| `menu-overflow-scroll.spec.tsx` | 契约 1、2 |
| `tests/e2e/context-menu-small-window.spec.ts` | 真实 Electron:640×300 tab 右键菜单不越出窗口、滚轮可滚、End 末项可见 |
