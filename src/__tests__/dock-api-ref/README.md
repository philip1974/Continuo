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
