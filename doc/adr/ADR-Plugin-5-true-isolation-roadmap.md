# ADR-Plugin-5 · 插件真隔离路线图（Worker 逻辑 + iframe UI）

**Status**: Proposed（立项设计提案，未实施）。扩展并最终将取代 [ADR-Plugin-1](./ADR-Plugin-1-no-sandbox.md) 中保留的「option C（Worker/iframe 真隔离）= v6+ candidate」。

> 本文是**设计立项**，不是实现。落地前必须先过 Phase 0 可行性 spike，并通过下方「决策门」。遵循项目「极简原则，不过度设计」——**没有不可信第三方市场需求之前，不应启动实现**。

## 1. 背景与触发

ADR-Plugin-1 有意选择了 **option B（wrap + entry-sweep + 运行时 gating）**，并明确承认其残留：插件与宿主 UI **共享同一个 renderer realm**，`window.__lmApi` 经 contextBridge 暴露且不可删，`sandbox-sweep` 只能涂掉少数 global，恶意插件可一行 `import { coApi }` 绕过所有 scoped wrapper。

2026-06 的安全审计（见提交 `1508dc0` / `62b1247`）验证了这条根因衍生的一系列问题：

- 插件 bundle 顶层代码在权限授权前即执行（已修：权限门前移）。
- 跨插件 dataStore 访问、贡献点 registry「后注册者赢」劫持、EventBus 全量暴露——renderer 侧 wrapper 只能部分缓解，**realm 内可直接 `import coApi` 绕过**。
- `shell.exec` 主进程无插件身份校验——同 realm 内任意插件可达。

结论：**只要插件与宿主同 realm，能力收窄（option B）就有理论天花板。** 要支持「运行不可信第三方代码」，必须把插件执行迁入真正隔离的上下文。这就是本立项。

## 2. 决策门：什么时候才该做（极简原则）

隔离强度必须匹配信任级别。**先界定信任级别，再决定是否投入。**

| 信任级别 | 典型场景 | 现状（option B + 已修安全项）是否足够 |
|---|---|---|
| 自营插件（Git Viewer / Skills Manager 等第一方） | 当前 | **足够**，无需本立项 |
| 半信任 + 人工审核市场（≈ Obsidian 模型） | 受控生态 | **基本足够**，靠 marketplace review 兜底显式恶意 |
| 公开、任意作者、零审核市场 | 真·开放生态 | **不足够**，必须 option C |

**启动本立项的前置条件（任一成立）**：
1. 产品决定开放**无人工审核**的第三方插件市场；或
2. 出现一个 option B 无法缓解、且非「显式恶意交给 review」可接受的具体威胁。

否则保持现状，把精力放在 marketplace review 流程与 option B 的纵深防御上。

## 3. 威胁模型（本立项要防的）

- **防**：第三方插件作者的 bug / 被供应链投毒的依赖 / 中等恶意（读其他插件数据、外带凭据、改宿主 UI、跑死线程）。
- **防**：插件越过能力 gate 直接拿宿主全盘 fs / 任意进程执行。
- **不在范围**：nation-state 级、QuickJS 逃逸级对抗（除非将来上 Figma 式 WASM VM，见 §7）。
- **不变量**：真正的硬边界仍在 **main 进程**（IPC + token + path-scope）。renderer 隔离是为了让「插件代码够不到宿主 DOM 与未包装的 `coApi`」。

## 4. 现状能力面盘点（迁移可行性）

按「跨 realm 难度」分三类（完整表见本 ADR 附录 / 立项调研记录）：

**A 类 · easy（搬 Worker，异步化即可）**
`command.fn`、`event`（payload 限 JSON）、`dataStore`、`fs`、`clipboard`、`permission`、`shell.exec`、`dock.openPanel`、`notifications.show`、`editor.openFile`、`workspace.getRoot`。
—— 这些已是「参数进、结果出」的 Promise 契约，fs/shell/clipboard 实际已是 main 进程 message-passing。成本：把同步 `Disposable`/`void` 包成「注册 message + ack」。

**B 类 · medium**
`ribbon.onClick`、`shell.execStream`（异步迭代器需消息协议桥，chunk 可 transfer）、`network.fetch`（Response 跨界需重组 body）、`mcp.run`（逻辑可搬，但 `inputSchema: ZodType` 不可序列化，需改为只传 jsonSchema + Worker 内重建校验）。

