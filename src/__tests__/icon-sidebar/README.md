# IconSidebar(48px 竖向 Activity Bar)

行为契约:**顶部 Explorer toggle(active=sidebarOpen,点击 → toggleSidebar)+ ribbon
插件贡献按钮(有时显示分隔线);底部 Settings 齿轮(点击 → openOrFocusPanel)+ AccountChip。
Marketplace updateStore.available > 0 时,Settings 角标红圈显数(>9 显「9+」)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/IconSidebar.tsx` | UI |
| `src/stores/layout-ui.store.ts` | sidebarOpen / toggleSidebar |
| `src/marketplace/update-store.ts` | available 数 |
| `src/plugins/registries/RibbonRegistry.ts` | ribbon 贡献 |

## 关键行为

### Explorer toggle

- sidebarOpen=true → button.active=true,title='隐藏 Explorer'
- sidebarOpen=false → active=false,title='显示 Explorer'
- 点击 → toggleSidebar()

### Ribbon

- coApp.ribbon.getAll()=[] → 不渲染分隔线
- 多 ribbon → 顶部分隔线 + 每个 NavRailButton(title 来自 spec.title)
- 点击 → spec.onClick()
- subscribe → 后注册立即出现

### Settings

- 点击 → toggleSettingsPanel()(toggle 语义 + sidebar 副作用由 `settings-toggle` 主题持有)

### updateCount 角标

- =0 → 不渲染角标
- 1-9 → 渲染角标显数字
- ≥10 → 渲染「9+」

### AccountChip

- 显示 'CD' + tooltip 'Continuo Dev · PRO Plan'
- 点击 noop(占位)
