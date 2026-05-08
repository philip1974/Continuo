# TerminalView(单 terminal 容器)

行为契约:**`<TerminalView termId />` 是 useTerminal hook 的 UI 薄壳:挂 containerRef 给 xterm,
isReady=false 时叠 loading overlay(spinner + 「启动 shell…」文案),
isReady=true 时无 overlay。overlay pointer-events-none 不挡焦点。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Terminal/TerminalView.tsx` | UI |
| `src/panels/Terminal/useTerminal.ts` | xterm 实例(本测 mock) |

## 关键行为

### isReady=false

- overlay 渲染,文案含「启动 shell…」
- aria-label='启动 shell'
- pointer-events-none(不阻塞 xterm)

### isReady=true

- 不渲染 overlay
- 容器 ref 仍挂载

### 容器固定

- minHeight: 0 防 ResizeObserver 0×0
