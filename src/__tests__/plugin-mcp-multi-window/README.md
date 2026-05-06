# plugin-mcp-multi-window (Plugin → MCP Bridge · 多窗口)

行为契约:**main 侧 PluginMcpBridge 的注册并存 / 路由 / wc destroyed 反注册**。

方案 A(用户决策 2026-05-06):**先到先得**。同名 tool 第二个 wc 注册抛 `TOOL_NAME_TAKEN`,
不做 round-robin 也不做 per-wc 命名空间。

> 配套:[doc/19-plugin-mcp-bridge.md](../../../doc/19-plugin-mcp-bridge.md) §多窗口策略
>
> 同 plugin 在 N 个窗口被加载 N 次时:第一个 wc 抢先注册成功,其它 wc 拿
> `TOOL_NAME_TAKEN` 错。Plugin 作者要多窗口共存自己用 `localStorage` 做 leader
> election。这是有意识的极简取舍。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/plugin-mcp-bridge.service.ts` | createBridge / handleRegister / handleUnregister / handleWebContentsGone |

需 export 的形态(供本主题断言):

```ts
import type { McpHost } from './mcp-host.service';

export interface PluginMcpBridge {
  /**
   * 处理一次 renderer 上行 register。重名抛 PluginMcpError(TOOL_NAME_TAKEN);
   * 成功则在 host.tools 加 stub,在内部表登 owner=(pluginId,wcId)。
   */
  handleRegister(
    wcId: number,
    payload: { pluginId: string; name: string; description: string; jsonSchema: Record<string, unknown> },
  ): void;
  /**
   * 处理一次 renderer 上行 unregister。unknown name → 静默忽略(允许 plugin
   * 重复 dispose 而不报错)。non-owner wc 调 unregister own tool → 拒绝(未来扩展)。
   */
  handleUnregister(wcId: number, name: string): void;
  /**
   * webContents destroyed:摘掉所有 owner=该 wc 的 stub,abort 所有 invoke pending。
   * 之后该 name 可被其他 wc 重注册。
   */
  handleWebContentsGone(wcId: number): void;
  /** 当前 owner 表(测试用). */
  listRegistered(): readonly { name: string; pluginId: string; wcId: number }[];
}

export interface CreatePluginMcpBridgeDeps {
  host: Pick<McpHost, 'registerTool' | 'tools'> & {
    /** 假设 host 提供方法摘掉 tool — 现 host.registerTool 仅加,本主题要求 host
     *  扩展 unregisterTool(name) 或暴露 `tools` 是 Map 直接 delete。本 spec 倾向
     *  注入"removeTool"接口,实装阶段决在 host 加 method 还是 expose Map. */
    removeTool(name: string): void;
  };
  invokeRemote: import('./plugin-mcp-bridge.service').InvokeRemoteCore;
}

export function createPluginMcpBridge(deps: CreatePluginMcpBridgeDeps): PluginMcpBridge;
```

## 关键行为

### handleRegister · 首注册

- payload.name 在内部表中**不**存在 → 调 `host.registerTool(stub)`,内部表登
  `{name, pluginId, wcId}`
- stub 由 `createStubTool(payload, owner, invokeRemote.invoke)` 构造(stub-tool topic
  已断言 stub 形态)

### handleRegister · 同名冲突

- payload.name 在内部表中**已存在**(任何 wc owner)→ 抛 `PluginMcpError`
  with code `TOOL_NAME_TAKEN`,**不**调 host.registerTool 第二次
- 错误向上传给 IPC 回 renderer(由实装决定怎么发回 — 本 spec 只断"抛")
- 内部表不变,不影响原 owner

### handleUnregister · 正常路径

- `(name, owner.wcId === 入参 wcId)` 匹配 → 调 `host.removeTool(name)`,内部表摘条目
- 同时 `invokeRemote.abortByWebContents` 不调(因 abort 是 wc 整体级,不是单 tool 级);
  pending invoke 自然超时或继续等(plugin 已 dispose 但 main pending 仍可能正常 resolve)
- 实装可选:同时 abort pending 中 (owner=同 wc, name=该 name) 的 invoke;但本 spec 不强制

### handleUnregister · unknown name

- 内部表中无此 name → 静默忽略(noop),不抛;允许 plugin 重复 dispose

### handleUnregister · 非 owner wc 调

- name 存在但 owner.wcId !== 入参 wcId → 拒绝(noop / 抛错均可,**本 spec 取 noop**)
- 防止 wc B 通过 IPC 假冒摘掉 wc A 注册的 tool

### handleWebContentsGone · 摘掉所有 stub

- 遍历内部表,owner.wcId === 入参 wcId 的所有 entry:
  - 调 `host.removeTool(name)`
  - 从内部表摘
- 调 `invokeRemote.abortByWebContents(wcId)`(让 pending invoke 全部 reject PLUGIN_GONE)
- 其他 wc 的 entry 不动

### handleWebContentsGone · 后允许重注册

- wc=11 注册 'echo' → wc=11 destroyed → wc=22 注册 'echo' 应成功
- 本 spec 断:gone 后再 handleRegister 同名不抛 TOOL_NAME_TAKEN

### 路由正确性

- 多 wc 注册不同 name 后,host.tools 含全部 stub
- 通过 stub 调用(模拟 MCP client 触发 stub.run)→ invokeRemote.invoke 收到正确
  owner.wcId(对应注册者所在 wc)
- 本 spec 用 spy invokeRemote 断:invoke 调用时 owner 字段透传到 send

## 不在本主题验证

- IPC 协议字段(由 `plugin-mcp-ipc-bridge` 持有)
- pending invoke / 超时 / abort 单元行为(由 `plugin-mcp-stub-tool` 持有)
- HTTP / 真 webContents.send(由 `plugin-mcp-e2e` 持有)
- renderer 侧 PluginMcpRegistry 行为(由 `plugin-mcp-registry` 持有)
- Plugin 生命周期与 disposable LIFO(由 `plugin-mcp-lifecycle` 持有)