**C 类 · hard（必须 API 破坏性重设计）—— 真隔离的拦路虎**
1. **返回/携带 `ReactNode` 的 UI 贡献点**：`panel.factory`（最大障碍）、`status-bar.render`、`setting-tab.render`，以及 `ribbon/editor-action/context-menu/decorator` 的 `icon` 字段。ReactNode 不可序列化，且当前**共享宿主同一个 React 实例**。
2. **同步高频谓词**：`editor-action.when(ctx)`（每帧调）、`explorer-decorator.fn(entry)`（每行调）、`context-menu.when(ctx)`——跨 realm 无法同步返回。
3. **`globalThis.co` SDK 注入**（React/Plugin 基类/zod 共享）——Worker/iframe 里没有，需 bootstrap 协议投影。
4. **同步 `Disposable` + `Plugin` 基类 LIFO `disposeCollected()`**——跨界后 unregister 变异步。

**测试影响**：`src/__tests__/` 下插件相关 spec 约 **88 文件 / 725 用例**。A 类断言（参数→结果契约）大多可迁移性改造（改 mock 层）；B/C 类（ReactNode + 同步 when）约 **150–220 用例需重写**。

## 5. 参考架构调研结论

| 项目 | 逻辑隔离 | UI 隔离 | 安全强度 | 关键启示 |
|---|---|---|---|---|
| **VSCode（桌面）** | 独立 Extension Host 进程 + JSON-RPC | sandbox iframe webview | ★★★★ | API **async-first** 是隔离的前提；扩展进程无 DOM，全 RPC 代理；activation events 懒加载 |
| **VSCode Web / Theia** | **Web Worker** extension host | iframe | ★★★ | 同一套异步 API，底层容器从进程换 Worker **几乎不改契约** |
| **Figma** | **QuickJS/WASM VM** | iframe（仅 UI） | ★★★★★ | Realms shim 因对象身份混淆被逃逸 → 换 WASM VM；文档访问不放 iframe（序列化太慢）；最强但调试痛 |
| **Obsidian** | 无 | 无 | ★（靠 review） | 反面参照：生态繁荣但零隔离 |
| **`examples/lokus`** | **设计了 Worker，实际静默降级到主线程** | REACT/webview/iframe 混合 | ★ | **WebView 的 CSP/blob 限制让 Worker 创建失败 → 降级**。Continuo 必须先实测可行性，否则重蹈覆辙 |

通用工具：**Comlink**（postMessage proxy，把 RPC 写成本地异步调用）；同步 API 异步化为主流，`SharedArrayBuffer + Atomics.wait` 同步桥仅作逃生舱（需 COOP/COEP 头，与现有 CSP 冲突，不推荐）；iframe UI 主题一致 = **CSS 变量注入 + class/data-\* 广播**（VSCode webview 范式，与 Continuo 现有 `--md-*` token 体系天然契合）。

来源 URL 见立项调研记录（agent 调研产物）。

## 6. 推荐架构：Worker 逻辑 host + iframe UI host（务实中档）

不选 QuickJS/WASM（过度设计，调试代价高，留给将来真·公开市场）。选 **VSCode-Web/Theia 同款**：

```
┌─ 主 renderer（宿主，唯一能碰真实 DOM / coApi / 主题）──────────────┐
│  · 贡献点 registry（host 侧权威）                                  │
│  · RPC broker（Comlink 风格），权限/scope 网关                     │
│  ├──postMessage RPC──→ ┌─ Plugin Logic Host（Web Worker，无 DOM）─┐│
│  │                     │  插件 JS 顶层 + command/event/mcp.run/   ││
│  │                     │  fs/shell/dataStore 代理（全异步）        ││
│  │                     └──────────────────────────────────────────┘│
│  └──postMessage RPC──→ ┌─ Plugin UI（<iframe sandbox="allow-scripts">│
│                        │  插件自带 DOM + 自带 React + 注入的 CSS    ││
│                        │  token；panel/status-bar/setting-tab 渲染  ││
│                        └──────────────────────────────────────────┘│
└────────────────────────────────────────────────────────────────────┘
```

