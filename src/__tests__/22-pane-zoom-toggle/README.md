# 22-pane-zoom-toggle

行为契约:**iTerm2 风 Shift+Cmd+Enter 把当前 terminal panel 临时撑满 dockview
group 区**。再次触发或切 tab 时复原。PTY / scrollback / 各类 id 完全不动。

> 来源:GitHub [issue #36](https://github.com/philip1974/Continuo/issues/36)
> dev-loop topic 元数据 + plan / red-team 见 `.claude/dev-loop/22-pane-zoom-toggle/`

## 模块

| 文件 | 职责 |
|---|---|
| `@continuo-terminal/react-terminal` (key-mapping) | `shouldSkipXtermKey(event)` 命中 Shift+(Cmd\|Ctrl)+Enter → customKeyEventHandler `return false` 跳过 xterm 默认(已上游化到共享包) |
| `src/shell/dock/terminal-panel-zoom.ts` | `toggleActiveTerminalZoom(api)` guard-first(terminal+grid),只对主 grid terminal 起作用;floating/popout/edge no-op |
| `src/panels/Terminal/terminal-focus-registry.ts` | per-panel focus callback 注册表,exit-maximize 后 DockShell 显式 focus 回 xterm |
| `src/core-plugins/TerminalPlugin.ts` | 注册 command `terminal.zoom.toggle`(hotkey `shift+mod+enter`) + null api guard |
| `src/panels/Terminal/useTerminal.ts` | 返回 `focus()`(stale-safe via `termRef.current?.focus()`);customKeyEventHandler 头部加 shouldSkipXtermKey 分支 |
| `src/panels/Terminal/TerminalPanelView.tsx` | mount 时 `registerTerminalFocus(panelId, focus)`;onDidActiveChange 同时 fit + focus |
| `src/shell/dock/DockShell.tsx` | onReady 订阅 `onDidMaximizedGroupChange`,`isMaximized=false` 时调 `focusTerminalPanel(event.group.activePanel.id)` |
| `electron/shared/i18n-locales/{en,zh,ko}.ts` | `commands.terminal.zoom.title` 三套词条 |

## 关键行为

### 命令注册 + 快捷键(T1, T1b)

- `terminal.zoom.toggle` 命令注册,hotkey = `shift+mod+enter`(`mod` ≡ metaKey || ctrlKey)
- 命令 fn 在 `getDockApi() === null` 时直接 return,**不**把 null 传进 toggle(P0-2 v1)

### Toggle 主路径 — guard-first(T2-T4 + T4e,P1-1 v2)

`toggleActiveTerminalZoom(api)`:
1. `const p = api.activePanel`;`!p` → return
2. `p.contentComponent !== 'terminal'` → return
3. `p.api.location.type !== 'grid'` → return(floating/popout/edge no-op,P1-3 v2)
4. **通过 guard 后才** `api.hasMaximizedGroup() ? exit : maximize(p)`

⚠️ `hasMaximizedGroup` **不**在 guard 之前查 — 否则 active=非 terminal 时也会 exit 别的 group。

### xterm 跳过(T5)

`shouldSkipXtermKey(event)` 6 case:
- ✅ Shift+Cmd+Enter / Shift+Ctrl+Enter → true
- ❌ Shift+Enter(无 mod) → false(仍走 Shift+Enter mapping)
- ❌ Enter / Cmd+Enter → false
- ❌ altKey 干扰 → false
- ❌ isComposing(IME) → false
- ❌ keyup / keypress 类型 → false

### Focus 回路(T6, T6b, T6c)

- `registerTerminalFocus(panelId, fn)` + `focusTerminalPanel(panelId)` CRUD
- DockShell `onDidMaximizedGroupChange isMaximized=false` → `focusTerminalPanel(event.group.activePanel.id)`
- isMaximized=**true** 时**不**调 focus(避免进 zoom 时二次 focus,P2-1 v2)
- unregister 后 invoke 返回 false 且不 throw(P1-2 v2 stale-safe)

### Layout 序列化(T7b,P1-2 v1 修正方向)

`sanitizePersistedDockLayout(snapshotWithTerminal)` — read-time sanitizer
**剥离** terminal panel 并修补 grid 树(摘空 leaf/branch、回退 activeView/
activeGroup),保留 editor 等非终端布局;仅当无任何非终端 panel 残留时才返回
`null`(走默认)。详见 [`dock-terminal-layout-strip`](../dock-terminal-layout-strip/README.md)。
zoom 状态不写持久化层(主路径已不动 `explorer.json`,持久化由 dockview 内部
`grid.maximizedNode` 管)。

### i18n(T9)

en/zh/ko 三套 `commands.terminal.zoom.title`:
- `Toggle Terminal Zoom` / `切换终端缩放` / `터미널 확대/축소 전환`

### Safeguards(走 hardcode-regression 兜底,T8)

- PTY / scrollback / sessionId / panelId / windowId 全程不动
- explorer.json layout 写入路径不变(zoom 是运行时 visual-only)
- 0 硬编码(catalog + hardcode-regression scanner)
- 0 设计系统违规(本 topic 不动 UI 组件)

## 测试矩阵

详 `.claude/dev-loop/22-pane-zoom-toggle/plan-v3.md` § Test/Verification matrix。
