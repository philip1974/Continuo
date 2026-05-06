# Plugin → MCP Bridge 设计记录

> 把 plugin 暴露的工具注册到 MCP host,让 Agent / Claude Code 等 MCP client
> 通过 JSON-RPC `tools/list` + `tools/call` 调用 plugin 的代码。
>
> 完成于 2026-05-06。承接 [doc/17-agent-terminal-mcp.md](./17-agent-terminal-mcp.md) §R5
> "MCP host 暂时不做成 plugin... Phase 4 完成后再看是否抽出 plugin contribution
> point" 的延后决策。

## 1. 起因

Continuo 此前所有 MCP tool(7 个 terminal.* 工具)硬编码注册在 `electron/main/index.ts`
启动时。Plugin 系统(`src/plugins/`)与 MCP host 是**两个独立轨道**:plugin 跑在
renderer,MCP host 跑在 main,plugin 无法把工具暴露给 Agent。

需求:支持 plugin 通过 `app.mcp.register(spec)` 注册自定义工具,Agent 通过
MCP 协议看见并调用。

## 2. 关键架构事实

| 模块 | 进程 | 文件 |
|---|---|---|
| Plugin 系统 | **renderer** | `src/main.tsx:62` `new PluginManager(coApp, ...)` |
| MCP host | **main** | `electron/main/index.ts` `startMcpHost()`,绑 127.0.0.1 |

**这意味着 `app.mcp.register(spec)` 不是"加个字段"那么简单**:
工具的 `run(input)` 闭包跨不了进程,必须分两层处理。

## 3. 双层架构

```
┌── renderer ─────────────────────────────────────────────────┐
│                                                              │
│  Plugin                                                      │
│   └─ this.registerMcpTool(spec)                              │
│       └─ app.mcp.register(spec)         (per-plugin scope)   │
│           └─ ensurePerm('mcp-tools')                         │
│               └─ PluginMcpRegistry.register(spec, pluginId)  │
│                   ├─ 留 spec.run + spec.inputSchema 闭包     │
│                   └─ upstream.register(payload)              │
│                       │                                      │
└───────────────────────│──────────────────────────────────────┘
                        │ IPC: plugin-mcp:register
                        ▼
┌── main ────────────────────────────────────────────────────┐
│                                                             │
│  PluginMcpBridge.handleRegister(wcId, payload)              │
│   └─ host.registerTool(stub)                                │
│       └─ stub.run(input) = invokeRemote.invoke(owner, ...) │
│                            │                                │
└────────────────────────────│────────────────────────────────┘
                             │ webContents.send: plugin-mcp:invoke
                             ▼
┌── renderer ────────────────────────────────────────────────┐
│  preload.pluginMcp.onInvoke(payload)                        │
│   └─ registry.invokeLocal(name, input)                      │
│       ├─ spec.inputSchema.safeParse(input)                  │
│       └─ spec.run(parsed)  → result | throw                 │
│           └─ replyInvoke({ ok:true, result })               │
│              或 replyInvoke({ ok:false, code, message })    │
└────────────────────────────────────────────────────────────┘
                             │ ipcRenderer.send: plugin-mcp:invoke-reply
                             ▼
                main: invokeRemote.handleReply
                  → resolve / reject stub.run promise
                    → host dispatchRpc 包成 MCP 协议 result/error
                      → MCP client(Claude Code 等)收到响应
```

## 4. 模块清单