关键设计原则：
- **API 全面 async-first**：现有 `coApp.*` 本就 Promise 风格，沿用即可适配任何容器。
- **iframe sandbox 必须是 `allow-scripts` 且 NOT `allow-same-origin`**（lokus 两个都加 = 自废沙箱）。
- **iframe↔逻辑 worker 不直连**，一律经宿主中转，宿主是权限网关。
- **主题**：注入 `--md-*` 语义 token 为 CSS 变量 + 切主题广播 `class/data-theme`，契合 CLAUDE.md「禁字面 hex、必须语义 token」。
- **C 类 API 重设计方向**：
  - panel/setting-tab/status-bar → iframe 内渲染，host 用 `{type,id,method,params}` 协议；
  - 同步 `when` 谓词 → **声明式规则**（`when: { filePathEndsWith: '.md' }`）由 host 端求值，或 host 缓存 + 插件推送式更新；
  - `icon: ReactNode` → 改为 **icon 名 / SVG 字符串**（数据化）；
  - `mcp.inputSchema: ZodType` → 只跨界传 jsonSchema，Worker 内重建校验；
  - 同步 `Disposable` → 异步 unregister message（`PluginMcpRegistry` 已是此模式，作为范本）。

## 7. 分阶段路线（BDD-first，每阶段可独立 ship）

> 严格遵守 BDD+TDD：每阶段先写 `src/__tests__/<topic>/` 行为规范，再实现。

- **Phase 0 · 可行性 spike（必须先行，门槛）**
  在 **packaged Electron**（非仅 dev）WebView 的真实 CSP 下，验证：(a) `new Worker(blobURL)` 能创建并双向 postMessage；(b) iframe `sandbox="allow-scripts"` 能加载插件 UI 并 message 通；(c)（可选）`SharedArrayBuffer` 是否可用（决定是否完全排除同步桥）。
  **失败即止**——这是 lokus 栽的坑，不验证不投入后续。产出：spike 报告 + 必要的 CSP/COOP-COEP 调整方案。

- **Phase 1 · RPC broker + Worker 逻辑 host（A 类能力）**
  把 `command/event/dataStore/fs/shell/clipboard/permission/mcp.run/editor.openFile/dock/notifications` 迁入 Worker，建立 Comlink 风格 broker + 宿主权限网关。UI 贡献点暂留主线程（双轨并行）。A 类测试改 mock 层为 message round-trip。

- **Phase 2 · iframe UI host（C 类 UI 贡献点）**
  panel/status-bar/setting-tab 迁 iframe，定义渲染消息协议 + CSS token 注入 + 主题广播。重写 B/C 类 UI 测试。

- **Phase 3 · 同步谓词与 icon 数据化**
  `when` 声明式化、`icon` 改数据、zod→jsonSchema。收口 `globalThis.co` 注入为 bootstrap 协议。

- **Phase 4 · 退役 option B 双轨 + 文档**
  删除主线程直跑路径，更新 ADR-Plugin-1 为 Superseded，发布插件 API v2 迁移指南（破坏性，需大版本 + 旧插件兼容策略）。

## 8. 风险与「何时不做 / 何时停」

- **WebView 容器限制**（Phase 0 失败）→ 整个方案不可行，回退 option B + 强化 review。
- **破坏性 API v2** → 所有现有插件需迁移；若生态已成形，迁移成本可能超过收益。
- **过度设计风险** → 若产品始终不开放不可信市场，本立项**永远不该实施**（§2 决策门）。
- **性能** → Worker/iframe 序列化对高频路径（decorator 每行、editor-action 每帧）有成本，§6 的声明式/缓存设计是必须而非可选。

## 9. 关联

- [ADR-Plugin-1](./ADR-Plugin-1-no-sandbox.md)（被本文扩展/将取代）
- [ADR-Plugin-3](./ADR-Plugin-3-coapp-not-windowapi.md)、[ADR-018](./ADR-018-path-scoped-permission.md)
- 安全审计修复：提交 `62b1247`、`1508dc0`
- 立项调研产物：当前插件能力面盘点 + 参考架构（VSCode/Figma/Obsidian/Theia/lokus）综述
- `src/plugins/{types,Plugin,co-app,scoped-app,loader,sandbox-sweep}.ts`、`registries/*`、`examples/lokus/src/plugins/`
