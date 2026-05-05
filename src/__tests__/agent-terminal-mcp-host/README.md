# agent-terminal-mcp-host (Agent Terminal MCP Phase 1)

行为契约:**main process 内置 MCP host 的契约层**:token 生成 / Bearer 校验 /
JSON-RPC 2.0 收发解析 / bind 地址白名单。HTTP / SSE 真行为(socket 监听 / SSE 推送)
留 E2E 验证;本主题只测**纯函数层**——可在 node 环境直接跑、不起真端口。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §4

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/mcp-host.service.ts` | HTTP SSE server + token 管理 + RPC 编解码 |

需 export 的纯函数(供本主题断言):

| 名字 | 签名 | 描述 |
|---|---|---|
| `generateToken()` | `() => string` | 启动 / rotate 时生成 |
| `verifyBearer(authHeader, expected)` | `(string \| undefined, string) => boolean` | 校验 `Authorization` |
| `parseRpcMessage(raw)` | `(unknown) => RpcRequest \| null` | JSON-RPC 2.0 输入校验 |
| `formatRpcResult(id, result)` | `(id, unknown) => string` | 编码响应(返回 JSON 字符串) |
| `formatRpcError(id, code, message, data?)` | `(id, number, string, unknown?) => string` | 编码错误 |
| `isLocalhostBindAddr(addr)` | `(string) => boolean` | 启动前 host 地址白名单 |

`createMcpHost(deps?)` 工厂(包 HTTP 实例)**不**在本主题测,留 E2E。

## 关键行为

### generateToken

- 返回 string,长度 ≥ 32 字符
- 字符集 URL-safe(无 `/`,`+`,`=`),便于直接放 `Authorization` header
- 多次调返回值两两不同(熵充足,32 次抽样断言)

### verifyBearer

- header 形如 `Bearer <token>`,大小写不敏感(`bearer xxx` / `BEARER xxx` 通过)
- token 与 expected 完全相等 → true
- header 缺失 / 不是 Bearer scheme / 没空格分隔 / token 不匹配 → false
- token 比对走**常量时间**(防 timing attack);本主题不直接测时序,只断 `crypto.timingSafeEqual` 被调一次(注入桩)
- expected 为空 / 假值 → 一律 false(防 token 未初始化时被绕过)

### parseRpcMessage

输入:`unknown`(未信任来源)。返回:
- `null` — 任何不满足 JSON-RPC 2.0 必字段的输入
- `{ id, method, params }` — 合法

合法 = 全部满足:
- 是非 null object(数组也拒)
- `jsonrpc === '2.0'` 严格相等
- `id` 是 string / number(JSON-RPC 允许 null,但本 host 拒——简化重传逻辑)
- `method` 是非空 string
- `params` 缺省 → 默认 `{}`;存在 → 必须是 object(数组也拒,本 host 一律 named params)

非法案例(全返 null):
- `null` / `undefined` / 字符串 / 数字 / 数组
- `{ jsonrpc: '1.0', ... }`
- `{ jsonrpc: '2.0', method: '' }`(空 method)
- `{ jsonrpc: '2.0', method: 'x' }`(缺 id)
- `{ jsonrpc: '2.0', id: 1, method: 'x', params: [] }`(数组 params)

### formatRpcResult / formatRpcError

- 都返回单行 JSON 字符串(SSE 后续追 `\n` 即可发)
- result 形:`{ jsonrpc: '2.0', id, result }`
- error 形:`{ jsonrpc: '2.0', id, error: { code, message, data? } }`
- `id` 透传输入(包括 number / string)
- `data` 缺省时不出现在 error 对象里(JSON 体不带 `data: undefined` 字面)

### isLocalhostBindAddr

仅以下三个返回 true:`127.0.0.1`、`::1`、`localhost`(string,小写)。
其它一律 false——含 `0.0.0.0`、`::`、任何外网地址。
启动 host 时调,非白名单值 → 抛 `MCP_HOST_BIND_FORBIDDEN`(本主题不测抛错,留实装侧)。

## 错误码契约

| code | 数字 | 何时 |
|---|---|---|
| `PARSE_ERROR` | -32700 | parseRpcMessage 返 null 时 host 回这个 |
| `METHOD_NOT_FOUND` | -32601 | 路由没注册的 method |
| `INVALID_PARAMS` | -32602 | tool schema 校验失败(留 list-sessions topic 测) |
| `UNAUTHORIZED` | -32001 | Bearer 校验失败(自定义,JSON-RPC 实现保留区) |

本主题只断`formatRpcError(id, -32700, ...)` 的字面 JSON 形态,不端到端测路由。

## 不在本主题验证

- HTTP server 真启动 / 端口绑定 / SSE chunked 编码 — 留 E2E
- `createMcpHost` 工厂的 lifecycle(close / rotate) — 留 E2E
- 授权 UI 弹窗 — `agent-terminal-mcp-auth` topic(P2)
- tool 路由分发 — 各 tool 自己的 topic
