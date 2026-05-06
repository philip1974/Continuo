# plugin-mcp-registry (Plugin → MCP Bridge · 模块层)

行为契约:**renderer 进程内 PluginMcpRegistry 的纯函数层**。负责
- 收 plugin 注册的 `PluginMcpToolSpec`(含本地 `run` 闭包)
- 走注入的 `PluginMcpUpstream` 上行 IPC 把元数据(name / description / jsonSchema)登记到 main host
- 留 `name → spec` 表,供 main 反向调用时本地 dispatch(input 用 spec.inputSchema 校验,再调 spec.run)

> 配套:[doc/19-plugin-mcp-bridge.md](../../../doc/19-plugin-mcp-bridge.md)
> 上下文:Plugin 跑在 renderer,MCP host 跑在 main(`doc/17` §R5);run 闭包跨不了进程,
> 因此分两层:registry(renderer)留 closure,bridge(main)给 host 注册一个反向调用 stub。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/registries/PluginMcpRegistry.ts` | renderer 侧本地登记表 + 上行 IPC 适配层 |

需 export 的形态(供本主题断言):

```ts
export interface PluginMcpToolSpec<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  /** 给 LLM/MCP client tools/list 看的 JSON Schema(plugin 手填字面量). */
  readonly jsonSchema: Record<string, unknown>;
  /** 本地校验 input 用的 zod schema. */
  readonly inputSchema: z.ZodType<I>;
  readonly run: (input: I) => O | Promise<O>;
}

export interface PluginMcpUpstreamRegisterPayload {
  readonly pluginId: string;
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: Record<string, unknown>;
}

export interface PluginMcpUpstream {
  register(p: PluginMcpUpstreamRegisterPayload): Promise<void>;
  unregister(name: string): Promise<void>;
}

export class PluginMcpRegistry {
  constructor(upstream: PluginMcpUpstream);
  register(spec: PluginMcpToolSpec, pluginId: string): Promise<Disposable>;
  invokeLocal(name: string, input: unknown): Promise<unknown>;
}

export const PLUGIN_MCP_ERROR_CODES: {
  readonly TOOL_NAME_TAKEN: 'TOOL_NAME_TAKEN';
  readonly NO_SUCH_TOOL: 'NO_SUCH_TOOL';
  readonly INVALID_PARAMS: 'INVALID_PARAMS';
  readonly TOOL_DISPOSED: 'TOOL_DISPOSED';
  // INVOKE_TIMEOUT / PLUGIN_GONE / PERMISSION_DENIED 由其他主题持有
};

export class PluginMcpError extends Error {
  readonly code: string;
}
```

## 关键行为

### register(spec, pluginId) — 成功路径

- 调 `upstream.register({pluginId, name, description, jsonSchema})` 一次,await 完成后
  把 spec 存入本地 `name → spec` 表
- resolve 一个 `Disposable`,`dispose()` 调 `upstream.unregister(name)` 一次并把本地表条目摘掉
- `Disposable.dispose` 多次调用幂等(只 unregister 一次)

### register — 同 renderer 内重名

- 在调 upstream.register **之前**就检本地表;已存 name → reject `PluginMcpError` with code `TOOL_NAME_TAKEN`
- **不**调 upstream.register 第二次(避免给 main 发垃圾请求)

### register — upstream 抛错

- upstream.register reject(任何错)→ register 也 reject(原错透传 message,如带 code 也透传)
- 本地表**不**登记此 name;允许稍后重试

> 跨 renderer / 跨 wc 的全局重名由 main 端 bridge 拦截,errback 后 upstream.register reject `TOOL_NAME_TAKEN`,
> 在本主题里相当于"upstream 抛错"路径,不区分。

### invokeLocal(name, input) — 派发本地 run

- 查本地表,name 不存在 → reject `PluginMcpError` with code `NO_SUCH_TOOL`
- spec.inputSchema.safeParse(input) 失败 → reject `PluginMcpError` with code `INVALID_PARAMS`,
  message 拼所有 zod issue.message(`; ` 分隔)
- 校验通过 → 调 spec.run(parsed),resolve 其返回值(支持 sync / async)
- spec.run 抛错 → reject 透传(原错对象);如带 code 则保留

### invokeLocal — dispose 后

- Disposable.dispose 后再 invokeLocal(name, ...) → reject `PluginMcpError` with code `NO_SUCH_TOOL`
  (因本地表已摘,与"从未注册"行为一致;不区分 TOOL_DISPOSED)

> `TOOL_DISPOSED` 错误码保留供未来"已 dispose 但 name 仍未被复用"场景用,
> 本主题暂不区分,只保证 dispose 后 invokeLocal 抛 `NO_SUCH_TOOL`。

### 多个 tool 共存

- 同一 registry 实例可注册任意数 tool(name 唯一即可)
- 各 tool 的 run 闭包互相独立;一个 tool 的 invokeLocal 抛错不影响另一个
- 一个 tool 的 dispose 不影响另一个的 invokeLocal

## 不在本主题验证

- 上行 IPC 真传输 / 序列化(由 `plugin-mcp-ipc-bridge` topic 持有 channel + payload schema)
- 反向 IPC 调用栈(main 侧 stub.run → IPC → renderer.invokeLocal → reply,由
  `plugin-mcp-stub-tool` 持有 main 侧;`plugin-mcp-e2e` 持有端到端)
- 权限门(`mcp-tools`)由 `plugin-mcp-permission` topic 持有
- Plugin 基类的 `registerMcpTool` proxy + LIFO 清理由 `plugin-mcp-lifecycle` 持有
- 多 wc 冲突 / wc destroyed 反注册由 `plugin-mcp-multi-window` 持有