| 文件 | 角色 |
|---|---|
| `electron/shared/plugin-mcp-channels.ts` | 4 个 channel 名 + 4 套 zod payload schema + 7 个 error code |
| `src/plugins/registries/PluginMcpRegistry.ts` | renderer 侧本地表 + 上行 IPC 适配 + invokeLocal 派发 |
| `src/plugins/plugin-mcp-upstream.ts` | 生产 IPC upstream 实装(走 preload.pluginMcp) |
| `src/plugins/plugin-mcp-invoke-bridge.ts` | renderer 启动时订阅 onInvoke → registry.invokeLocal → replyInvoke |
| `src/plugins/co-app.ts` | 全局 PluginMcpRegistry 单例,注入 IPC upstream |
| `src/plugins/scoped-app.ts` | per-plugin `mcp.register` 闭包(检 'mcp-tools' 权限) |
| `src/plugins/Plugin.ts` | `protected async registerMcpTool(spec)` proxy(自动入 disposables) |
| `src/plugins/permissions.ts` | 加 `'mcp-tools'` PermissionKey |
| `src/plugins/permissions/PermissionPrompt.tsx` | 用户面文案 |
| `src/plugins/permissions/PermissionEditorModal.tsx` | 用户面文案 |
| `electron/main/services/plugin-mcp-bridge.service.ts` | createStubTool / createInvokeRemote / createPluginMcpBridge |
| `electron/main/services/mcp-host.service.ts` | 加 `removeTool(name)` API |
| `electron/main/ipc/plugin-mcp.ipc.ts` | ipcMain handle / on 接线 + wc destroyed hook |
| `electron/main/index.ts` | startMcpHost 后调 `startPluginMcpIpc(mcpHost)` |
| `electron/preload/index.ts` | `pluginMcp.registerTool / unregisterTool / onInvoke / replyInvoke` |
| `src/main.tsx` | 启动时调 `startPluginMcpInvokeBridge(getPluginMcpRegistry())` |

## 5. 关键设计决策

### 5.1 多窗口冲突策略 — 方案 A(先到先得)

**用户决策(2026-05-06):**
- 同名 tool 第二个 wc 注册抛 `TOOL_NAME_TAKEN`
- 不做 round-robin / 不做 per-wc 命名空间
- Plugin 作者要多窗口共存自己用 `localStorage` 做 leader election

理由:Continuo 已有 popout 多窗口(`src/__tests__/popout-contracts/`),
直接做多窗口比"单窗口先做后改"省 200 行 spec 改动 + 避免协议级 breaking change。
方案 A 是三个候选(A 先到先得 / B 全局去重多候选 / C 自动前缀)中最简的。

### 5.2 inputSchema 校验放 renderer

`createStubTool` 给 main host 注册的 stub `inputSchema = z.unknown()`,
不做 zod 校验。校验 100% 留 renderer 端 `PluginMcpRegistry.invokeLocal`
里 `spec.inputSchema.safeParse`。

理由:
- zod schema 跨不了 IPC(函数序列化问题)
- plugin 自定义 schema,main 没必要重复一次
- 校验失败的错误码 `INVALID_PARAMS` 透过 reply 传回 main → MCP error 透传给 client

### 5.3 invokeLocal 30s 默认超时

main 端 `createInvokeRemote` 默认 timeoutMs=30000,超过 reject `INVOKE_TIMEOUT`。

理由:MCP client(Claude Code 等)通常 60s 超时,plugin tool 单次执行
30s 已经偏长。e2e spec 测了 100ms 超时路径。

### 5.4 wc destroyed → 自动反注册

`electron/main/ipc/plugin-mcp.ipc.ts` 在 register 时 `wc.once('destroyed', ...)`
hook 调 `bridge.handleWebContentsGone(wcId)`:
- 摘掉所有 owner=该 wc 的 stub(从 host.tools 删)
- abort 所有 owner=该 wc 的 pending invoke(reject `PLUGIN_GONE`)

防止"窗口崩溃后 stub 仍在 host,Agent 调它无限等"。

### 5.5 'mcp-tools' 是新声明式 PermissionKey

加到 `PERMISSION_KEYS`,manifest 可声明 `permissions: ['mcp-tools']`。
首次启用走现有 `ensureAuthorized` 流程弹 PermissionPrompt。
未授 / 已 deny → `app.mcp.register(spec)` 抛 `PermissionError('mcp-tools')`。

权限分量:plugin 注册 MCP 工具 = 把 plugin 代码暴露给 Agent 直接触发。
比 panel/command 风险高(panel 用户主动点;MCP 工具 Agent 自己挑),
故必须显式声明 + 用户授权。

### 5.6 CoApp.mcp(单例 registry) ≠ CoPluginApp.mcp(per-plugin 闭包)

