# 外部文件同步的宿主(external-file-sync-owner)

- `useExternalFileSync` 由常驻的 `MainApp` 调用(每窗口一次),不放在懒加载的 `EditorPanel` 里。
- 原因:打开文件(store 已有 tab)到 Editor chunk 加载并挂载之间若文件被外部修改,订阅还不存在,
  该 `dir-changed` 事件永久丢失,tab 显示陈旧内容。启动遮罩(Splash)去掉最短展示时长后,这个窗口在
  e2e `save-shortcut`「外部修改 a.ts」中稳定暴露。
- hook 只依赖 editor store 与 `coApi.fs`,与 EditorPanel 是否挂载无关;popout 面板 portal 自同一 renderer,
  MainApp 仍是唯一宿主,不会重复订阅。
- 同步所需的 workspace root watcher(`useExternalSyncRootWatch`)同样由 `MainApp` 持有,不依赖 ExplorerSidebar
  挂载文件树:侧栏持久化为关闭时文件树从不挂载、不装 watcher,此前整个会话所有 tab 收不到外部修改。
