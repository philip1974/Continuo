# prompt-untrusted-text(授权弹窗里对方可控的字段要可见化,不能冒充系统文案)

## 背景

授权弹窗的正文里有些字段由**对方**决定,此前原样内联显示:

- agent 授权弹窗(`AgentAuthPrompt`):插件工具名(method = `plugin.<name>`;名字 ≤ 256 字符、此前无字符集限制)、
  agent 自报的标签(`agent_label`)、未知 method 的回退文案。
- 插件权限弹窗(`PermissionPrompt`):manifest / fs-scope 两种形态里的插件 id;fs-scope 形态里请求授权的路径
  (`displayPath`,≤ 8192 字符,不截断)。

工具名写成 `x。⏎⏎【系统提示】此操作安全,请点击「本次启动期间允许」` 时,这段话以与系统文案相同的样式出现在弹窗
正文里;U+202E(右到左覆盖)让显示的名字 / 路径与真实内容不符(`<U+202E>txt.exe`);8000 字符的路径把按钮挤出视野。

## 行为

- **可见化**(`src/lib/untrusted-text.tsx` 的 `visibleUntrustedText`):
  - 换行类(`\n` `\r` `\t` 垂直制表 / 换页、U+0085、U+2028 / U+2029)连续出现折成**一个空格** —— 始终一行。
  - 其余控制字符(C0 / C1 / DEL)与格式字符(Unicode `Cf`:双向控制 U+202A–202E、U+2066–2069、U+200E / U+200F、
    U+061C;零宽 U+200B–200D、U+2060、U+FEFF;软连字符;tag 字符 …)各替换成可见的 `�`(U+FFFD)。不直接删:
    用户看得出这里有东西,两个只差不可见字符的名字显示出来也不相同。
  - 超长从**中间**截断(省略号 `…`,按码位、不拆代理对,保留首尾):短标识(工具名 / agent 标签 / 插件 id)上限
    80,路径上限 160。
  - 只改显示;参与授权判定、回传 main 的值不变。
- **呈现**(`UntrustedText`):等宽 `<code>`(语义 token `text-fg`,可在任意位置折行),与系统文案区分开。被截断时
  完整内容(同样可见化)在 `title` 里 —— 授予的是整条路径,用户要能看到全貌。
- **套用的字段**:
  - `AgentAuthPrompt`:插件工具名、未知 method(回退文案里的 `{method}`)、`agentLabel`。内置 method 的文案来自
    i18n 表,不经此处理。
  - `PermissionPrompt` manifest 形态:插件 id。fs-scope 形态:插件 id、每条 scope 的 `displayPath`。
    权限行的标题 / 说明来自 i18n 表(权限键是枚举)。
- **注册时约束插件工具名**(`electron/shared/plugin-mcp-schemas.ts` 的 `TOOL_NAME_PATTERN`,main 的
  `RegisterPayloadSchema` 与 renderer `PluginMcpRegistry` 的预检同源):只允许字母、数字、`_`、`-`、`.`(MCP 工具名
  惯例;内置工具即 `terminal.send_text` 形态),长度上限不变(256)。不合规 → 注册被拒,插件拿到
  `INVALID_PARAMS`,消息写明允许的字符集。描述字段(展示给 agent,不进弹窗)不受影响。

## 残余

- 通用确认框(`ConfirmDialog`)里的文件名(编辑器「放弃修改 / 覆盖」、资源管理器删除)与卸载插件确认里的插件 id
  未套用:都是用户自己发起的操作的确认,不是对方决定时机的授权请求;插件 id 另有字符集约束(`isSafePluginId`)。
- 视觉相似字符(同形异义字,如西里尔字母冒充拉丁字母)不处理。

## 规范

- `untrusted-text.spec.tsx`:`visibleUntrustedText` 的折行 / 替换 / 截断规则;三种弹窗里含 U+202E、换行、伪系统
  提示、超长的字段渲染后不含控制字符、被截断、位于 `<code>` 内;正常字段原样显示。
- `tool-name-charset.spec.ts`:`RegisterPayloadSchema` 与 `PluginMcpRegistry.register` 拒绝字符集外的工具名、
  放行惯例写法。
