# terminal-url-click

行为契约:terminal 中识别为 URL 的文本被修饰键单击(mac ⌘ / 其它 Ctrl,对齐 VSCode;无修饰键单击不打开,
见 terminal-vscode-parity)时,通过从 `@/lib/co-api` import
的 `coApi.shell.openExternal` 路由到系统默认浏览器。不直接 `window.open`(Electron
renderer 在 contextIsolation 下会吞掉)。

引用 issue #35。第一次修复错用了 `window.coApi?.shell.openExternal`
—— 但 `window.coApi` 根本不存在,真正的 API 在 module-local `coApi` Proxy(canonical
pattern,见 `src/panels/Editor/EditorPanel.tsx` 的 markdown 链接处理)。spec 反映
修正后的真实路径。

## OSC 8 超链接(`terminal-osc8-link.spec.ts`)

程序输出的 OSC 8 超链接(`ESC ] 8 ;; <uri> ST 文字 ESC ] 8 ;; ST`,显示文字可与地址完全不同)由 xterm 的 `linkHandler` 处理
(VSCode terminalLinkManager 同):

- 普通单击不打开,也不再弹 xterm 默认的英文原生 confirm(此前确定后也打不开);⌘ / Ctrl+单击走同一外链出口
  `coApi.shell.openExternal`(scheme 白名单 + 受信域名确认,见 `external-link-trusted-domains/`)
- 非 http(s) scheme 也交给出口判定(`allowNonHttpProtocols`):不允许的由出口拒绝并给失败提示,不被 xterm 静默吞掉
- 悬停:容器 title = 真实地址(不可见 / 双向控制字符可见化)+ 换行 +「⌘+单击打开链接」(VSCode:`[uri](uri) (cmd + click)`);离开清除
