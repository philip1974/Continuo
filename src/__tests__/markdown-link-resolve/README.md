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
markdown 内锚点跳转,只到文件)。路径部分按 URL 规则做 percent-decode(`my%20notes.md` → `my notes.md`、
`%E4%B8%AD%E6%96%87.md` → `中文.md`);非法的 percent 序列保留原样。`../` `./` 标准 normalize。

### null — 不可解析 / 不安全

- 纯锚点 `#section`(本文档内导航,IDE 不接管)
- 未知 / 不安全 scheme(如 `javascript:`、`tel:`、自定义 `myapp://`)
- 相对路径但 `currentFilePath = null`(无 base,放弃)
- 空 href

## 点击链接不把应用窗口带走

Milkdown 视图里的 `<a>`(Markdown 链接、mermaid 图的 `click` 链接)被点击时,**永远不走浏览器默认导航**(否则整个应用窗口被导航到那个 URL):

- Edit 模式:普通点击只定位光标;Cmd/Ctrl+click 才交给 `resolveLink` 打开。链接气泡里显示的地址普通点击即打开。
- Preview 模式(只读):普通点击即打开(只读视图里点链接就是要跳转);Cmd/Ctrl+click 同样打开。
- mermaid 图里的链接是 SVG `<a xlink:href>`,与 HTML `<a href>` 同样处理。
- 主进程另有兜底:`installNavigationGuard` 拦下离开本应用 renderer 入口的主框架导航(见 `popout-contracts`)。
