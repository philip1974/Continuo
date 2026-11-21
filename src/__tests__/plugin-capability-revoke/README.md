# plugin-capability-revoke(插件能力回收:停用即吊销、跨窗口启停、撤销 mcp-tools)

终审 P1 三条同族缺陷:能力只在「入口处」检查一次,之后状态变化(停用 / 别窗禁用 / 撤销授权)不再回收。

1. 延迟回调或超时后仍在跑的 `onunload` 在停用之后调用 `app.shell.exec` 等,scoped app 不知道插件已停用,
   停用后新起的进程不再被 `killPluginShellProcesses` 回收。
2. 窗口 A 禁用只更新 `_enabled.json` 并在 A 本地停用,窗口 B 的实例继续运行。
3. `mcp-tools` 只在注册时检查;撤销后已注册的工具仍可被调用。

## 行为契约

### 1. 停用即吊销 scoped app(`src/plugins/scoped-app.ts` / `PluginManager.ts`)

- `createScopedAppController(...)` 返回 `{ app, revoke(), recheckMcpPermission() }`;控制面由 `PluginManager`
  持有(`entry.scoped`),插件只拿到 `app`。`createScopedApp` 保留(只返回 `app`,给 core plugin / 测试)。
- `deactivateEntry`(disable / uninstall / 远端卸载 / 远端禁用 / reload / shutdown 统一入口)在调用 `onunload`
  **之前**先 `revoke()`;激活失败(构造函数 / onload 抛错)同样 `revoke()`。
- 吊销后的划线 —— **有外部副作用即阻断**,在 renderer 源头拒绝、不发 IPC:

  | 阻断 | 吊销后的结果 |
  | --- | --- |
  | `shell.exec` / `shell.execStream` | `PermissionError('shell')`;execStream 的 `done` 与 `chunks` 均 reject,不 spawn |
  | `network.fetch` | `PermissionError('network')`;吊销时 abort 全部在途请求(每次请求挂实例的 AbortController,调用方自带 `signal` 仍联动生效) |
  | `fs` 写 / 扩权:`writeFile / mkdir / rename / rm / cp / atomicReplaceWithinScope / requestScope` | `PermissionError('fs')` |
  | `clipboard.readText / writeText` | `PermissionError('clipboard')`(读剪贴板是用户隐私,停用后的代码无正当用途) |
  | `mcp.register`;已注册工具的每次调用 | `PermissionError('mcp-tools')`;吊销前经 `app.mcp.register` 注册的工具在 `revoke()` 时全部注销(见下) |
  | `notifications.show` / `dock.openPanel` | 抛 `code: 'PERMISSION_DENIED'`(无对应权限项的 UI 副作用) |
  | 贡献点注册 / 订阅:`panels / commands / statusBar / ribbon / settingTabs / settingItems / explorerDecorators / editorActions / explorerContextMenu` 的 `register`、`subscribe`;`events.on` | 抛 `code: 'PERMISSION_DENIED'`,不入共享注册表 |
  | `commands.execute` | 返回 reject 的 Promise(`code: 'PERMISSION_DENIED'`),命令不执行 —— 宿主命令(`window.new` / `terminal.new` 等)会创建不归插件、回收清不掉的窗口 / 终端 |
  | `events.emit` / `events.clear` | 抛 `code: 'PERMISSION_DENIED'` —— emit 触发他人监听的副作用;clear 吊销后同样拒绝(未吊销时只清本插件自己的订阅,见 scoped-app README) |
  | 注册表 / 总线上其余未列入「不阻断」的成员 | 同上抛 `PERMISSION_DENIED`(白名单放行,新增方法默认阻断) |
  | `editor.openFile` | 返回 `{ ok: false, code: 'PERMISSION_DENIED' }`(其契约返回结果对象不抛) |

  | 不阻断 | 理由 |
  | --- | --- |
  | `fs` 读:`readFile / listDir / stat / lstat / realpath / readGitBlob / userHome` | 无外部副作用,`onunload` 收尾可能要读;停用随即回收 plugin-fs token,之后 main 侧拒绝 |
  | `dataStore.read / write` | 插件自有数据,`onunload` 常用 `saveData` 落盘状态 |
  | `permission.check / granted` | 只读查询 |
  | 贡献点只读查询:各注册表 `getAll / get / list / getBySide / getByCategory` | 只读;但结果是浅拷贝,其中的回调(`fn / when / render / factory / onClick`、装饰器函数)包吊销检查 —— 吊销后调用抛 `PERMISSION_DENIED`(见下) |
  | `events.off` | 只能移除调用方持有 listener 引用的订阅,即插件自身的订阅;收尾退订无副作用 |
  | `version` / `workspace.getRoot` | 只读 |

