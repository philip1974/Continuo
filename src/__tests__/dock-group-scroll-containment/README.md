# Dock 组不随面板内容滚动(标签栏固定,只滚内容)

VSCode:编辑器组的标签栏固定在组顶部,滚轮只滚面板内容;内容滚到底后继续滚,整个组不会被带着滚走。

dockview 的分栏视图 `.dv-split-view-container .dv-view` 自带 `position: absolute; overflow: auto`,组
(`.dv-groupview`,标签栏 + 内容)就放在它里面。面板内容里的绝对定位元素(如 `SR_ONLY_STYLE` 视觉隐藏的
`role=status` 状态文本)若沿途没有定位祖先,包含块就落到 `.dv-view`:逃出面板自己的滚动容器、超出组的
`overflow: hidden` 裁剪,撑高 `.dv-view` → 滚轮在面板滚到底后接力滚动 `.dv-view`,标签栏和搜索框一起被滚出视野
(Settings 的「插件」「插件市场」页)。

行为契约(`group-scroll-containment.spec.ts`,CSS 契约;真机见 e2e `dock-group-no-scroll.spec.ts`):

1. **面板内容区是定位容器**:`src/styles/dockview.css` 给 `.dv-content-container` `position: relative`,
   一次兜住所有面板(设置 / 插件 / Explorer / 终端 / Debug / 编辑器 / 插件面板、popout 子窗与浮动组)里绝对定位
   元素的包含块,溢出被组的 `overflow: hidden` 裁掉,不再撑高外层视图。
2. **分栏视图不可被内容撑滚**:分栏里的 `.dv-view` 改 `overflow: clip`(不是滚动容器:滚轮、`scrollIntoView`、
   聚焦都滚不动它)。dockview 按布局给每个视图精确尺寸,不依赖它滚动。
3. **真机**:插件市场页滚到底再继续滚,组的 `.dv-view` `scrollTop` 仍为 0,标签栏留在原位。
