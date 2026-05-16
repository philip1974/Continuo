# 26 — window-workspace-roots-map：BDD 契约 + 4 个收尾决策（架构决策）

> 类型：架构决策 / BDD 契约固化 / 错误传播模型
> 日期：2026-05-16
> 状态：已落地（topic-12）
> 关联：topic-10（terminal-session-ownership-leak，ingress 侧 sibling）；topic-08（dock-layout-per-window-seq，windowSeq 基础）；future topic seeds 见末尾

## 决策

**给 `window-workspace-roots.service.ts`（26 行 main 端 windowId→workspaceRoot 查找表）固化 BDD 契约，同时收口 4 个相关质量决策：**

1. **`resolveTerminalCwd` 不再静默兜底**：cwd hint 缺失或无效时 throw `TERMINAL_CWD_UNRESOLVED`，禁止默默 fallback 到 `os.homedir()`。
2. **`normalizeWorkspaceRoot` 不破坏路径数据**：空串/全空白/非字符串 → null；其他原样返回（不 trim），文件系统允许 `/tmp/proj ` 这种带空格的合法路径。
3. **renderer alert 是临时方案**：`TerminalPlugin` Cmd+T 与 `HeaderActions` + 菜单触发的 terminal 创建失败时弹 native alert，沿用 `FolderTree.tsx` 现有模式；待未来 `design-system-toast` topic 三处统一升级。
4. **MCP 错误传播分三层 spec**：direct call / IPC envelope (`processIpcCall`) / MCP envelope (`dispatchRpc` JSON-RPC) 各自有 spec，`mcp-host.service.ts:284-295` 已存在的 `error.data.code` 透传通过 T26 assert-existing 加 regression guard，不重复实装。

## 上下文

`topic-10 terminal-session-ownership-leak` 完成了 egress 侧（main 端 IPC list / read_history 跨窗块），但 ingress 侧——`workspaceRoot` 的来源链 + cwd fallback 的 silent vs error 行为——一直没有 BDD 契约保护。本机审计发现：

- `electron/main/services/window-workspace-roots.service.ts` 是 main 端 `windowId → workspaceRoot` 的查找表，被 `terminal.ipc.ts:172-173` 用作 MCP agent `terminal_create_session` 无 cwd 入参时的回退源；renderer 通过 `window:notify-root` IPC 推 root 变化时调 `setWorkspaceRoot`；`win.on('closed')` 触发 `clearWindow` 防泄漏。
- 但 `resolveTerminalCwd` 在 cwd 解析失败时**默默** `return os.homedir()`，把"应该报错"的边缘场景变成了"打开 home"的隐性 UX。
- 设计系统约束（`@nous/shell-ui/design` 共享层）和 `explorer.json` schema（topic-08 地盘）都不能动。

定性为**主进程入参链信任边界 + 错误语义清晰度**问题。

## 取舍

### 决策 1：`resolveTerminalCwd` throw vs silent fallback

红队 round 1 提出三个候选（U1）：

| 方案 | 行为 | 评估 |
|---|---|---|
| (a) 一律 throw `TERMINAL_CWD_UNRESOLVED` ✓ | 缺 cwd hint / 无效 → throw | 安全契约清晰；renderer/MCP caller 自行 catch；attack surface 不增 |
| (b) 区分 MCP-agent vs user-Cmd+T | 仅 MCP 路径 throw | 需 IPC 入参塞 `originHint` 标 trust 边界；**renderer 可伪造**，攻击面增加 |
| (c) 全部 throw + caller 显式降级 | 仅当 input.cwd 与 input.workspaceRoot 都明确缺失且来源标 MCP 时报错 | 与 (b) 同源缺陷 |

选 **(a)**。renderer 已经在 `TerminalPlugin.ts:34-37` 显式传 `input.workspaceRoot`，所以 throw 路径**仅**命中"renderer 既没传 cwd 也没 notifyRoot"的真异常场景。Caller 按场景自行 catch + 反馈 UX。

