# agent-terminal-mcp-dispatcher (Agent Terminal MCP Phase 4+)

行为契约:**MCP 标准协议层 dispatcher**。把 MCP 客户端发来的标准 method
(`initialize` / `tools/list` / `tools/call`)路由到内部 tool 调用,让真
MCP client(Claude Code、Inspector 等)能直接接入 Continuo。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §4
> 设计来源:MCP 协议规范 — 客户端启动后发 initialize → tools/list → tools/call。
> 我们 P1 的"method 即 tool name"形态被废弃,改走标准 dispatch。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/mcp-host.service.ts` | `dispatchRpc(rpc, tools, serverInfo) → RpcResponseObj` 纯函数 |

需 export:

| 名字 | 签名 | 描述 |
|---|---|---|
| `dispatchRpc(rpc, tools, serverInfo)` | `(RpcRequest, Map<string, AnyMcpTool>, ServerInfo) => Promise<RpcResponseObj>` | 路由 + 调用 tool + 包装结果 |

```ts
type RpcResponseObj =
  | { readonly result: unknown }
  | { readonly error: { code: number; message: string; data?: unknown } };

interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly protocolVersion: string;  // MCP 协议版本,如 '2024-11-05'
}
```

`AnyMcpTool` 接口(在 P4+ 扩展)新增字段:
```ts
interface McpToolDef<I, O> {
  readonly name: string;
  readonly description: string;          // 新增,给 LLM 看
  readonly jsonSchema: Record<string, unknown>;  // 新增,给 MCP client tools/list 看
  readonly inputSchema: z.ZodType<I>;
  readonly run: (input: I) => O | Promise<O>;
}
```

## 关键行为

### `initialize`

`rpc.method === 'initialize'` → 返回 `{result: {protocolVersion, serverInfo, capabilities}}`:

```ts
{
  result: {
    protocolVersion: serverInfo.protocolVersion,
    serverInfo: { name: serverInfo.name, version: serverInfo.version },
    capabilities: { tools: {} }
  }
}
```

不验证 client 发来的 protocolVersion / clientInfo(简化,接受任意客户端)。

### `tools/list`

`rpc.method === 'tools/list'` → 返回 `{result: {tools: [...]}}`:

每个 tool 转成:
```ts
{
  name: tool.name,
  description: tool.description,
  inputSchema: tool.jsonSchema,  // JSON Schema(不是 zod)
}
```

数组顺序按 Map 插入顺序。

### `tools/call`

`rpc.method === 'tools/call'`,params 形:`{name: string, arguments?: object}`。

行为:
1. params.name 不是 string / 缺失 → INVALID_PARAMS(-32602)
2. tools 中查不到 name → METHOD_NOT_FOUND(-32601),message `tool not found: <name>`
3. arguments 缺省 → 当 `{}`
4. arguments 不是 plain object → INVALID_PARAMS
5. tool.inputSchema.safeParse(args) 失败 → INVALID_PARAMS,message 是 issues 拼接
6. tool.run(args) throw → INTERNAL_ERROR(-32603),message 取 err.message,data 含原 code(若有)
7. tool.run 成功 → 包装为 MCP content array:
   ```ts
   { result: { content: [{ type: 'text', text: JSON.stringify(toolResult) }] } }
   ```

### 未知 method

任何不在 `initialize` / `tools/list` / `tools/call` 里的 method → METHOD_NOT_FOUND(-32601),message `method not found: <method>`。

注:旧的"method 即 tool name"形态(如直接发 `terminal.list_sessions`)在标准 dispatcher 下走 default 分支返回 METHOD_NOT_FOUND。客户端必须用 `tools/call` 包装。

### Notifications(rpc 没 id)

本主题**不**处理 notification — 因为 dispatcher 入口是 RpcRequest(已经有 id)。
notification 在 HTTP handler 层提前拦截(204 No Content),不进 dispatcher。

## 错误码契约

| 场景 | code |
|---|---|
| 未知 method | -32601 (METHOD_NOT_FOUND) |
| `tools/call` 找不到 tool | -32601 |
| params.name 非 string / 缺失 | -32602 (INVALID_PARAMS) |
| arguments 不是 object | -32602 |
| inputSchema 校验失败 | -32602 |
| tool.run 抛(非协议错)| -32603 (INTERNAL),data 含原 code |

## 不在本主题验证

- HTTP 路由 / `/mcp` endpoint / SSE 占位 — 留 E2E
- notifications 路径 — HTTP 层独立处理
- 各 tool 的 description / jsonSchema 字面值 — 工厂内部常量,目测
- zod ↔ JSON Schema 一致性 — 手写,目测
