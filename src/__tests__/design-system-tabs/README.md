# design Tabs(垂直 tab 列表)

行为契约:**`<Tabs items activeId onSelect>` 渲染 nav role=tablist,
每条 button role=tab + data-active + aria-selected;点击调 onSelect(id)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/design/Tabs.tsx` | UI |

## 关键行为

- 渲染 nav.wm-tabs role=tablist
- items.length 个 button role=tab,wm-tab-button
- activeId 匹配 → data-active=true + aria-selected=true,其它 false
- 点击 → onSelect(id)
