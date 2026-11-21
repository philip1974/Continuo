# plugin-mcp-invoke-bridge(反向调用路由)

行为契约:**`startPluginMcpInvokeBridge(registry)` 订阅 preload 的 `pluginMcp.onInvoke`,
根据 payload 把 invoke 派发到本 renderer 的 PluginMcpRegistry.invokeLocal,把结果或错通过
`replyInvoke` 单向发回 main。无 preload 注入(测试 / 主进程之外)→ noop unsub。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/plugin-mcp-invoke-bridge.ts` | bridge 启动 |
| `src/plugins/registries/PluginMcpRegistry.ts` | renderer 端 tool registry |
| `electron/shared/plugin-mcp-channels.ts` | InvokePayload / InvokeReply 类型 |

## 关键行为

### 注入存在

- 调一次 `onInvoke(cb)`,记下 unsub
- 收到 payload → `registry.invokeLocal(name, input)`
  - 成功 → `replyInvoke({ requestId, ok: true, result })`
  - 抛 Error 带 code/message 字串 → 透传 code,否则 fallback 'UNKNOWN' / 'unknown error'
- 返回的 `() => unsub` 调用即解订阅

### 无 preload(`__lmApi.pluginMcp` undefined)

- 直接返回 noop,什么都不订阅
