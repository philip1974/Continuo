# plugin-mcp-ipc-bridge (Plugin → MCP Bridge · IPC 协议层)

行为契约:**renderer ↔ main 之间的 IPC 协议形态**。
4 个 channel 名 + 4 套 zod payload schema + 错误码常量。

> 配套:[doc/19-plugin-mcp-bridge.md](../../../doc/19-plugin-mcp-bridge.md) §IPC 协议
>
> 为什么单独成 topic:channel 名和 payload 字段是 main / renderer 双向 import 的"宽
> 边界",一旦 plugin 已发布就不能改;固化在 `electron/shared/`,与 mcp-terminal-schemas
> 同款做法。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/shared/plugin-mcp-channels.ts` | channel 名常量 + 4 套 payload zod schema + error codes |

需 export 的形态(供本主题断言):

```ts
export const PLUGIN_MCP_CHANNELS: {
  readonly REGISTER: 'plugin-mcp:register';
  readonly UNREGISTER: 'plugin-mcp:unregister';
  readonly INVOKE: 'plugin-mcp:invoke';            // main → renderer
  readonly INVOKE_REPLY: 'plugin-mcp:invoke-reply';// renderer → main
};

export const RegisterPayloadSchema: z.ZodType<{
  pluginId: string;
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}>;

export const UnregisterPayloadSchema: z.ZodType<{ name: string }>;

export const InvokePayloadSchema: z.ZodType<{
  requestId: string;
  name: string;
  input: unknown;
}>;

export const InvokeReplySchema: z.ZodType<
  | { requestId: string; ok: true; result: unknown }
  | { requestId: string; ok: false; code: string; message: string }
>;

export const PLUGIN_MCP_ERROR_CODES: {
  readonly TOOL_NAME_TAKEN: 'TOOL_NAME_TAKEN';
  readonly NO_SUCH_TOOL: 'NO_SUCH_TOOL';
  readonly INVALID_PARAMS: 'INVALID_PARAMS';
  readonly TOOL_DISPOSED: 'TOOL_DISPOSED';
  readonly INVOKE_TIMEOUT: 'INVOKE_TIMEOUT';
  readonly PLUGIN_GONE: 'PLUGIN_GONE';
  readonly PERMISSION_DENIED: 'PERMISSION_DENIED';
};
```

## 关键行为

### Channel 名常量

- 4 个字面字符串值不变(plugin 已发布则破坏兼容):
  - `plugin-mcp:register`
  - `plugin-mcp:unregister`
  - `plugin-mcp:invoke`
  - `plugin-mcp:invoke-reply`

### RegisterPayloadSchema

合法:
- `pluginId` 非空 string(plugin manifest.id)
- `name` 非空 string(全 MCP host 唯一,但 renderer 不验,留 main bridge)
- `description` string(可空字符串,只 warn 不 fail)
- `jsonSchema` 任意 object(`Record<string, unknown>`)

非法(safeParse.success === false):
- 缺任意必字段
- 字段类型错(name 是 number / jsonSchema 是 array)
- 多余字段(strict)

### UnregisterPayloadSchema

合法:`{ name: 非空 string }`
非法:`{}` / `{ name: '' }` / `{ name: 123 }` / `{ name: 'x', extra: 1 }`(strict)

### InvokePayloadSchema(main → renderer)

合法:
- `requestId` 非空 string(UUID 或 nano-id,本 schema 不强格式)
- `name` 非空 string
- `input` 任意值(包括 undefined / null / object / array / primitive)
  > 因为 plugin 自定义 inputSchema,bridge 层不预设 input 形状

非法:缺必字段 / requestId / name 类型错或为空 / 多余字段(strict)

### InvokeReplySchema(renderer → main)

discriminated union by `ok`:
- ok=true 分支:`{ requestId, ok: true, result: unknown }`(result 任意值)
- ok=false 分支:`{ requestId, ok: false, code: 非空 string, message: string }`

非法:
- `ok` 不是 boolean / 缺
- ok=true 缺 result(undefined 应被视为合法 result,但**字段必须存在**——zod 行为差异留实装决,此处只断:有 result 字段 ok 通过)
- ok=false 缺 code / message
- ok=true 同时含 code 字段(strict 拒)

### PLUGIN_MCP_ERROR_CODES

- 7 个 code 字符串值固定(给 plugin / 监控 / 测试断言用)
- 不允许动态变;新增 code 走 patch 版本

## 不在本主题验证

- 实际 IPC 传输(由 `plugin-mcp-stub-tool` 持有反向调用栈)
- 注册并存逻辑、wc destroyed 清理(由 `plugin-mcp-multi-window` 持有)
- 端到端协作(由 `plugin-mcp-e2e` 持有)
