# tab-icons(SettingTab icon 工厂集合)

行为契约:**每个 export 是 React 组件,返回单个 svg 节点(aria-hidden,
14×14,viewBox 16×16,stroke=currentColor)。被 SettingTabSpec.icon 直接调用挂在 IconSidebar。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/settings/tab-icons.tsx` | 7 个内置 SettingTab icon |

## 关键行为

每个 icon 渲染时:
- 根元素是 svg
- width=14, height=14
- viewBox='0 0 16 16'
- stroke='currentColor', fill='none'
- aria-hidden=true
- 至少包含一个子图形元素(path / rect / circle 等)
