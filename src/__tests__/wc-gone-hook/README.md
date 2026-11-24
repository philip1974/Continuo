# wc-gone-hook · 何时回收 webContents 名下的 main 侧资源

- `destroyed`:始终回收。
- 主框架、非同文档、**浏览器侧发起**(`did-start-navigation` 的 `initiator` 为空)的 `did-start-navigation`:**仅当目标 URL
  是本应用 renderer 入口**(`webContents.reload()` / 菜单 View → Reload / main 的 `loadURL` / `loadFile`)时回收。main 启动时经
  `setReloadUrlPredicate(isOwnRendererUrl)` 注入 URL 判定。
- 页面发起的导航(`initiator` 为发起 frame:`location.reload()`、Vite HMR 整页刷新、`<a href>` 点击)会在随后的
  `will-frame-navigate` 被导航守卫 preventDefault 拦下(popout 子窗首次加载除外,那时还没有资源可回收),文档未被替换 ——
  不得回收(否则 fs watcher / 插件身份 token / 插件 MCP 工具 / 插件子进程被误回收,旧页面收不到通知)。
- 外链导航(拖入 URL 等无发起 frame 的情况)同样被守卫拦下:URL 判定不认,不回收。
- hash / pushState(同文档)导航不回收。
