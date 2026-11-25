# 同组切换 dock 面板:视口保持、点 tab 焦点进内容(VSCode 对齐)

VSCode:同一编辑器组里在编辑器 / 面板之间切换,回来时视口原样;鼠标点 tab 后可直接继续输入。
修复前:编辑器与终端在同一 dock 组,切到终端再点回编辑器 → 编辑器滚动归零(源码与 Markdown 编辑模式都是),
焦点停在 dock tab 上。

## 根因

1. dockview 默认 renderer `onlyWhenVisible`:切到同组别的面板时把内容 DOM 从文档卸下(React 组件仍挂着),
   激活时再插回;脱离文档期间布局盒被销毁,插回后所有原生滚动容器 `scrollTop / scrollLeft` 归零。卸下发生在
   dockview 派发隐藏事件之前,隐藏时已读不到滚动值。
2. 点非活动 tab 的标题:dockview 在 pointerdown 里就激活面板,SharedTab 随之把标题从普通 `span` 换成 motion
   `m.span`(另一个 DOM 节点);按下的节点已脱离文档,Chromium 不再派发 click → SharedTab 的「click 时把焦点交给
   面板内容」不执行,焦点留在 mousedown 落到的 tab 上。

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/keep-scroll-while-hidden.ts` | 面板根上捕获阶段记录各滚动容器最近一次位置;重新可见(dockview 插回 DOM 后同步派发)时写回 |
| `src/shell/dock/panel-components.tsx` | 每个 dock 面板(终端除外)挂上述记录 / 恢复 |
| `src/shell/motion/SharedTab.tsx` | 标题元素 active ↔ inactive 保持同一 DOM 节点(只切换 layoutId) |

## 行为

### 滚动保持(`keep-scroll.spec.tsx`)

- 面板内任意原生滚动容器(CodeMirror `.cm-scroller`、Milkdown 滚动层、设置页 / Debug 列表…)滚到某处 → 同组切到
  别的面板 → 切回 → `scrollTop / scrollLeft` 恢复为切走前的值
- 隐藏期间、已脱离文档的元素派发的滚动事件(读到的是归零后的值)不记录
- 已从面板里移除的元素(切文件 tab / 切模式后卸载的旧编辑器)不再恢复、不再持有
- 终端面板不挂:xterm 自管视口,隐藏期间仍有输出,写回旧值会与之冲突
- 不把 renderer 改成 `always`:dockview 对隐藏的 always 面板用 `display:none`,滚动同样丢失,且所有面板常驻布局

### 点 tab 焦点进内容(`tab-click-focus.spec.tsx`)

- 标题元素在 active ↔ inactive 切换中是同一个节点(按下标题时激活面板,click 照常派发 → 焦点交给面板内容)

## 端到端

- `tests/e2e/editor-dock-group-switch.spec.ts`:代码文件 / Markdown 源码 / Markdown 编辑模式,滚到中段 → 同组加
  终端(终端成为活动面板)→ 点回编辑器 dock tab → 滚动值不变、视口中部是正文、焦点在编辑区
