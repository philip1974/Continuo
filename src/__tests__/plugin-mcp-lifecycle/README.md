# plugin-mcp-lifecycle (Plugin → MCP Bridge · 生命周期)

行为契约:**Plugin 基类的 `registerMcpTool` proxy + Disposable 自动清理**。

确保:
- plugin 调 `this.registerMcpTool(spec)` 会经 ScopedApp.mcp 上行,失败抛错
- 成功返回的 Disposable 自动入 plugin 的 disposables
- plugin disable / uninstall / reload 时 LIFO 清理触发 unregister
- onload 抛错 / await 中途 deactivate → 不泄漏 stub

> 配套:[doc/19-plugin-mcp-bridge.md](../../../doc/19-plugin-mcp-bridge.md) §Plugin 生命周期
>
> 上下文:Plugin 现有所有贡献点(panels / commands / events 等)都走 disposable LIFO,
> mcp 工具注册必须遵守同款契约,否则跨进程留垃圾。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/Plugin.ts` | 加 `protected async registerMcpTool(spec): Promise<Disposable>` proxy |
| `src/plugins/types.ts` | `CoApp` / `CoPluginApp` 加 `mcp` 字段(类型) |

需 export 的形态(供本主题断言):

```ts
// Plugin 基类(扩展):
abstract class Plugin {
  // ...现有 8 个贡献点 proxy
  protected registerMcpTool(spec: PluginMcpToolSpec): Promise<Disposable>;
}

// CoPluginApp 加(完整签名见 plugin-mcp-permission topic):
interface PluginMcpApi {
  register(spec: PluginMcpToolSpec): Promise<Disposable>;
}

// CoApp / CoPluginApp 加 mcp 字段
```

## 关键行为

### registerMcpTool — 成功路径

- plugin 在 onload 中调 `await this.registerMcpTool(spec)`
- proxy 内部调 `this.app.mcp.register(spec)`(scoped 已知 pluginId,无需 plugin 显式传)
- 拿到 Disposable 后 `this.register(d)` 入 disposables(同 panel/command 形态)
- proxy 返回该 Disposable(plugin 可选地存引用做手动 dispose,但 _deactivate 会兜底)

### registerMcpTool — 失败路径

- `app.mcp.register` reject(权限错 / 重名 / 上行 IPC 错)→ proxy reject 透传
- 失败时 disposables 不变(没成功就不需要清理)
- plugin 可在 catch 里降级或 abort onload

### _deactivate · 自动 unregister

- plugin disable / uninstall / reload 触发 `_deactivate()`
- LIFO 反序 dispose 所有 disposables
- registerMcpTool 拿到的 Disposable 在此触发,调 upstream.unregister(name)
- 多个 mcp tool 一并清理,后注册的先 unregister

### onload 抛错 → 已注册的 stub 自动清理

- 假设 onload 内 `await registerMcpTool('a')` 成功后 `await registerMcpTool('b')` 抛错
- onload 抛错向上传给 _activate;**plugin-base 在 _activate 失败时自动 LIFO
  dispose 已收集的 disposables(2026-05 修复,见 plugin-base topic)**
- 因此 a 的 stub 在 _activate reject 之前已被 dispose,触发 upstream.unregister,
  main 端 host 不留泄漏 stub
- 不调 onunload(plugin 没完成初始化,业务卸载钩子无意义)

### 中途 deactivate(_activate 还在 await)

- plugin onload 在 `await registerMcpTool('a')` 中,某外部条件触发 _deactivate
- 现有 Plugin.ts:`_deactivate` 设 disposed=true,后 register(d) 进 disposables 立即 dispose
  → 当 a 的 Disposable 被 register 时立即 dispose,触发 unregister
- 因此**断:** 中途 deactivate 时 a 的 unregister 也会发(允许小窗口竞争——main 端
  unregister 之前 register 可能尚未到达,bridge 应能 idempotent 处理"unregister 不存在的
  name",由 multi-window topic 保证)

### 多 tool LIFO

```
onload:
  await registerMcpTool('a')
  await registerMcpTool('b')
  await registerMcpTool('c')

_deactivate:
  unregister('c')
  unregister('b')
  unregister('a')
```

### 单个 dispose 抛错不传染

- a 的 dispose 抛错 → console.warn,继续 dispose b / c(已是 plugin-base 现状)
- 本主题断:模拟 b 的 dispose throw,a / c 仍 dispose

## 不在本主题验证

- `app.mcp.register` 内部权限门(由 `plugin-mcp-permission` 持有)
- 实际 unregister IPC 是否到达 main(由 `plugin-mcp-stub-tool` / `plugin-mcp-multi-window` 持有)
- end-to-end:plugin disable 后 MCP client 看 tools/list 不再含此 tool(由 `plugin-mcp-e2e` 持有)
