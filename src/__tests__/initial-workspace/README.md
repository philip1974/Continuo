# initial-workspace 解析

行为契约:**新主窗口启动时通过 query string `?workspace=<encoded path>` 携带
要打开的目录路径**。renderer 端在 hydrate 阶段优先用此值,跳过 `explorer.json`
里的 `workspace.current`,实现多窗口看不同 folder(issue #23 Phase 1)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/lib/initial-workspace.ts` | 纯函数 `parseInitialWorkspace(search)` |
| `src/lib/persist/explorer-persist.ts` | hydrate 启动时调用,有则用 query |

## 关键行为

### 有 `?workspace=<path>` → 返回 decoded 绝对路径

URL-encoded 字符正常解码(`%20` → 空格,`%2F` → `/` 等)。

### 无 `?workspace` → 返回 null

走 explorer.json 持久化路径(主窗口默认行为)。

### 空字符串 / 仅空白 → 返回 null

防御性:空 query 不应触发 workspace 切换。

### 与 `?popout=1` 共存

`?popout=1&workspace=/x` 仍能解出 workspace,但 popout 模式 renderer 不
hydrate workspace,值被忽略 — 不互相破坏。
