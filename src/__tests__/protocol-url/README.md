# protocol-url(co:// 路由)

行为契约:**外部 `co://command/<id>?...` URL 进入 Continuo 时,
解析并 dispatch 到对应 commands.execute**;不合法 URL / 不存在 command
→ console.warn,不抛(避免外部输入崩 Continuo)。

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

### handleProtocolUrl(url, app)

- action='command' → `app.commands.execute(target)`
- 不支持的 action → console.warn 跳过
- command 不存在 / fn 抛错 → console.warn 跳过
- URL 解析失败 → console.warn 跳过
- 永不抛(防外部 URL 闹翻 Continuo)
