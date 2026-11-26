# useDismissOnOutsidePointer(弹出菜单点外部即关闭)

行为契约:**菜单打开期间,在页面任意处按下指针,若目标不在调用方给出的任一「内部」元素内,菜单关闭。**

由共享的 DropdownMenu 使用(内部 = 触发按钮 + 菜单),ExplorerHeader 与 dock HeaderActions 共用(此前各写一份
pointerdown effect)。

## 行为

- 未打开 → 不监听,不关闭。
- 打开时点内部元素(或其子孙)→ 不关闭;点外部 → 关闭。
- 关闭后 / 卸载后移除监听。

## 接线守卫

DropdownMenu 调用 `useDismissOnOutsidePointer(`;两个菜单调用方渲染 `<DropdownMenu`,且不再自行 `addEventListener('pointerdown'`。
