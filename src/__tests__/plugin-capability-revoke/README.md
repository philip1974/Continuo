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
  | `network.fetch` | `PermissionError('network')` |
  | `fs` 写 / 扩权:`writeFile / mkdir / rename / rm / cp / atomicReplaceWithinScope / requestScope` | `PermissionError('fs')` |
  | `clipboard.readText / writeText` | `PermissionError('clipboard')`(读剪贴板是用户隐私,停用后的代码无正当用途) |
  | `mcp.register`;已注册工具的每次调用 | `PermissionError('mcp-tools')` |
  | `notifications.show` / `dock.openPanel` | 抛 `code: 'PERMISSION_DENIED'`(无对应权限项的 UI 副作用) |
  | 贡献点注册 / 订阅:`panels / commands / statusBar / ribbon / settingTabs / settingItems / explorerDecorators / editorActions / explorerContextMenu` 的 `register`、`subscribe`;`events.on` | 抛 `code: 'PERMISSION_DENIED'`,不入共享注册表 |
  | `editor.openFile` | 返回 `{ ok: false, code: 'PERMISSION_DENIED' }`(其契约返回结果对象不抛) |

  | 不阻断 | 理由 |
  | --- | --- |
  | `fs` 读:`readFile / listDir / stat / lstat / realpath / readGitBlob / userHome` | 无外部副作用,`onunload` 收尾可能要读;停用随即回收 plugin-fs token,之后 main 侧拒绝 |
  | `dataStore.read / write` | 插件自有数据,`onunload` 常用 `saveData` 落盘状态 |
  | `permission.check / granted` | 只读查询 |
  | 贡献点 / 事件的只读与执行成员:各注册表 `getAll / get / list / getBySide / getByCategory`、`commands.execute`、`events.emit / off / clear` | 不新增贡献;`onunload` 收尾可能要发事件 |
  | `version` / `workspace.getRoot` | 只读 |

- 贡献点回收:scoped app 对外暴露的注册表 / `events` 是 per-plugin 包装(底层仍是共享单例)。吊销**前**经
  scoped app 注册的贡献与订阅(无论是否经 `Plugin.register` 收集)由控制面记录,`revoke()` 时统一注销 ——
  插件绕过 `Plugin.register` 直接 `app.commands.register(...)` 的命令,停用后同样从注册表移除、快捷键失效。
  返回的句柄幂等;插件先自行 dispose 的不再重复注销,也不会误删他人后注册的同 id 贡献。
- 带权限门的能力在授权读取 `await` 前后各查一次吊销状态:授权读取期间被吊销,返回后也不放行。
- main 侧 `killPluginShellProcesses` 兜底仍在(回收已登记的进程);本条是在源头拒绝新请求。

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

## 规范文件

- `deactivate-revoke.spec.ts`:revoke 后各能力拒绝且不发 IPC、不阻断项照常;授权等待期间被吊销;PluginManager
  停用后延迟回调 / onunload 超时后继续执行 / onunload 内同步调用 / 激活失败后的延迟回调均被拒。
- `contribution-revoke.spec.ts`:吊销前直接注册的各注册表贡献 / `events.on` / `subscribe` 在 revoke 时注销;吊销后
  register / on / subscribe 抛 `PERMISSION_DENIED`;只读成员照常;PluginManager 停用后延迟回调注册命令被拒、
  停用前直接注册的命令被移除。
- `enabled-main-broadcast.spec.ts`:main 广播(成功才广播、跳过已销毁窗口)与 payload 守卫。
- `enabled-renderer-sync.spec.ts`:A 禁用 → B 停用、命令注销、不写盘、热重载不复活;发起窗口幂等;A 启用 → B
  激活(不弹窗、不写盘);未知 id 忽略;reload-gate 接线与 init 前缓冲。
- `mcp-permission-revoke.spec.ts`:撤销后调用被拒;变更通知后注销工具(stub 移除)、调用 NO_SUCH_TOOL;仍授权保留。