- 贡献点回收:scoped app 对外暴露的注册表 / `events` 是 per-plugin 包装(底层仍是共享单例)。吊销**前**经
  scoped app 注册的贡献与订阅(无论是否经 `Plugin.register` 收集)由控制面记录,`revoke()` 时统一注销 ——
  插件绕过 `Plugin.register` 直接 `app.commands.register(...)` 的命令,停用后同样从注册表移除、快捷键失效。
  返回的句柄幂等;插件先自行 dispose 的不再重复注销,也不会误删他人后注册的同 id 贡献。
  经直通的 `events.off(name, listener)` 退订后,控制面同步丢弃该 (name, listener) 的全部退订句柄(总线按 Set 一次全移除),
  反复 on/off 不在控制面累积句柄与插件回调;插件仍持有的旧 Disposable 再 dispose 照旧转发到总线。
- MCP 工具回收:`revoke()` 经原 Disposable 注销本实例经 `app.mcp.register` 注册的全部工具(main 侧 stub 同步
  移除)—— 插件不保存返回的 Disposable(不经 `registerMcpTool` 收集)时,停用 / 热重载 / `onload` 抛错后工具不残留,
  再次启用注册同名工具不会命中 `TOOL_NAME_TAKEN`。
- 查询结果中的回调(终审 P1):插件缓存 `app.commands.get('terminal.new')!.fn` 后停用再调用,会绕过 `execute` 的吊销检查。
  scoped app 对外的查询结果是浅拷贝(共享注册表原对象不改),函数字段换成带吊销检查的包装:未吊销透明调用原函数,吊销后
  抛 `PERMISSION_DENIED`、原函数不执行。包装按原引用缓存,同一快照返回同一结果(引用稳定)。
- 带权限门的能力在授权读取 `await` 前后各查一次吊销状态:授权读取期间被吊销,返回后也不放行。
- main 侧 `killPluginShellProcesses` 兜底仍在(回收已登记的进程);本条是在源头拒绝新请求。

### 1b. onload 挂起不得绕过禁用 / 卸载(`PluginManager` / `Plugin._activate` / `plugin-reload-gate.ts`)

插件在 `onload` 起定时器 / shell 后 await 永不结束的 Promise → 激活一直持有生命周期锁、init 一直不完成;禁用 / 卸载
排在锁后或被 reload-gate 缓冲,且 `entry.scoped` 要等 `onload` 返回才写入,无法提前吊销。

- 激活在执行插件代码(构造 / `onload`)**之前**就把 scoped 控制面挂到 entry,并备好中止。
- `PluginManager.revokeImmediately(id)`(同步、锁外、幂等):吊销当前 scoped app、中止挂起的激活等待(`_activate`
  不再等 `onload`,按 `onload` 抛错同样收尾,迟到结果吞掉),激活落到 `disabled`(非 failed)、锁随之释放,排队的锁内
  停用 / 卸载照常执行。激活挂起或 init 未完成时立即 `killPluginShellProcesses(id)`;正常运行的实例锁空闲,进程终止
  仍在 `onunload` 之后(让插件先自行收尾)。
- 调用点:本地 `disable` / `uninstall`(进锁前);`markUninstalled`(卸载广播,含 init 前);reload-gate 收到
  `enabled=false` 广播时立即调用(不受 init 缓冲影响),`enabledChanged` 仍按缓冲规则排队。
- 激活进行中(授权弹窗 / import / token 注册 await 期间)被要求吊销 → 不加载 / 不构造实例。
- 本地禁用:有启用意图但无实例(激活被中止)仍停用并落盘 `enabled=false`(否则下次启动复活)。

