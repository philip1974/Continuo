# terminal-url-click

行为契约:terminal 中识别为 URL 的文本被点击时,通过从 `@/lib/co-api` import
的 `coApi.shell.openExternal` 路由到系统默认浏览器。不直接 `window.open`(Electron
renderer 在 contextIsolation 下会吞掉)。

引用 issue #35。第一次 fix(commit da7e368)错用了 `window.coApi?.shell.openExternal`
—— 但 `window.coApi` 根本不存在,真正的 API 在 module-local `coApi` Proxy(canonical
pattern,见 `src/panels/Editor/EditorPanel.tsx` 的 markdown 链接处理)。spec 反映
修正后的真实路径。
