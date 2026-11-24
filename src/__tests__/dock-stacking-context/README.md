# dock 图层收进自身层叠上下文

dockview 内部用很大的 z-index:分隔条 sash 99、浮动组 `.dv-resize-container` 997、浮动渲染层 998+、拖放落点
9999。dock 外层容器及其祖先若不建立层叠上下文,这些值会与挂在 `body` 下的全局浮层(toast `--z-toast: 40`、
模态 `--z-modal: 50`、Radix 菜单)同层比较:浮动组盖住 toast / 模态,sash 经过右下角抢走 toast 的悬停与点击。

行为契约(`dock-isolation.spec.tsx`):

1. **主窗**:DockShell 根容器 `isolation: isolate`(Tailwind `isolate`),dockview 的全部层级只在 dock 内部比较,
   不再压过 toast / 模态 / 菜单;dock 内部相对顺序不变(终端搜索条 `--z-terminal-overlay` 仍高于 xterm 画布)。
2. **popout 子窗**:dockview 把组放进子窗 `body` 下的 `.dv-popout-window` 容器,toast 也 portal 进同一个 `body`;
   该容器同样 `isolation: isolate`(`src/styles/dockview.css`,dockview 打开子窗时把主窗样式表复制过去)。
