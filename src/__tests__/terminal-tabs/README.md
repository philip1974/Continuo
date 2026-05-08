# TerminalTabs(终端 tab 列表 + 「+」按钮)

行为契约:**渲染 useTerminalStore 中的 sessions 为 TabNav 行,每个 tab 显示 title;
agent 来源加 ● 前缀和 agent 标签;exitCode 非 null 时 muted + 文案带「(已退出)」。
点 tab → setActive,点叉 → onCloseSession,点「+」 → onNewSession。
showTabList=false 时只渲染 + 按钮,不渲染 tabs。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Terminal/TerminalTabs.tsx` | UI |
| `src/stores/terminal.store.ts` | sessions store |

## 关键行为

- 列出 sessions 中每个 session 的 title
- agent 来源 → `●` + `${title} · ${agentLabel}` 提示
- exitCode 非 null → `(已退出)` 后缀,muted
- 点击切 tab → setActive(id)
- 点叉 → onCloseSession(id)
- 点「+」 → onNewSession()
- showTabList=false → 不渲染 TabNav,只剩 +
