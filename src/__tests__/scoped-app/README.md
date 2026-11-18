# scoped-app(per-plugin CoApp 包装)

行为契约:**`createScopedApp(coApp, pluginId, store)` 返回每个 plugin 一份的
`CoPluginApp`,贡献点命名空间是只含公开方法的冻结外观(底层仍是 coApp 的共享注册表),fs/network/clipboard/
permission 是持 pluginId 的闭包。permission.check / granted 真读 store。**

> v5 Phase 1。fs/network/clipboard 当前直接转发 window.api / globalThis.fetch /
> navigator.clipboard,**未做权限检**;runtime gating 在 Phase 3 接入。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/scoped-app.ts` | createScopedApp + 5 个命名空间默认实现 |
| `src/plugins/types.ts`(扩展) | CoPluginApp / PluginFsApi / PluginNetworkApi / PluginClipboardApi / PluginPermissionApi / PluginShellApi |
| `src/plugins/permissions.ts`(扩展) | PermissionError class |

## 关键行为

### createScopedApp(coApp, pluginId, store)

- 返回新对象,逐字段显式构造(不展开 coApp);贡献点字段(panels/commands/...)见下文「贡献点命名空间是冻结外观」
- fs / network / clipboard / shell / permission 5 个新字段是新构造,持 pluginId
- 不复制 registry:两个 plugin 的 `app.commands` 是各自的外观,注册进同一个共享注册表

### permission.check(perm) / granted()

- store 为 null → check 一律返 true,granted 返 []
- store 非 null → 调 `store.get(pluginId)`,过滤 granted=true 的判定
- 异步(对齐 PermissionStore 接口)

### fs / network / clipboard(Phase 1 实现)

- 直接转发 window.api.fs / globalThis.fetch / navigator.clipboard
- IpcResult 拆包:ok=false 抛 Error 含 code 与 message
- jsdom 环境 window.api.fs 不存在 → 抛"未注入"

### network.fetch 只放行绝对 https: URL

- 打包版页面源是 file://,原生 fetch 可读 `file:///…`(相对路径也按页面 base 解析成 file:)。
  network 权限 ≠ 读本地文件:入口不带 base 解析 URL,仅 `https:` 通过
- `file:` / `blob:` / `data:` / `about:` / `ws(s):` / `http:` / 相对 / 协议相对 / 无法解析 → `BAD_INPUT`,不调 fetch
- 通过后以解析得到的绝对 href 发请求(校验与实际请求用同一个值)

### shell

- Phase 1 占位,空对象;接口稳定但无方法
- Phase 3 实装

### PermissionError

- `code = 'PERMISSION_DENIED'`(常量字面)
- `permission: PermissionKey` 暴露被拒的具体权限
- 默认 message `Permission denied: X`(i18n I11 改英文),可覆盖

### 贡献点 key 的所有权(`contribution-ownership.spec.ts`)

keyed 注册表(`panels`(key = `type`)/ `commands` / `statusBar` / `ribbon` / `settingTabs` / `settingItems` /
`editorActions` / `explorerContextMenu`(key = `id`))本身是同 key「后注册赢」。零权限插件据此可注册
settingTab `core.plugins`(替换插件与权限管理页)、panel `settings` / `terminal`(接管面板)、command
`terminal.new`(劫持内置命令与快捷键)。经 scoped app 注册时:

- key 已存在且**不是本插件注册的**(宿主直接注册 / 内置插件 / 其它插件)→ 抛 `code: 'PERMISSION_DENIED'`,
  不入表,原条目不变;被拒的插件停用时也不会删掉原条目
- 所有权检查与入表用**同一份 spec 快照**:scoped app 的 keyed `register` 先把 spec 浅拷贝并冻结(每个自有属性
  只读一次),key 字段写成 getter(首次返回诱饵、之后返回 `terminal`)不能让检查与入表看到不同的 key。
  注册表里存活的是这份冻结快照,不是插件传入的对象
- 快照里嵌套的数据字段是**深冻结拷贝**:`settingItems` 的 `enum` 数组及其中每个选项都拷贝并冻结(选项字段同样
  只读一次)。注册通过校验后,插件再改自己手里的数组 / 选项(把 `label` / `value` 换成对象或超长串、追加超出上限
  的选项)不影响入表的 spec。插件传入的数组与选项本身不被冻结;畸形 `enum`(非数组 / 选项不是对象)照旧由注册表
  校验报错。函数字段与 `icon`(ReactNode)保持引用
