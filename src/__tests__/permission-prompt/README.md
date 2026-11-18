# permission-prompt(授权 UI store + Modal + Manager 集成)

行为契约:**Plugin 激活前若有 permissions 请求,弹 design Modal 让用户勾选授予哪些权限**;
PromptFn 桥接到 store,Promise 形态返回。PluginManager 在 _activate 前调
`ensureAuthorized`,被拒 → 标 failed + 原因,不调 onload。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/permissions/promptStore.ts` | usePermissionPromptStore + request/grant/denyAll |
| `src/plugins/permissions/PermissionPrompt.tsx` | Modal UI |
| `src/plugins/PluginManager.ts`(扩展) | 接受 permissionStore + promptFn,activateEntry 前调 ensureAuthorized |

## 关键行为

### promptStore.request(pluginId, perms): Promise<PermissionKey[]>

- 设 pending = { pluginId, perms } + 内部存 resolve
- 同时只显示一个 pending;占用期间再 request → 排队(不结算),前一个 grant/deny 后依次弹出
  (此前直接 resolve [],被调用方当作「用户全拒」持久化 → 另一个插件的权限被静默永久拒绝)
- grant(perms) → resolve(perms) + 清 pending
- denyAll() → resolve([])
- close 等同 denyAll(用户关 Modal 视为拒绝)

### PermissionPrompt UI

- Modal,visible = pending !== null
- **防误触延迟**(`first-appearance-grant-guard.spec.tsx`;与 agent 授权弹窗共用 `src/lib/use-prompt-grant-guard.ts`)。
  弹窗出现的时机由插件决定(启用时的 manifest 权限、运行时的 `requestScope`),且会抢走键盘焦点;用户正在打字 / 点击时
  落进弹窗的按键 / 点击不能变成授予。manifest 弹窗与 fs-scope 弹窗一致:
  - 请求**出现**后 500ms 内,授予方向(「授权选中」/「授权」)的鼠标与键盘激活无效,弹窗保持。首次出现、落定后空闲一段
    时间再出现、排队切换(A 结算后直接换成 B)、弹窗类型切换(fs-scope↔manifest)都重新计时。
    延迟内被拒掉的激活把计时起点推到它自己的时刻;指针点击只认单击(`detail === 1`),双击的第二击不算。
  - 授予按钮的**键盘**激活另须是停顿后的有意按键(`keyboard-grant-guard.spec.tsx`):按钮已持续聚焦 ≥ 500ms、聚焦
    期间没打过字、这一下按键不是键重复且之前 500ms 内没有别的按键。Tab→Enter 的快速序列、打字流里的 Space / Enter
    不授予;Tab 到按钮、停顿半秒再按 Enter / Space 授予。输入流里的 Tab(紧跟别的按键 / 出现后 500ms 内 / 出现后
    打过字)带来的焦点不能用键盘授予(细则见 `agent-auth-prompt-throttle/`)。鼠标点击只受出现延迟约束。
  - Shift+Tab 不能从第一个可聚焦元素回绕到末尾的授予按钮(焦点留在原处;向前 Tab 仍可到达所有元素)。
  - 拒绝方向(「全部拒绝」/「拒绝」/ Esc / 点遮罩)首次出现时立即可用,不受键盘规则约束。
  - 初始焦点在拒绝按钮上(不在勾选框或授予按钮上);切换到下一个请求后焦点同样回到拒绝按钮。
- 排队 / 类型切换(显示中的请求直接换成另一个,不经空闲)后的 500ms 内,拒绝方向(拒绝 / Esc)也被忽略:新弹窗的按钮与
  旧弹窗在同一位置,对旧弹窗的连点 / 键重复不能把新请求拒掉(manifest 的拒绝会写盘)。
- 标题 "插件 <id> 请求权限"
- 每个 perm 一行 + checkbox;默认预选声明的权限,**`shell` 除外**(`shell-not-preselected.spec.tsx`):`shell` 等同于
  完全访问本机(以用户身份运行任意程序,不受文件夹授权限制),须用户**逐项主动勾选**才授予,不能随一次
  「授权选中」/「全选」顺手给出。未勾选即按未授予记录(部分授权),之后可在插件的权限编辑里再开启
- "全选" / "全部拒绝" / "确认授权选中" 三个按钮
- **「全选」与勾上勾选框也是授予方向**(`select-all-and-checkbox-guard.spec.tsx`):之后一次「授权选中」就带上它们。
  实测:出现后 50ms 点「全选」→ `shell` 被勾上;从「全部拒绝」Shift+Tab 到「全选」,Space 即全选。
  - 「全选」**不含 `shell`**(勾上其余全部;用户已手动勾选的 `shell` 保持)。请求里有 `shell` 时按钮文案写明
    「全选(不含 shell)」(`permissions.prompt.select_all_except_shell`),没有时仍是「全选」。
  - 「全选」与**勾上**勾选框(点勾选框、点该行文字、键盘 Space)受与授予按钮相同的守卫:出现延迟、只认单击、键盘须
    是停顿后的有意按键、输入流里的 Tab 带来的焦点无效。**取消勾选**是拒绝方向,立即可用。
  - 点权限行的文字不走浏览器的 label → 勾选框转发(转发出的 click 不带指针点击的 `detail`,会被当成键盘激活),
    由行自己按这次指针点击切换(权限编辑弹窗共用同一行组件,行为不变,只是点文字不再把焦点移到勾选框)。
  - Shift+Tab 的回绕拦截按弹窗里实际的第一个可聚焦元素(manifest 弹窗是第一个勾选框)判定。
- ESC / 遮罩点 → denyAll

### PluginManager 集成

- ManagerHost 增 optional `permissionStore` + `promptFn`
- activateEntry 流程:
  1. loadPluginModule(成功)
  2. **若 manifest.permissions 非空且 host 配 permissionStore + promptFn → 调 ensureAuthorized**
  3. 失败 → entry.status='failed', error='PERMISSION_DENIED: <list>',不 new instance
  4. 成功(或无 permissions / 无 host)→ new + _activate 原流程
- 缺 host 字段时:权限请求不被检查(向后兼容,测试用)

### 权限说明文案(`permission-copy-matches-capability.spec.ts`)

每行权限的说明(`permissions.perm.<perm>.desc`,en / zh / ko)须如实点明实际能力,用户据此决定是否授权:

- `shell`:以用户身份运行任意程序;**不受文件夹授权(fs scope)限制**,等同于完全访问本机文件与网络。
- `network`:向任意 https 地址发请求,**包括本机(localhost)与内网服务**(只放行 https,没有 WebSocket API)。
- `fs`:只能读写用户批准的文件夹(按文件夹另行弹窗询问)。
- `mcp-tools`:注册的工具名称与描述会展示给 AI agent,并可被其调用。
- `clipboard`:读写系统剪贴板。