### 1c. 激活早期的禁用 / 卸载(`PluginManager` / `plugin-reload-gate.ts`)

- init 期间尚无 entry 的插件收到禁用(终审 P1):init 读完启用快照后逐个激活,前一个插件挂在授权弹窗上时,后面的插件
  尚未写入 entries;其禁用广播此前只被 reload-gate 缓冲 → init 仍按旧快照 import 并激活。`revokeImmediately` 记下
  停用意图(见 1d,不要求 entry 已存在);init 建 entry 时据此按 `disabled` 建 entry、不 import / 不构造。
  reload-gate 收到 `enabled=true` 广播时立即调用 `markEnabled(id)` 清除意图(之后按快照照常激活)。
  两阶段 init 后(见 plugin-manager「扫描完成信号」):后面的插件已登记 entry 但尚未激活;激活循环在锁内、激活前
  重新检查停用意图,存在 → 落 `disabled`、不 import / 不构造(语义同上)。
- 模块顶层 await 永不结束(终审 P1):中止句柄在开始 import **之前**就挂到 entry,import 与中止 `Promise.race`。禁用 /
  卸载 → 管理器停止等待 import,激活按禁用收尾、释放生命周期锁,排队的停用 / 卸载照常完成(落盘 `enabled=false`)。
  import 无法真正取消:迟到完成的结果被丢弃,不构造实例。不设固定超时。

### 1d. 停用意图:热重载不得绕过禁用 / 卸载(`PluginManager.deactivationIntents` / `plugin-reload-gate.ts`)

终审 P1:旧实例 `onunload` 挂起期间(热重载正在拆旧实例)点禁用 / 卸载,此前只在 `activating` 时记中止、只吊销旧 scoped
app → 重载随后建全新 scoped app 并激活,新实例继续持有 shell / 网络 / fs 写能力(新实例 `onload` 挂起时禁用 / 卸载永远
排不上)。init 期间排队的 reload 先于缓冲的禁用执行,按旧启用意图重新激活。

- per-id **停用意图**(`'disabled' | 'uninstalled'`)是唯一机制,取代此前三套标记(已卸载 id 集合 / 激活中的
  `revokeRequested` / init 期间尚无 entry 的禁用标记)。
- 写入:禁用 / 卸载**请求到达时同步**写入 —— 本地 `disable` / `uninstall` 进锁前;禁用广播(`revokeImmediately`)、卸载广播
  (`markUninstalled`)经 reload-gate 立即调用。不依赖 entry 是否存在 / 是否激活中,不等生命周期锁 / init。
  `'uninstalled'` 不被 `'disabled'` 覆盖。
- 检查:所有激活路径(init、本地启用、热重载、`enabled=true` 广播)在导入模块 / 构造实例**之前**检查(激活开头及每个
  await 之后);存在 → 不激活,落 `disabled`(卸载为 `NOT_INSTALLED`);热重载只拆旧实例、刷新源码 / manifest 快照。
  排队的禁用 / 卸载随后照常完成并落盘。激活**不**清除意图。
- 清除:只有显式启用 —— 本地 `enable(id)` 调用时(进锁前,同步)、`enabled=true` 广播到达时(`markEnabled`)。
  `'uninstalled'` 不被启用清除;本地卸载失败(entry 仍在)时降为 `'disabled'`,用户可重新启用。
- reload-gate:init 完成前收到卸载 → 丢弃该插件待处理的 reload。收到禁用**不丢弃**:reload 按意图不激活,只刷新快照
  (插件源码以 Blob 快照保存,丢弃会让之后的显式启用加载旧源码)。
- 已知取舍:本地禁用后立即本地启用,若本窗口自身的 `enabled=false` 广播晚于启用点击到达,会重新记下意图 → 这次启用
  按禁用收尾(偏安全方向;再次启用即可)。

### 2. 跨窗口启停(`electron/main/ipc/plugins.ipc.ts` / preload / `PluginManager.handleEnabledChanged`)

- `plugins:mutate-enabled` 写入 `_enabled.json` 成功后,经 `broadcastToWindows` 向所有窗口(含发起者)推
  `plugins:enabled-changed { id, enabled }`;写入失败不广播。
