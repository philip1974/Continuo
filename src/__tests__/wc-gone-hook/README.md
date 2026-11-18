# wc-gone-hook · 何时回收 webContents 名下的 main 侧资源

- `destroyed`:始终回收。
- 主框架、非同文档的 `did-start-navigation`:**仅当目标 URL 是本应用 renderer 入口**(reload / HMR 整页刷新 /
  `webContents.reload()`)时回收。main 启动时经 `setReloadUrlPredicate(isOwnRendererUrl)` 注入判定。
- 外链导航(拖入 URL、漏网的 `<a href>` 点击)会在随后的 `will-navigate` 被导航守卫 preventDefault 拦下,文档
  未被替换 —— 不得回收(否则 fs watcher / 插件身份 token / 插件 MCP 工具 / 插件子进程被误回收,旧页面收不到通知)。
- hash / pushState(同文档)导航不回收。
