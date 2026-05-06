# plugin-mcp-stub-tool (Plugin → MCP Bridge · main 侧 stub)

行为契约:**main process 侧 PluginMcpBridge 的纯函数层**。

两块内容:
1. `createStubTool(spec, owner, deps)` —— 把 plugin 上送的元数据包成 `McpToolDef`,
   注册给 `mcp-host`,其 `run(input)` 走反向 IPC 调 owner wc 的 plugin
2. `createInvokeRemote(deps)` —— 反向调用核心:发 IPC + 维护 pending map +
   超时控制 + reply 路由

> 配套:[doc/19-plugin-mcp-bridge.md](../../../doc/19-plugin-mcp-bridge.md) §main 侧
>
> HTTP wiring / 真 webContents.send / host.registerTool 接线 留 `plugin-mcp-e2e` 做集成。
> 多 wc 注册并存 / 路由 / wc destroyed 反注册 由 `plugin-mcp-multi-window` 持有。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/plugin-mcp-bridge.service.ts` | createStubTool / createInvokeRemote 等纯函数 export |

需 export 的形态(供本主题断言):

```ts
export interface PluginMcpToolOwner {
  readonly pluginId: string;
  readonly wcId: number;
}

export interface PluginMcpRegistrationSpec {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Record<string, unknown>;
}

export type InvokeRemoteFn = (
  owner: PluginMcpToolOwner,
  name: string,
  input: unknown,
) => Promise<unknown>;

export interface CreateInvokeRemoteDeps {
  /** 真生产注入 webContents.send;测试注入 spy. */
  send(owner: PluginMcpToolOwner, channel: string, payload: unknown): void;
  /** 默认 30000ms,超时 reject INVOKE_TIMEOUT. */
  timeoutMs?: number;
  /** 注入用于伪造时钟(测试)/真 setTimeout(生产). */
  setTimer?(fn: () => void, ms: number): { cancel(): void };
  /** 注入 requestId 生成器(测试断 deterministic / 生产用 nanoid). */
  newRequestId?(): string;
}

export interface InvokeRemoteCore {
  invoke: InvokeRemoteFn;
  /** 收到 renderer 答复时调,依 requestId 路由到 pending map 的 resolve/reject. */
  handleReply(reply: unknown): void;
  /** 当某 wc 不可达(destroyed)→ pending 中所有 owner=wc 的 reject PLUGIN_GONE. */
  abortByWebContents(wcId: number): void;
  /** 当前 pending 数量,供测试断言. */
  pendingCount(): number;
}

export function createInvokeRemote(deps: CreateInvokeRemoteDeps): InvokeRemoteCore;

export function createStubTool(
  spec: PluginMcpRegistrationSpec,
  owner: PluginMcpToolOwner,
  invoke: InvokeRemoteFn,
): AnyMcpTool; // mcp-host.service 已 export AnyMcpTool
```

## 关键行为

### createStubTool

- 返回的 `McpToolDef` 字段:
  - `name` / `description` / `jsonSchema` 透传 spec
  - `inputSchema` = `z.unknown()`(main 不再 zod 校验,renderer 的 plugin 自己校;
    防止 main 端 zod 与 plugin 期望偏差)
- `run(input)` 调 `invoke(owner, spec.name, input)`,resolve 其返回值,reject 透传错(原对象,带 code 也带过去)
- run 不修改 input(原样转发)

### createInvokeRemote · 发送一次 invoke

- `invoke(owner, name, input)` 调 deps.send 一次,channel = `PLUGIN_MCP_CHANNELS.INVOKE`,
  payload 含 `{ requestId, name, input }`
- requestId 由 deps.newRequestId() 取(默认 nano-id 风格;测试可注入 deterministic)
- 同时把 `{owner, resolve, reject, timer}` 入 pending map(key=requestId)
- 默认 timer 在 deps.timeoutMs(默认 30000)后触发,reject `PLUGIN_MCP_ERROR_CODES.INVOKE_TIMEOUT`
  并把 entry 从 pending 摘掉

### handleReply

- 收 zod 校验过的 reply(由 bridge 上层校,本函数假设结构正确)
- 据 requestId 找 pending entry:
  - 不存在(已超时或已处理)→ 静默忽略,不 throw(否则 stale reply 会炸 main)
  - 存在 → cancel timer,从 pending 摘,然后:
    - ok=true → resolve(result)
    - ok=false → reject(Error with code/message)

### abortByWebContents(wcId)

- 遍历 pending,所有 owner.wcId === 输入 wcId 的:
  - reject `PLUGIN_GONE`(message 含 wcId 便于诊断)
  - cancel timer
  - 从 pending 摘
- pending 中其他 wc 的请求不动

### 并发隔离

- 多个 invoke 并发(同 owner / 不同 owner),pending map 按 requestId 隔离
- 任一 reply / 超时 / abort 只影响对应 entry,其它继续等

### Stub.run 与 invoke 的错误透传

- invoke reject `INVOKE_TIMEOUT` → stub.run reject 同(同一对象)
- invoke reject `PLUGIN_GONE` → stub.run reject 同
- invoke reject `NO_SUCH_TOOL`(renderer 上送的 ok=false reply 触发)→ stub.run reject 同

## 不在本主题验证

- 真 webContents.send 是否到达(由 e2e topic 持有;本主题 send 是注入 spy)
- 真 host.registerTool 接线(由 e2e + multi-window 持有)
- IPC payload 反序列化失败(由 ipc-bridge schema topic 持有)
- 注册并存逻辑、wc destroyed 触发 abortByWebContents 的接线(由 multi-window 持有)