### 决策 2：`normalizeWorkspaceRoot` 不 trim 返回值（P0-1 红队 v3 实证）

红队 round 3 P0-1 实证：plan-v3 写的 `normalizeWorkspaceRoot(path) => path.trim()` 会**静默改写路径**，`'/tmp/proj '` 和 `'/tmp/proj'` 在文件系统是不同路径，trim 是数据破坏。

修订为：
```ts
export function normalizeWorkspaceRoot(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  return path.trim().length === 0 ? null : path;  // 关键：返回原 path 而非 trimmed
}
```

T28b 是 regression guard：`expect(normalizeWorkspaceRoot('  /abs  ')).toBe('  /abs  ')`。

应用 4 处（议题 G 第 5 坑——helper 抽出后必须各处都用）：
- `src/stores/workspace.store.ts setRoot` —— 用户/UI 触发
- `src/lib/persist/explorer-persist.ts:170 hydrateStores` —— 磁盘 hydrate（**这条之前漏改是红队 round 2 P1-1 发现的**）
- `src/lib/persist/explorer-persist.ts hydrateStoresForNewWindow` —— 新窗 hydrate
- `src/lib/persist/explorer-persist.ts snapshotFromStores` —— 持久化前清洗 + recentRoots 过滤

main 侧 persistence migration（旧 `explorer.json` 含 `root: ''`）defer 到未来 topic `workspace-root-persist-migration`。

### 决策 3：alert vs design Modal（trade-off 留底）

设计系统 `src/design/` 有 `Modal` 没 `Toast`。理想 UX 应用 `Modal` 或 toast，但 command handler 不在 React 组件树（`TerminalPlugin.ts:31-42 fn` 是 zustand store + lazy import），引入 Modal 需要 portal + state lift，会超出 topic-12 scope。

取舍：沿用 `src/panels/Explorer/FolderTree.tsx` 已有的 `alert(...)` 模式，**三处一致**（`FolderTree` + `TerminalPlugin` + `HeaderActions`）。明示这是临时方案——未来 `design-system-toast` 或 `command-error-feedback-unified` topic 出来后**三处统一升级**。

### 决策 4：MCP 错误传播三层 spec + T26 assert-existing

红队 round 2 P0-1 + round 3 P1-1 实证：terminal cwd error 在 3 种 envelope 中各有不同传播路径，spec 不能只测一层。

| Layer | 路径 | 传播形态 | spec |
|---|---|---|---|
| 1. Direct call | `makeCreateHandler({resolveCwd: spy})` 单元 | Error 含 `.code='TERMINAL_CWD_UNRESOLVED'` throws | T12-T15 |
| 2. IPC envelope | `processIpcCall` → `safeHandle('terminal:create', ...)` | catch throw 转 `{ok:false, code:'TERMINAL_CWD_UNRESOLVED', message}` | T18 |
| 3. MCP envelope | `makeCreateSessionTool` → `dispatchRpc tools/call` | JSON-RPC `{error: {code:-32603, message, data: {code:'TERMINAL_CWD_UNRESOLVED'}}}` | T25 + T26 |

**关键**：T26 是 **assert-existing**——红队 round 3 实证 `mcp-host.service.ts:284-295` 已存在 `if (typeof e.code === 'string') errorObj.data = { code: e.code }`，**不需要改实装**，T26 只锁住这个行为防回归。plan 早期版本错误地说"需要新增 ~3 行 dispatchRpc 改动"，被 codex 红队驳回。

## 落地

### Op 列表与 affects_files（16 files）

