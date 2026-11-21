# dock-api-ref(DockviewApi 单例 + focus/openOrFocus)

行为契约:**模块级 apiRef 由 DockShell.onReady 注入,unmount 时清空。`focusPanel(id)`
找到对应 panel 调 setActive;`openOrFocusPanel` 已存在则 setActive,否则 addPanel
新建。dock 未就绪时所有外部调用静默 noop(开机时序保护)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/shell/dock/dock-api-ref.ts` | 模块级 DockviewApi 单例 + helper |

## 关键行为

### setDockApi / getDockApi

- set null → 后续 getDockApi 返 null

### focusPanel(id)

- api 未就绪 → 静默
- 找不到 panel → 静默
- 找到 → panel.api.setActive()

### openOrFocusPanel(id, component, title)

- api 未就绪 → 静默
- 找到现存 panel → setActive,不再 addPanel
- 没找到 → addPanel({ id, component, title })
- `setDockApi(api, { layoutPending: true })`(DockShell onReady,布局尚未恢复)→ 调用排队,不立即 addPanel;
  `markDockLayoutRestored(api)` 后按序执行。过期 api 的 mark 无效;onReady 重入(新 api 仍 layoutPending)
  → 已排队操作按序迁移给新 api,set null(卸载)丢弃队列
  (恢复前 addPanel 的面板会被 fromJSON 的 `clear()` 删掉且不再补建)

### runWhenDockLayoutReady(fn)

- dock 未就绪 → 静默;布局已就绪 → 立即 `fn(api)`
- 布局待恢复 → 与 openOrFocusPanel 共用同一队列、同一顺序;fn 在执行时求值(调用方按恢复后的实际面板状态决策,
  如 Settings toggle)
- 排队重放抛错 → `notifyThrownError` 统一可见通知(不静默吞掉),其余排队项照常执行
