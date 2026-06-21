# protocol-url(co:// 路由)

行为契约:**外部 `co://command/<id>?...` URL 进入 Continuo 时,解析并**仅当 id 在
core allowlist 内**才 dispatch 到 `commands.execute`**;不合法 URL / 不存在 command /
**不在 allowlist** → console.warn,不抛(避免外部输入崩 Continuo)。

> 安全 S5(codex 安全审计):co:// 是跨应用边界入口(恶意网页/README 链接点击 → OS 协议
> → 执行)。旧实现对任意 command id 无门控直接执行,而第三方插件经 `commands.register`
> 注册到同一注册表 → 外部链接可触发插件 fs/shell/network 命令。修复:默认禁止深链执行
> 任意命令,只放行 core `EXTERNALLY_INVOKABLE_COMMANDS`(默认空,插件无法修改)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/plugins/protocol/handler.ts` | parseProtocolUrl + handleProtocolUrl |

## 关键行为

### parseProtocolUrl(url)

- `co://command/sample.hello?foo=1` → `{ action: 'command', target: 'sample.hello', params: { foo: '1' } }`
- 非 `lm:` 协议 → null
- 缺 host / pathname → null
- URL 解析失败 → null

### handleProtocolUrl(url, app, allowlist?)

- action='command' 且 target ∈ allowlist → `app.commands.execute(target)`
- **安全 S5**:action='command' 但 target ∉ allowlist → 拒绝不执行 + console.warn
- 默认 allowlist = `EXTERNALLY_INVOKABLE_COMMANDS`(空)→ 所有深链命令默认被拒
- 不支持的 action → console.warn 跳过
- command 不存在 / fn 抛错(allowlist 内)→ console.warn 跳过
- URL 解析失败 → console.warn 跳过
- 永不抛(防外部 URL 闹翻 Continuo)
