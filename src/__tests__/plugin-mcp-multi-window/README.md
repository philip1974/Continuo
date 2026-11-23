# plugin-mcp-multi-window (Plugin → MCP Bridge · 多窗口)

行为契约:**main 侧 PluginMcpBridge 的注册并存 / 路由 / wc destroyed 反注册**。

方案 A(用户决策 2026-05-06):**先到先得**。同名 tool 第二个 wc 注册抛 `TOOL_NAME_TAKEN`,
不做 round-robin 也不做 per-wc 命名空间。

> 配套:`doc/19-plugin-mcp-bridge.md`(维护者本地文档,未公开) §多窗口策略
>
> 同 plugin 在 N 个窗口被加载 N 次时:第一个 wc 抢先注册成功,其它 wc 拿
> `TOOL_NAME_TAKEN` 错。Plugin 作者要多窗口共存自己用 `localStorage` 做 leader
> election。这是有意识的极简取舍。
>
> 注意:注册是全局唯一的,但**调用只允许注册者所在窗口的 agent**(跨窗调用被拒,见「授权门控」)。

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
  host: PluginMcpBridgeHost; // registerTool / removeTool / tools
  notifyToolsChanged?: () => void;
  invokeRemote: import('./plugin-mcp-bridge.service').InvokeRemoteCore;
  /** agent 授权门控(必填),见下「授权门控」. */
  ensureAuthorized: import('./mcp-tool-gates').EnsureAuthorized;
  /** 注册者 wc 所在窗口 id(必填),跨窗调用拒绝的依据,见下「授权门控」. */
  windowIdOfWc: (wcId: number) => number | null;
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
- 与宿主 `host.tools` 已有 tool(含 terminal.* / debug.* 等内置)重名同样抛 `TOOL_NAME_TAKEN`:不覆盖
  内置 tool,随后的注销 / wc 销毁也不会删掉它(否则核心工具被插件截获或永久 NO_SUCH_TOOL)
- 防御纵深:`McpHost.registerTool` 本身对已存在的名字抛错,不静默覆盖
- 内部表不变,不影响原 owner

### handleUnregister · 正常路径

- `(name, owner.wcId === 入参 wcId)` 匹配 → 调 `host.removeTool(name)`,内部表摘条目
- 同时 `invokeRemote.abortByTool(wcId, name)` 中止该工具在途的 invoke(以 TOOL_DISPOSED 结束)

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

### 授权门控(安全)

- `CreatePluginMcpBridgeDeps.ensureAuthorized`(必填)—— stub 经 `gateWithAuth`(`mcp-tool-gates.ts`)包一层,
  与终端 / debug 工具同走 agent 授权。此前 stub 丢弃 ctx 直接 invoke,用户对 agent 点了「拒绝」该 agent
  仍能调插件工具(如 git stage/commit)
- **跨窗调用拒绝**(安全,2026-11-18 起取代旧的「跨窗共享」):`CreatePluginMcpBridgeDeps.windowIdOfWc`(必填)
  给出注册者 wc 当前所在窗口。调用方 `ctx.ownerWindowId` 与之不同、调用方无有效窗口、调用方是外部客户端
  (`ctx.external`:stdio 未发 hello、回落到主窗 —— 即便主窗恰是注册者窗口)、
  或注册者窗口已不可解析(null)→ 抛 `AGENT_NOT_AUTHORIZED`(消息含 `belongs to another window`),**不弹授权、
  不 invoke**。旧行为是「调用方窗口授权、注册者窗口执行」:窗口 A 的 agent 调 B 的插件工具,A 的用户批准,操作
  却落在 B 的仓库,B 的用户不知情。工具名全局唯一注册(先到先得)保持不变,只是别的窗口调不了。
- 同窗通过后授权:`ensureAuthorized(ctx.ownerWindowId, 'plugin.<tool 名>')`,弹窗出现在该窗口;路由按注册者 owner
- IPC 接线中 `windowIdOfWc` 取 `BrowserWindow.fromWebContents(webContents.fromId(wcId))?.id`,wc 已销毁 → null
- method 以 `plugin.` 为前缀,`agentAuthDomainOf` 归入独立的插件工具域(main 按域判定放行,与终端 / debug 域互不放行,
  见 `agent-terminal-mcp-auth`);超长 tool 名按授权请求 method 上限截断
- denied / 调用方已断开 → `AGENT_NOT_AUTHORIZED`,不向插件 renderer 发 invoke
- IPC 接线 `startPluginMcpIpc(host, getStdio, ensureAuthorized)`:第三参缺省 fail-closed(一律拒绝),
  生产由 `main/index.ts` 注入 `requestAgentAuth`

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
