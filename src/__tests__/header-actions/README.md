# HeaderActions(Dockview group header 自定义按钮)

行为契约:**Dockview header 右侧两个 IconButton:popout(弹出活动 panel 到独立窗口) +
更多操作菜单(列出 PanelRegistry 全部 panel 类型,点击 addPanel 到当前 group)。
activePanel=null 时 popout 按钮 disabled。点更多 → 切 menu;点 menu 外 pointerdown → 关菜单。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/HeaderActions.tsx` | UI |
| `src/plugins/registries/PanelRegistry.ts` | 可选 panel 类型 |

## 关键行为

### popout 按钮

- activePanel=null → disabled
- activePanel 有 → 点击调 containerApi.addPopoutGroup(activePanel, { popoutUrl })

### 更多操作菜单

- 默认关闭(open=false)
- 点击切换 open
- open=true → role=menu 渲染 PanelRegistry.getAll() 每条
- 点 menu item → containerApi.addPanel({ id, component, title, position }) + 关菜单
- panel id 自增计数(同 type 多次点产生不同 id)

### 关闭菜单

- 文档 pointerdown 在 ref 之外 → 关菜单

### subscribe panels

- coApp.panels.subscribe → 注册新 panel 类型立即出现在 menu 里
