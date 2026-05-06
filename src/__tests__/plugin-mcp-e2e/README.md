# plugin-mcp-e2e (Plugin → MCP Bridge · 端到端集成)

行为契约:**整条链路在内存中通**:
- renderer 侧 PluginMcpRegistry(真实实例)
- ↕️ in-memory IPC 替身(模拟 ipcMain.handle / ipcRenderer.invoke + ipcMain.send / on)
- main 侧 PluginMcpBridge(真实实例)
- ↕️ 真 createMcpHost(HTTP server,绑 127.0.0.1:0)
- 真 fetch 发 JSON-RPC

> 配套:[doc/19-plugin-mcp-bridge.md](../../../doc/19-plugin-mcp-bridge.md) §端到端
>
> 与既有 `agent-terminal-mcp-host` topic 的"留 E2E"决策不同:本 topic 是 **bridge
> 集成 + HTTP**,因为这条链路才真正回答"plugin 注册的 tool 能否被 MCP client 看到
> 并调通"。Stdio transport / authorization / 多 client 并发 留**真 E2E 二阶段**(暂无 spec)。

## 模块

不引入新 module。组合既有:
- `src/plugins/registries/PluginMcpRegistry.ts`(本 BDD 套件 §registry topic 实装)
- `electron/main/services/plugin-mcp-bridge.service.ts`(§stub-tool / §multi-window topic 实装)
- `electron/main/services/mcp-host.service.ts`(已存在,需扩 `removeTool` API)
- `electron/shared/plugin-mcp-channels.ts`(§ipc-bridge topic 实装)

测试自带一个内存 IPC 桥(spec 内 fixture),把 renderer ↔ main 两边接起来。

## 关键场景

### 场景 1:成功注册后 MCP client 看得到

1. 起真 createMcpHost(127.0.0.1:0)
2. 起真 PluginMcpBridge(注入 host)
3. 起真 PluginMcpRegistry(注入"in-memory upstream",由 spec fixture 把 register
   payload 转发给 bridge.handleRegister)
4. 调 registry.register({name:'hello.world', ...}) → resolve Disposable
5. 用 fetch + Bearer 调 host.url 的 JSON-RPC `tools/list`
6. 断:返回的 tools 数组**包含** `hello.world`,且字段 name/description/inputSchema
   与 plugin 上送一致
7. 调 `tools/call` `hello.world` { who: 'mcp' }:
   - bridge stub.run → invokeRemote.invoke → in-memory IPC 转发到 registry.invokeLocal
   - registry 校 input → 调 spec.run → 返 `{ greet: 'hello mcp' }`
   - main 收 reply → resolve stub.run → host 包成 tool result
8. 断:HTTP 响应 `result.content[0].text` JSON 解析 = `{ greet: 'hello mcp' }`

### 场景 2:Disposable.dispose 后 MCP client 看不到

1. 同场景 1 步 1-4 注册 `hello.world`
2. 调 Disposable.dispose
3. fetch tools/list → tools 数组**不**含 `hello.world`
4. fetch tools/call `hello.world` → JSON-RPC error,code = -32601 method not found
   (即 dispatchRpc 已有 "tool not found" 错误码)

### 场景 3:tool.run 抛错 → JSON-RPC 错误透传

1. 注册 `boom` tool,run 抛 `Error('biz fail')`(可带 code='BIZ')
2. fetch tools/call `boom` → JSON-RPC error
3. 断:error.message === 'biz fail';如有 code,error.data.code === 'BIZ'
   (与 dispatchRpc 现有错误透传契约一致)

### 场景 4:plugin.disable 后再 MCP client 调 → method not found

> 本场景体现"plugin 生命周期 → MCP host 接受度"的端到端因果关系,
> 但 plugin 真 disable 流程涉 PluginManager,本 spec 直接调 Disposable.dispose
> 模拟(plugin-mcp-lifecycle topic 已断 _deactivate → dispose)

1. 注册 'a','b','c' 三个 tool
2. dispose 'b'
3. fetch tools/list → 含 'a' 'c' 不含 'b'
4. fetch tools/call 'b' → method not found

### 场景 5:超时

1. 注册 `slow` tool(run 永不 resolve)
2. bridge 注入 timeoutMs=100(测试用)
3. fetch tools/call `slow`(应在 100ms 后 reject)
4. 断:JSON-RPC error,error.data.code === `INVOKE_TIMEOUT`

## 不在本主题验证

- 真 ipcMain / ipcRenderer / webContents.send(spec 用内存桥替代)
- Stdio transport 路径(由 `agent-terminal-mcp-stdio-framing` 持有)
- Bearer 鉴权(已由 `agent-terminal-mcp-host` 持有)
- 多 wc 并发注册同名(已由 `plugin-mcp-multi-window` 持有)
- 跨进程序列化失败(由 IPC 真 E2E,二阶段)