- preload `plugins.onEnabledChanged(cb)`:payload 守卫 `isPluginEnabledChangedPayload`(id 约束同
  `isPluginsChangedPayload` + `enabled` 为 boolean),畸形 warn + drop。
- `wirePluginReloadGate` 订阅并交给 `PluginManager.handleEnabledChanged(id, enabled)`;init 完成前到达的先缓冲
  (同 id 以最后一次为准),init 完成后再处理。
- `handleEnabledChanged`(生命周期锁内,**不写盘**,幂等):
  - `enabled=false`:与本地禁用相同的停用(吊销 / 注销贡献点 / 回收 token / 终止 shell 进程),状态 `disabled`,
    清启用意图(之后热重载不复活)。已是 disabled → 无操作。
  - `enabled=true`:与本地启用相同的激活(权限门按已授权放行;不清拒绝项),已 enabled → 无操作。
  - 本窗口不认识的 id(本窗口启动后才安装)→ 忽略,沿用「重载窗口后生效」。

### 3. 撤销 mcp-tools(`PluginMcpRegistry` / scoped app / `PluginManager.handlePermissionsChanged`)

- 兜底:`PluginMcpRegistry.register(spec, pluginId, authorize?)`;scoped app 传入的 `authorize` 在**每次调用**
  分发到 `run` 前重查(已吊销 / 未授权 → `PERMISSION_DENIED`,`run` 不执行)。
- 列表准确:收到 `plugins:permissions-changed { id }` → 失效权限缓存后调用
  `PluginManager.handlePermissionsChanged(id)` → `recheckMcpPermission()`:已无 `mcp-tools` 授权则经原
  Disposable 注销该实例全部工具(main 侧 stub 同步移除);之后插件停用再 dispose 为幂等 no-op。仍授权 → 不动。

### 4. 撤销 fs(`electron/main/ipc/plugins.ipc.ts` 的 MUTATE_PLUGIN_PERMISSIONS / `plugin-fs.ipc.ts` 的 `revokePluginPathScopes`)

plugin-fs 主进程不看 `fs` 权限项(只靠 renderer 的 `ensurePerm`),路径授权记在 `PathScopeRegistry` 与
`_plugin-path-scopes.json`。此前只有卸载 / 注销才撤 scope:权限编辑里撤销 `fs` 再勾上,以前批准的所有路径不经弹窗直接
恢复(request-scope 命中 `covers()` 静默授予;重启后从磁盘水合同样恢复)。

- 任何把 `fs` 置为拒绝的权限变更(权限编辑保存、权限弹窗拒绝等,统一经 `mutatePluginPermissions` 的 `set`/`granted:false`)
  成功后,main 撤销该插件全部内存 scope(并标记本会话「已水合(空)」,在途 / 之后的水合读不把旧 scope 写回)、删除
  `_plugin-path-scopes.json` 里该插件的条目。持久化失败如实报错(权限项本身已撤销)。
- 之后重新授予 `fs`,再访问原路径须重新弹窗。其它插件的 scope、撤销其它权限项、plugin-fs token 均不受影响。
- 撤销时该插件(任一窗口 / 实例,经 `IdentityRegistry.tokensFor` 枚举)正挂着的 scope 弹窗一并结算为取消
  (`correlator.cancelByToken`):renderer 收到 `plugin-fs:scope-request-cancelled` 撤掉弹窗,请求方得到 `deny`(不记入
  拒绝冷却),之后点「授权」送不到。此前弹窗留着,用户一点「授权」scope 照样落地并写回 `_plugin-path-scopes.json`。
- 还没走到弹窗的在途请求(撤销落在归一化 / 水合读盘 / 冷却键的 await 间隙):request-scope 开始时记下
  `PathScopeRegistry.revocationEpoch(pluginId)`(revokeAll 次数),弹窗前与落地前比对,变了即 `deny`、不弹窗、不落地。
- 撤销与「用户点授权」交错(撤销写 `_permissions.json` 期间用户点了挂起弹窗的「授权」):清盘走与授权持久化同一把
  同 id 锁(`persistPluginPathScopesIfInstalled`,FIFO),排在已带旧快照入队的持久化之后 → 最终盘上无该插件条目;
  重新授予 `fs` 并「重启」后再请求原路径仍弹窗。清盘时插件已被卸载(NOT_INSTALLED)视为已清。