- 同一插件重复注册自己的 key(含重载后的新实例)→ 仍是后注册赢
- 所有者注销后,该 key 可被其它插件注册
- 所有者标识区分「宿主自建的 scoped app(内置插件,不带 plugin-fs token)」与「PluginManager 激活的第三方插件」:
  第三方插件把 manifest id 起成 `core.plugins` 也不能覆盖内置条目
- 宿主自身代码直接在注册表上注册(不经 scoped app)不受影响:后注册赢语义不变
- 抢注:第三方插件先注册了宿主尚未注册的 key,**内置插件**后注册同 key 时收回(内置的赢,记一条告警;被顶掉的插件
  条目按注销处理,插件手里的旧句柄与停用清理都不会删掉内置条目,也不能再夺回)。第三方之间、内置插件之间、
  内置插件对宿主直接注册的条目仍互不覆盖

### events.clear 只清本插件的订阅

- 总线的 `clear()` / `clear(name)` 会清掉宿主与其它插件的订阅;scoped app 的 `events.clear` 只退订本插件经
  `events.on` 订阅的(无参 = 本插件全部,带 name = 本插件在该事件上的)

### 贡献点命名空间是冻结外观(`facade-surface.spec.ts`)

插件拿到的 `app.<贡献点>` 不是注册表实例,也不是它的 Proxy,而是一个普通冻结对象(原型 `Object.prototype`),
自有属性只有 SDK 公开方法(`src/plugins/types.ts` 的 `Plugin*Api`):

| 命名空间 | 公开方法 |
|---|---|
| `panels` | `register` `get` `getAll` `list` `subscribe` |
| `commands` | `register` `get` `getAll` `execute` `subscribe` |
| `statusBar` | `register` `get` `getAll` `getBySide` `subscribe` |
| `settingItems` | `register` `get` `getAll` `getByCategory` `subscribe` |
| `ribbon` / `settingTabs` / `editorActions` / `explorerContextMenu` | `register` `get` `getAll` `subscribe` |
| `explorerDecorators` | `register` `getAll` `subscribe` |
| `events` | `on` `off` `emit` `clear` |
| `workspace` | `getRoot` |

- 注册表的内部字段(`items` / `listeners` / `hotkeyCounts` / `byName` / `fns`)、受保护方法(`registerKeyed`)都是
  `undefined`;`Object.getPrototypeOf` 拿到的是 `Object.prototype`,没有注册表类的原型方法可供 `.call`
- 方法是不读 `this` 的闭包:`app.commands.register.call(别的对象, spec)` 走的仍是本插件的校验 / 快照 / 所有权检查
- 外观与每个方法都冻结:插件不能改写;`workspace` 也是 per-plugin 冻结对象(宿主单例不外传)
- 吊销后同样拿不到内部对象;各方法按「停用即吊销」的既有语义拒绝或放行
- 查询结果不泄露内部对象:`get` 返回冻结的浅拷贝(函数字段包吊销检查,包装不可被写入属性),`getAll` / `list` /
  `getBySide` / `getByCategory` 返回冻结的新数组;`settingItems` 的 `enum` 及其选项是冻结拷贝
- 宿主自身代码直接用 `coApp` 的注册表实例,不经外观,不受影响

## 第三方插件执行宿主命令限次(审计 F4)

`commands.execute` 对第三方插件开放(SDK 没有限定可执行哪些命令),但宿主命令里有创建资源的:`window.new` 每开一个
窗口,新窗口会重新加载该插件 → 循环执行即指数开窗;`terminal.new` 每次起一个 shell。

- 第三方插件实例(带 plugin-fs token 的 scoped app,每窗口一份)执行**宿主命令**(所有者为 `core:` 或无所有者记录)
  在滑动窗口内限次:`HOST_COMMAND_RATE_WINDOW_MS`(10s)内至多 `HOST_COMMAND_RATE_LIMIT`(5)次,超出 reject
  `code: 'RATE_LIMITED'`,命令不执行。
- 经 `get` / `getAll` 拿到的宿主命令 `fn` 与 `execute` 共用同一个额度(不能绕过)。
- 插件自己 / 其它第三方插件注册的命令不受限;内置插件(无 token)不受限;额度按插件实例计。
- 主进程兜底:`window:create` 全局主窗口数上限(见 `window-ipc-create`),终端会话每窗口 64 / 全局 256(既有)。

`host-command-rate-limit.spec.ts`:真实 WindowPlugin + 真实 coApp,循环 100 次 `execute('window.new')` 只建窗 5 次
(修复前 100 次);get / getAll 的 fn 与 execute 共用额度;窗口过后恢复;自有命令与内置插件不受限;额度按实例计。
