# terminal-store (M-Terminal Step T3)

行为契约:**Terminal 多 session 全局 store**。
TerminalSession 模型简洁(id / title / createdAt / exitCode),关闭后切换逻辑沿用
editor.store getStateAfterClosingTab 同模式。

## 模块

| 文件 | 职责 |
|---|---|
| `src/stores/terminal.store.ts` | sessions / activeId + 6 actions + nextActiveAfterClose 纯函数 |

## TerminalSession 模型

```ts
interface TerminalSession {
  readonly id: string;        // 后端 PTY id(term-${uuid})
  readonly title: string;     // tab 显示名
  readonly createdAt: number; // ms epoch
  exitCode: number | null;    // null = 未退出;number = PTY 已 exit
}
```

## 关键行为

### `addSession({ id, title })` → 推入 + 自动切活跃
### `removeSession(id)` → 委托纯函数 nextActiveAfterClose:
  - 关非活跃 → 减少,active 不变
  - 关活跃且后面有 → 切下一个
  - 关活跃尾部 → 切前一个
  - 关唯一 → activeId = null
  - 关不存在 id → 不变

### `switchSession(id)` → 只改 activeId
### `setExited(id, exitCode)` → session.exitCode = number(标记 PTY 已退出,UI 显示 closed 标记)
### `clearAll()` → sessions = [], activeId = null(主进程 cleanupAll 后用)

## 不在本主题验证

- IPC 真触发 PTY spawn / exit(留 E2E)
- xterm 实例与 session 的绑定(留 T4 hook)
- 持久化(决策 #4:不持久化)
