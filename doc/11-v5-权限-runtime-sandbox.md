# v5 权限 Runtime Sandbox 计划书

> 关联 issue #14。从 v4.7 的 all-or-nothing 走向 partial-grant + runtime gating。
> 状态:**计划阶段**,未实现。

## 1. 目标 / 非目标

**目标**

- plugin 调 fs / network / shell / clipboard 必须先在 manifest 声明 + 用户授权,否则抛 `PermissionError`
- 支持**部分授权**:用户只授 fs → plugin 激活,调 network 时被拒(graceful degradation)
- UI 上让用户能看到 plugin 当前的实际授权状态(badge)
- plugin 作者写代码时有清晰的 SDK 路径(不诱导走野路子)

**非目标**

- 不做真 OS 级 sandbox(进程隔离 / Web Worker)— 见 §3 选项 C 评估
- 不阻止 plugin 写 bug 自残(infinite loop / memory hog)
- 不防恶意 plugin 通过 prototype pollution 越权(超预算)

## 2. 架构现状

```
plugin main.js (Blob URL import → 与 LM renderer 同 realm)
   │
   ├── globalThis.lm = { Plugin, React }              ← LM 控
   ├── app: LMApp = { commands, statusBar, ... }      ← LM 控
   ├── window.api.fs.*                                ← preload 暴露,plugin 可直接用 ❌
   ├── globalThis.fetch                               ← 浏览器原生,plugin 可直接用 ❌
   ├── window.api.terminal.*                          ← preload 暴露 ❌
   └── navigator.clipboard.*                          ← 浏览器原生 ❌
```

**根问题**:plugin 与 LM renderer **同 realm**,没法 hide `window.api` / `globalThis.fetch`。任何"sandbox"在同 realm 都是 advisory。

## 3. Sandbox 等级三选

| 选项 | 实现 | 强度 | 工作量 | 评估 |
|---|---|---|---|---|
| **A 完全惯例**(只加 `app.*` 包装,不拦野路子) | SDK 增 API,文档约束 | 弱(plugin 想 bypass 一行 globalThis.fetch 即可) | 小 | 不诚实,权限只是好意 |
| **B 包装 + 入境清洗**(plugin 加载前删 `window.api`/`globalThis.fetch`,提供包装版) | 入境清洗 + Proxy `window` | 中(plugin 拿不到原版,但可通过 `parent`/`top`/iframe 重新拿) | 中 | 大部分场景能挡,有逃逸 |
| **C 真隔离**(plugin 跑在 Web Worker / iframe sandbox) | 重构 IPC,DOM API 走 message | 强 | 大(每个 contribution 接口都要 wrap message,statusBar render 函数怎么传 ReactNode 是难题) | 重构成本 = 现有 plugin 系统再写一次 |

**推荐 B**:不诚实 → 诚实 的边际收益最大,逃逸成本(知道要绕 `parent.window.api`)足够劝退普通插件作者。Obsidian / VS Code marketplace 也都不是真 sandbox,靠 review。

C 留给 v6+(若真要装 untrusted 插件)。

## 4. 新 SDK API 设计

### 4.1 Plugin 侧(globalThis.lm 增 + app 增)

```ts
// 新错误类
class PermissionError extends Error {
  readonly code = 'PERMISSION_DENIED';
  constructor(readonly permission: PermissionKey, msg?: string) {
    super(msg ?? `权限 ${permission} 未授权`);
  }
}
globalThis.lm.PermissionError = PermissionError;

// app 侧加 4 个命名空间(每个调用前 store.get 检查)
interface LMApp {
  // 原有 ...
  fs: {
    readFile(path: string): Promise<string>;       // 检 'fs'
    writeFile(path: string, content: string): Promise<void>;
    // ... 其它已在 window.api.fs 的方法
  };
  network: {
    fetch(url: string, init?: RequestInit): Promise<Response>;  // 检 'network'
  };
  shell: {
    spawn(cmd: string, args: string[]): Promise<...>;  // 检 'shell',底层走 node-pty
  };
  clipboard: {
    readText(): Promise<string>;     // 检 'clipboard'
    writeText(s: string): Promise<void>;
  };
  permission: {
    /** 主动检查,plugin 用来分支(true=有授,false=未授). */
    check(perm: PermissionKey): boolean;
    /** 列出当前 plugin 实际拿到的授权. */
    granted(): readonly PermissionKey[];
  };
}
```

**关键**:每个 fs/network/shell/clipboard 方法的实现:

```ts
async readFile(path: string): Promise<string> {
  if (!this.permission.check('fs')) {
    throw new PermissionError('fs', 'fs.readFile 需 fs 权限');
  }
  return window.api.fs.readFile(path);
}
```

`permission.check` 的实现需要知道当前 plugin id。**这是难点**:`app` 是单例(`lmApp`),plugin 拿到的是同一个引用,无法分辨调用方。

**方案**:plugin 拿到的 `app` 是**每个 plugin 一份的 proxy**(activateEntry 里 new),proxy 持有 pluginId,把 fs/network/shell/clipboard/permission 注入 pluginId-aware 实现;commands/statusBar 等贡献点 registry 直通 lmApp。

```ts
// PluginManager.activateEntry 里
const scopedApp = createScopedApp(lmApp, entry.id, this.host.permissionStore);
const instance = new Ctor(scopedApp, entry.manifest);
```

### 4.2 main.tsx 入境清洗(选项 B 强度)