类型差异:
- `CoApp.mcp: PluginMcpRegistry`(register(spec, pluginId))
- `CoPluginApp.mcp: PluginMcpApi`(register(spec),pluginId 已闭包绑定)

因此 `CoPluginApp extends Omit<CoApp, 'mcp'>` 而非简单 `extends CoApp`。
这在测试夹具里要小心:
- PluginManager 需要 `CoApp` → 用 `createTestCoApp()`
- Plugin 需要 `CoPluginApp` → 用 `createTestApp()`

## 6. BDD 主题清单(共 7 个 + 1 个 e2e 集成)

```
src/__tests__/
  plugin-mcp-registry/        (renderer 侧 PluginMcpRegistry 行为契约)
  plugin-mcp-ipc-bridge/      (channel 名 + payload schema)
  plugin-mcp-stub-tool/       (main 侧 createStubTool / createInvokeRemote)
  plugin-mcp-lifecycle/       (Plugin.registerMcpTool proxy + Disposable LIFO)
  plugin-mcp-permission/      ('mcp-tools' 权限门 + per-plugin 隔离)
  plugin-mcp-multi-window/    (多 wc 注册并存 / 路由 / wc destroyed)
  plugin-mcp-e2e/             (renderer ↔ in-memory IPC ↔ main bridge ↔ 真 createMcpHost HTTP)
```

实装完成时全部绿(实装顺序见 §7),整个 BDD 套件 1194 tests / 83 files passed。

## 7. 实装顺序(已完成)

1. `electron/shared/plugin-mcp-channels.ts`
2. `src/plugins/registries/PluginMcpRegistry.ts`
3. `src/plugins/permissions.ts` + manifest 加 'mcp-tools'(manifest schema 复用 PERMISSION_KEYS,自动支持)
4. `src/plugins/types.ts` + `scoped-app.ts` + `test-utils.ts` 加 mcp 字段
5. `src/plugins/Plugin.ts` 加 registerMcpTool proxy
6. `electron/main/services/plugin-mcp-bridge.service.ts`
7. `electron/main/services/mcp-host.service.ts` 加 `removeTool`
8. 真 IPC 接线:preload + plugin-mcp.ipc + main.tsx + plugin-mcp-upstream + plugin-mcp-invoke-bridge

## 8. 已知技术债

### 8.1 Plugin._activate 失败时 stub 泄漏

如果 onload 内 `await registerMcpTool('a')` 成功后 `await registerMcpTool('b')`
抛错,PluginManager 当前不会调 `_deactivate` 清理(因为 status='failed' 而非
'enabled')。a 的 stub 会留在 main host 里直到 wc destroyed。

优先级:低。`plugin-mcp-lifecycle` README 钉了现状,等 plugin-base 改"_activate
失败也清理"时一并解决。

### 8.2 e2e spec 用反射拿 host.tools Map

`src/__tests__/plugin-mcp-e2e/e2e.spec.ts` 在 setupHarness 里把 `host.tools`
强转 `Map<...>` 用于 removeTool 兜底。host.removeTool 现已实装,可改 e2e
fixture 直接调 `host.removeTool`。改动小,放后续清理。

### 8.3 多 wc 同 plugin 并存策略

方案 A 决定:第二个 wc 重名抛错。Plugin 作者目前没有内置帮手做 leader
election;若未来 plugin 生态需求强烈,可以加 `app.mcp.tryRegister(spec)`
返 `null` 而非抛错的形态,plugin 作者主动判定。

## 9. 与 doc/17 的关系

doc/17 §R5 说:

> MCP host 暂时**不**做成 plugin —— 它是基础设施级,启动顺序在 plugin
> loader 之前。Phase 4 完成后再看是否抽出 plugin contribution point。

本设计**没有**把 MCP host 做成 plugin(host 仍是 main 进程基础设施)。但
**反向暴露了 plugin → host 的注册通道**,实现了"plugin 给 host 加工具"的
能力。doc/17 §R5 的延后决策仍有效:host 本身的生命周期不归 plugin 管,
plugin 不能关掉 host 或改它的端口/token。
