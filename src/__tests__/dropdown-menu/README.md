# DropdownMenu(触发按钮弹出的菜单)

行为契约:**菜单 portal 到触发按钮所在文档的 body(popout 子窗见 `popout-header-menu`)、按触发按钮定位(fixed);打开时焦点进入首项、方向键漫游、Escape / Tab 关闭并把焦点
还给触发按钮;在触发按钮(及调用方给的额外「内部」元素)与菜单之外按下指针即关闭。菜单项经 render 函数拿到
`close`(仅关闭)与 `closeAndRestore`(关闭并还原焦点到触发按钮)。**

Explorer 头部「⋯」菜单与 dock 面板头部「⋯」菜单共用(此前两处各装配一遍 useMenuKeyboard / useMenuAnchor /
useDismissOnOutsidePointer / createPortal,焦点还原已分叉:dock 菜单在「面板类型已注销 / 新建失败」分支只关菜单,
焦点落到 body)。

## 接线守卫

两个调用方都渲染 `<DropdownMenu`,且不再直接调用 useMenuKeyboard / useMenuAnchor / createPortal。