- 水合对照 `_permissions.json`(纵深):冷启动水合前读权限记录,该插件当前未持有 `fs` 授权 → 不水合任何 scope(请求照常
  弹窗),并在同 id 锁内清掉盘上残留;权限文件读失败 → 按空水合(fail-closed)。持有 `fs` 授权 → 照常水合、已批准路径
  不弹窗。主进程 request-scope / plugin-fs 运行时不另查 `fs` 授权:内存 scope 只来自用户在弹窗中的授予或经上述对照的
  水合,撤销路径清内存。

## 规范文件

- `deactivate-revoke.spec.ts`:revoke 后各能力拒绝且不发 IPC、不阻断项照常;授权等待期间被吊销;PluginManager
  停用后延迟回调 / onunload 超时后继续执行 / onunload 内同步调用 / 激活失败后的延迟回调均被拒。
- `contribution-revoke.spec.ts`:吊销前直接注册的各注册表贡献 / `events.on` / `subscribe` 在 revoke 时注销;吊销后
  register / on / subscribe / emit / clear 抛 `PERMISSION_DENIED`、execute reject;只读成员与 `events.off` 照常;
  PluginManager 停用后延迟回调注册 / 执行命令被拒、停用前直接注册的命令被移除。
- `query-callback-revoke.spec.ts`:get / getAll / list / getBySide 等返回的回调吊销前透明、吊销后拒绝;各注册表覆盖;
  原对象不变、引用稳定;PluginManager 停用后缓存的 `terminal.new` fn 被拒、终端未创建。
- `activation-hang-revoke.spec.ts`:onload 挂起期间别窗禁用 / 卸载广播(init 未完成)与本地禁用 → 立即吊销(shell.exec
  被拒、不发 IPC)、立即终止进程,随后状态落 disabled / entry 移除;init 挂起时本地禁用落盘 `enabled=false`。
- `activation-early-revoke.spec.ts`:init 中前一个插件挂在授权弹窗上时收到插件 B 的禁用广播 → B 不 import、落
  disabled;随后的 enabled=true 广播清除标记;import 挂起时本地禁用 / 别窗禁用 / 本地卸载均完成、锁释放,import 迟到
  完成不构造实例。
- `reload-deactivation-intent.spec.ts`:热重载拆旧实例(`onunload` 挂起)期间本地禁用 / 别窗禁用 / 本地卸载 → 不构造新
  实例、`shell.exec` 被拒、禁用落盘 / 卸载删目录;init 期间文件变化排队 reload 后别窗禁用 / 卸载 → 不重新激活;显式启用
  (本地 / `enabled=true` 广播)后正常激活。
- `enabled-main-broadcast.spec.ts`:main 广播(成功才广播、跳过已销毁窗口)与 payload 守卫。
- `enabled-renderer-sync.spec.ts`:A 禁用 → B 停用、命令注销、不写盘、热重载不复活;发起窗口幂等;A 启用 → B
  激活(不弹窗、不写盘);未知 id 忽略;reload-gate 接线与 init 前缓冲。
- `fs-permission-revoke-scopes.spec.ts`:授予 scope → 撤销 fs → 重新授予 fs → 原路径重新弹窗;持久化条目删除、其它插件不受影响;
  撤销后本会话不再水合;撤销其它权限项不动 scope;撤销与「授权」交错后盘上不残留、「重启」后仍弹窗;水合对照 fs 授权
  (未授权不水合并清残留、已授权照常水合)。
- `mcp-permission-revoke.spec.ts`:撤销后调用被拒;变更通知后注销工具(stub 移除)、调用 NO_SUCH_TOOL;仍授权保留;
  直接 `app.mcp.register` 不保存 Disposable → 停用 / 热重载 / onload 抛错后工具注销,再启用同名注册成功。

## 调用方 signal 合并不残留监听(终审 P1)

- `network.fetch` 用 `AbortSignal.any([调用方 signal, 本实例 controller])`:停用照常中止在途请求、成功后调用方
  abort 仍能中止响应体读取;源 signal 对合并 signal 只持弱引用,插件长期复用同一 signal 轮询不再堆积 abort 监听。
