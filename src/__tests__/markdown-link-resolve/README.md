# Markdown 链接解析(`resolveLink`)

行为契约:**给一个 markdown 内 link 的 href + 当前文件绝对路径,
判定它该走哪条路径**:打开同 workspace 下另一文件、还是用系统默认
app 打开外链、还是不可解析(返回 null)。

## 模块

| 文件 | 职责 |
|---|---|
| `src/panels/Editor/link-resolve.ts` | 纯函数 `resolveLink(href, currentFilePath)` |
| `src/panels/Editor/MilkdownEditor.tsx` | Cmd/Ctrl+click on `<a>` 时调用方 |
| `src/panels/Editor/EditorPanel.tsx` | 把 resolved target 路由到 openFileByPath / coApi.shell.openExternal |

## 关键行为

### external — 已知 protocol(http/https/mailto/file)

走 system default app(浏览器 / 邮件客户端 / Finder),走 `coApi.shell.openExternal`。

### file — 相对 / 绝对路径

绝对(`/abs/x.md`)直接用;相对(`./x.md` / `../sib/y.md` / `x.md`)以
`currentFilePath` 所在目录为基底拼接。`#section` 后部切掉(IDE 不处理
markdown 内锚点跳转,只到文件)。`../` `./` 标准 normalize。

### null — 不可解析 / 不安全

- 纯锚点 `#section`(本文档内导航,IDE 不接管)
- 未知 / 不安全 scheme(如 `javascript:`、`tel:`、自定义 `myapp://`)
- 相对路径但 `currentFilePath = null`(无 base,放弃)
- 空 href