```
6 created BDD:
  src/__tests__/window-workspace-roots-map/{README.md, service.spec.ts,
    notify-root-validation.spec.ts, cwd-fallback-error.spec.ts,
    renderer-fail-feedback.spec.ts, workspace-store-empty-string.spec.ts}

8 modified impl:
  electron/main/ipc/{window.ipc.ts, terminal.ipc.ts}
  src/core-plugins/TerminalPlugin.ts
  src/shell/dock/HeaderActions.tsx
  src/stores/workspace.store.ts
  src/lib/persist/explorer-persist.ts
  src/shell/App.tsx
  electron/preload/index.ts

1 modified 旧 spec:
  src/__tests__/terminal-ipc/terminal-ipc.spec.ts (用 makeHandlerWithDefaultCwd
    helper 包裹 7/12 处, 保留 5 处显式 cwd 断言用例)

1 auto:
  src/__tests__/INDEX.md (pnpm bdd:index 重生)
```

### 验证结果

- pnpm typecheck PASS
- pnpm test:unit 162 files / 1969 passed / 2 todo
- 13/13 safeguards held（含 `mcp-host.service.ts` 全程未改动 + `service.ts` 未改 + topic-10 egress filter 未碰 + 设计系统约束 0 违规）
- grep gate（限定 3 文件）：0 matches

## 不要再做的事

- 不要回退 `resolveTerminalCwd` 到 silent `os.homedir()` 兜底——破坏 Acceptance #3 的 cwd 信任契约。
- 不要在 `normalizeWorkspaceRoot` 里 trim 返回值——T28b 会变红，且会破坏含空格的合法路径。
- 不要为了"统一性"把 `mcp-host.service.ts:284-295` 的 `error.data.code` 透传重写——红队 round 3 实证它已正确，重写是无意义 churn。
- 不要在本 topic 边界外加 `design-system-toast` / Modal——alert 是 deliberate 临时方案，统一升级走 future topic。
- 不要把 `electron/shared/terminal-shells.ts:52` 的 `defaultHomedir: os.homedir` 当成 P0-2 grep gate 的违规——那是合法的默认 shell cwd 解析，与本 topic 删除的 silent fallback 是两回事。

## Future topic seeds（defer 留底）

- **`workspace-root-persist-migration`**（红队 round 3 P1-3 defer）：main 侧 `loadExplorer` / `pickWindowsToRestore` / `allocateWindowSeq` 仍可能把旧空串 `root: ''` 原样写回磁盘。renderer hydrate 时新 `normalizeWorkspaceRoot` 会过滤掉（危害可控），但持久化层有数据脏值。未来 topic 加 main persistence migration 闭合。
- **`design-system-toast`**（决策 3 trade-off 留底）：把 `FolderTree` / `TerminalPlugin` / `HeaderActions` 的 alert 三处统一升级到 design system 的 Toast / Modal，需要 portal + state lift 配套。
- **`gui-visual-debugger` 集成**（P0-3 + NEED-INFO-1 defer）：本 topic real_test = skipped 因当前 dev-loop verifier 无 manual skill 约定。未来安装 GUI 自动化工具后，按 plan-v4 末尾 "Manual verification steps" 段落跑实测。
- **`mcp-host.service.ts:284-295` 错误透传契约 BDD**（T26 触及但未单独 topic）：本 topic T26 是 assert-existing，未来若要保护得更全面，可拆出 `mcp-host-error-envelope` topic 独立钉死所有 tool error 的 JSON-RPC envelope shape。

## 流程经验（dev-loop 复盘）

- **3 轮 red-team 全 BLOCK 是正常的**：每轮的 BLOCK 不是方向错，而是细节级 bug——round 1 抓 IPC envelope 模型错；round 2 抓 path 错 + skill 未证；round 3 抓 trim 数据破坏 + grep gate 过宽。`manual_override + /dl-integrate` 一次吸收剩余细节是合理收尾路径，不要把 BLOCK 当方向错。
- **Op8 测试/typecheck 阶段的 retry 是 shallow self-fix**（typecheck 的"洋葱"剥层揭示新错），与 execute_retry 计数不冲突；议题 D.3 max 2 attempts 用得刚好。
- **codex 的 verdict 不可全信**：红队 round 2/3 的 P1-1（dispatchRpc 已存在 e.code 透传）是 codex 自己实读源码纠正了 Claude 的 plan-v3 误判——值得信赖独立审计的价值。
