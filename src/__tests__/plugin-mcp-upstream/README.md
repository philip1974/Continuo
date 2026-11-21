# plugin-mcp-upstream(PluginMcp 注册的 IPC 实装)

行为契约:**`createIpcPluginMcpUpstream()` 返回 PluginMcpUpstream 实现;register 调
preload 的 `pluginMcp.registerTool` IPC,`ok=false` → 抛带 code 的 Error;
unregister 类似但失败仅 console.warn 不抛(关闭路径),preload 缺失时 register 抛
PRELOAD_NOT_READY,unregister 静默(关闭中允许 noop)。**

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/plugin-mcp-upstream.ts` | IPC upstream 实装 |

## 关键行为

### register(payload)

- preload 缺 → 抛 Error,code = 'PRELOAD_NOT_READY'
- IPC 返 ok=true → resolve
- IPC 返 ok=false → 抛 Error(message=r.message,code=r.code)

### unregister(name)

- preload 缺 → 静默 resolve
- IPC 返 ok=true → resolve
- IPC 返 ok=false → console.warn,不抛