```ts
// 在 plugin 加载前,把 fs/network/shell/clipboard 相关 API 从 globalThis 删掉
// LM UI 自己已用过,缓存到 LM 内部;plugin 拿不到。
const _fetch = globalThis.fetch;
delete (globalThis as any).fetch;
// ... 类似 navigator.clipboard, window.api(留 commands/popout/explorer 等非敏感的,删 fs/terminal)
```

注:**LM UI 自身的 fs/terminal 调用必须在 import plugin 之前**完成,或者把 `window.api.fs` 留给 LM,只删 `window.api`(让 plugin 也拿不到)。需细化。

## 5. 迁移影响(breaking changes)

| 谁 | 影响 |
|---|---|
| 现有 sample plugin | 不受影响(没用 fs/network/shell/clipboard) |
| 现有 perm test plugin | 不受影响(同上) |
| `examples/sample-plugin` git repo | 加一个 fs + network demo(可选,演示 PermissionError 路径) |
| 第三方插件(还没有) | n/a — v5 出之前就是 sandbox 默认 |
| LM UI 自身 | 入境清洗时机要小心,不能误删 LM 自用的 IPC |

## 6. 阶段拆分(每阶段一个可 review 的 PR)

### Phase 1 — SDK 基础 + 包装 API(不破)

- 新 `PermissionError` class 暴露到 `globalThis.lm`
- 新 `app.fs` / `app.network` / `app.shell` / `app.clipboard` 4 个命名空间(初始未做权限检,直接转发到 window.api / globalThis.fetch)
- 新 `app.permission.check / granted`
- ScopedApp proxy 机制(per plugin 包一层,持 pluginId)
- 配套 BDD/TDD,不影响现有 plugin 行为

### Phase 2 — partial grant 语义改造

- `ensureAuthorized` 改:partial grant 不 fail,返 `{ ok:true, partial:true, granted: [...granted], denied: [...denied] }`
- PluginManager 把 partial 状态记到 entry,新增 `entry.warning`
- `PermissionPrompt` 文案改:"勾选项被授权,未勾视为拒绝;插件可在 runtime 优雅处理"
- `PermissionEditorModal` 同样改文案 + 显示当前 partial 状态
- UI:plugin 行加小黄字 `部分授权(fs)` badge

### Phase 3 — runtime gating 启用

- `app.fs/network/shell/clipboard` 各方法实际接入 `permission.check` → 抛 `PermissionError`
- sample plugin 加两个 demo 命令:`sample.read-file`(走 fs)、`sample.fetch`(走 network),演示 try/catch PermissionError
- 文档更新:plugin 作者必须 try/catch 或 check

### Phase 4 — 入境清洗(选项 B 兜底)

- main.tsx 在 import 第一个 plugin 之前清掉 `globalThis.fetch` / `navigator.clipboard` / `window.api.fs` / `window.api.terminal`(具体清单待定)
- LM UI 自用的部分挪到 import 前,或缓存到 LM 内部 module
- 验证:plugin 直接 `globalThis.fetch('https://...')` 应抛 ReferenceError

### Phase 5 — 验证 + 文档

- 写 plugin 作者文档:`doc/plugin-permissions.md`
- 录端到端验证(对应原 #14 全部 8 个 checkbox)
- 关 #14

## 7. 测试策略

| 层 | 测试 |
|---|---|
| `permissions.ts` | `ensureAuthorized` partial 分支(grant 部分 → ok partial, denied 列表正确) |
| `ScopedApp` | per-plugin id 注入正确,permission.check 反映 store 当前状态 |
| `app.fs/network/shell/clipboard` | 未授 → 抛 PermissionError;授 → 透传 |
| `PluginManager` | partial activate 后 entry.warning 正确;FAILED 不再因部分 deny 触发 |
| BDD 端到端 | 新主题 `plugin-permissions-runtime` 下覆盖整流程 |
| 入境清洗 | `globalThis.fetch === undefined` after init;LM UI 自身 fetch 仍 work(因为缓存) |

## 8. 风险 / 待定

| 风险 | 缓解 |
|---|---|
| ScopedApp proxy 性能(每个 plugin 一份) | 实测;plugin 数量 < 100,proxy 创建一次性,可接受 |
| 入境清洗时机:LM UI 还在 init 阶段 fetch → 误删 | LM 内部把要用的 globals 缓存到 module-local,清洗后 LM 用缓存,plugin 拿不到 |
| partial 状态在 Modal 上的 UX 复杂(单个 plugin 4 个权限,可能 partial 部分组合) | 第一版 Modal 只显"已授哪些",不再花哨 |
| sample plugin 改造改坏 9 贡献点验证 | sample 现有命令保留,加新命令演示;不改老的 |
| Plugin 作者忘 try/catch PermissionError → 整个 onload 崩 | 已有 onload 抛错隔离(B.10 验过),最坏后果 status=failed,可恢复 |
| Worker / iframe 后续切换 | 把 ScopedApp 设计成接口而非实现,Worker 版接同接口 |

## 9. 估时

| Phase | 工作量(LM 单人) |
|---|---|
| 1 SDK 基础 | 0.5 day |
| 2 partial grant 语义 | 0.5 day |
| 3 runtime gating | 0.5 day |
| 4 入境清洗 | 0.5 day(陷阱多) |
| 5 验证 + 文档 | 0.5 day |
| **总计** | **2.5 day** |
