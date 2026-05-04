# plugin-contributions-core(3 个核心贡献点)

行为契约:**Plugin 父类挂三个代理方法 `registerPanel / addCommand / addStatusBarItem`**,
分别走 `LMApp.panels / commands / statusBar` 三个 registry。每个 registry 是纯数据
+ subscribable,UI(Dockview / StatusBar / CommandPalette)在外层订阅渲染。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/registries/PanelRegistry.ts` | 注册 panel type → factory + title |
| `src/plugins/registries/CommandRegistry.ts` | 注册 command id → title + hotkey + fn |
| `src/plugins/registries/StatusBarRegistry.ts` | 注册 statusBar item → side + priority + render |
| `src/plugins/Plugin.ts`(扩展) | 新增 3 个 protected 代理方法,自动 this.register |

## 关键行为

### Registry 共通

- `register(spec)` 返回 `Disposable`,dispose 后 `getAll()` 不含该项
- `subscribe(listener)` 在注册 / 取消时触发,返回 unsub
- 重复 id:**后注册赢**(覆盖前者),旧的隐式 dispose,warn 提示
- `getAll()` 返回 readonly 快照

### PanelRegistry 特有

- `PanelSpec`:`{ type, factory, title }`
- `factory` 是 React 组件(Dockview render 时调)

### CommandRegistry 特有

- `CommandSpec`:`{ id, title, hotkey?, fn }`
- hotkey 冲突:后注册赢同样适用,但只 warn 一次

### StatusBarRegistry 特有

- `StatusBarItemSpec`:`{ id, side: 'left' | 'right', priority?, render }`
- `getBySide('left' | 'right')` 按 priority 升序返回

### Plugin 集成

- `registerPanel / addCommand / addStatusBarItem` 内部调 `app.<reg>.register(spec)` 拿 Disposable
- 自动 `this.register(d)` 收集
- `_deactivate` LIFO 清理 → registry 自动移除该 plugin 的所有贡献
