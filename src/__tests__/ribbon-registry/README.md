# ribbon-registry(IconSidebar 活动栏图标贡献)

行为契约:**Plugin 通过 `this.addRibbonAction({ id, title, icon, onClick, priority })`
注入 IconSidebar 的 plugin 区按钮**;IconSidebar 订阅 RibbonRegistry,在内置导航
图标之下、settings 之上动态渲染。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/registries/RibbonRegistry.ts` | RibbonRegistry + RibbonActionSpec |
| `src/plugins/Plugin.ts`(扩展) | 新增 `addRibbonAction` 代理 |
| `src/shell/IconSidebar.tsx`(扩展) | 订阅 RibbonRegistry 动态渲染 |

## 关键行为

### RibbonActionSpec

- `id`(贡献内唯一)
- `title`(NavRailButton 的 tooltip + aria-label)
- `icon`(ReactNode,通常 SVG / emoji)
- `onClick(): void | Promise<void>`
- `priority?: number`(默认 100,升序排,越小越靠前)

### Registry 共通行为(同 PanelRegistry/StatusBarRegistry)

- `register(spec)` → Disposable
- 重复 id → 后注册赢 + warn
- `subscribe(listener)` 在 register/dispose 触发,返 unsub
- `getAll()` 按 priority 升序返回

### Plugin 集成

- `addRibbonAction(spec)` 内部调 `this.app.ribbon.register(spec)` → `this.register(d)`
- _deactivate 自动从 registry 移除
