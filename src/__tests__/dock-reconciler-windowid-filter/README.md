# dock-reconciler-windowid-filter

行为契约:**renderer ingress filter as defense-in-depth**,收尾 window isolation 的 renderer 半边。
main 端已经按 `BrowserWindow.id` 做 list/broadcast 过滤;renderer 端仍要在入口处再过滤一次,
避免异常快照、mock、旧 preload 或未来 refactor 把其它 window 的 terminal session 写入当前 window store。

## 关键不变量

- **INV-1: prev/next 同源 filtered**。Dock reconciler 只消费当前 window 可见 sessions;传给 reconciler 的
  `previousSessions` 与 `nextSessions` 必须来自同一个 `currentWindowId` 过滤域,避免跨窗 session 被 add/remove。
- **INV-2: `ownerWindowId` post-create immutable**。创建后 owner 不应被 renderer 改写;renderer filter 只防御异常
  owner-switch 快照。main service 侧由 `src/__tests__/terminal-sessions-service/terminal-sessions-service.spec.ts`
  锁 `ownerWindowId` 写入、过滤和 removeByOwner 行为,本主题只引用不复制。

## 落点

| 文件 | 本主题锁什么 |
|---|---|
| `src/stores/terminal.store.ts` | `filterByOwnerWindow` 纯函数:过滤、shape guard、drop reason、无 console 副作用 |
| `src/shell/dock/TerminalSessionsSync.tsx` | `listSessions` 与 `onSessionsChanged` ingress 调 filter 后再 `replaceSnapshot` |

## popout 推论

`src/shell/App.tsx:123` 分支为 `{isPopoutWindow() ? <PopoutHost /> : <MainApp />}`。
popout window 自身渲染空 `PopoutHost`;dockview popout 的内容来自主窗 React 树 portal,
popout 内 `TerminalPanelView` 读的是主窗 store。因此**主窗 ingress filter 足够,popout 不需特例**。

## T1-T21

| T | spec | 简述 |
|---|---|---|
| T1 | `filter-pure-fn.spec.ts` | 空数组 -> 空 |
| T2 | `filter-pure-fn.spec.ts` | `[A:o1]`,wid=1 -> `[A]` |
| T3 | `filter-pure-fn.spec.ts` | `[A:o1,B:o2]`,wid=1 -> `[A]`,顺序保留 |
| T4 | `filter-pure-fn.spec.ts` | `[A:o2,B:o2]`,wid=1 -> `[]` |
| T5 | `filter-pure-fn.spec.ts` | `[null,A:o1]` -> `[A]` + `not-object` |
| T6 | `filter-pure-fn.spec.ts` | `[42,'string',A:o1]` -> `[A]` + `not-object` x2 |
| T7 | `filter-pure-fn.spec.ts` | 缺 `ownerWindowId` 但有 id -> `missing-owner` |
| T8 | `filter-pure-fn.spec.ts` | `ownerWindowId` 非当前 -> `wrong-owner` |
| T9 | `filter-pure-fn.spec.ts` | owner 正确但 shape 不合法 -> `shape-invalid` |
| T10 | `filter-pure-fn.spec.ts` | 纯函数不直接 `console.warn` |
| T11 | `ingress-filter.spec.ts` | `TerminalSessionsSync.listSessions` 响应写入 filtered snapshot |
| T12 | `ingress-filter.spec.ts` | `TerminalSessionsSync.onSessionsChanged` 多次推送持续 filtered |
| ~~T13~~ | — | 已撤:LegacyTerminalPanel 已删,SessionsSync 全权代理 ingress(T11/T12 已覆盖) |
| ~~T14~~ | — | 已撤:同上 |
| T15 | `ownership-immutability.spec.ts` | owner-switch 异常:prev `[A:o1]`,next `[A:o2]` filtered 后视为 removed |
| T16 | `runtime-guard.spec.ts` | null payload 不抛并 drop `not-object` |
| T17 | `runtime-guard.spec.ts` | number/string payload 不抛并 drop `not-object` |
| T18 | `runtime-guard.spec.ts` | 多种 shape-invalid:非 string id、非 number createdAt、`exitCode: undefined`、非法 origin、缺 cwd |
| T19 | `single-window-noop.spec.ts` | 单窗全部 owner 命中时深 equal 且 identity 等价 |
| T20 | `warn-rate-limit.spec.ts` | 同 `sessionId+reason` 多次推送只 warn 一次 |
| T21 | `non-finite-windowid.spec.ts` | `windowId` 为 NaN/Infinity/undefined 时不订阅 terminal ingress,且 warn 一次含 `not finite` |

## 关联主题

- main service INV-2 锁点:`src/__tests__/terminal-sessions-service/terminal-sessions-service.spec.ts`
- main/IPC window isolation:`src/__tests__/terminal-window-isolation/`
- renderer store mirror:`src/__tests__/terminal-store/`
