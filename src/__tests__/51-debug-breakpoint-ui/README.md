# topic-51 debug breakpoint UI

本主题覆盖调试状态在 renderer 的可视化契约:

- `debug.store` 的断点按文件路径匹配到 CodeMirror tab 后,显示在独立 debug gutter。
- 最近 `stopped` 的 active session 位置按文件路径匹配到 CodeMirror tab 后,显示 exec-line。
- 路径匹配使用 `path-cross.pathEquals`,包含 Windows 大小写折叠语义。
- Markdown/Milkdown tab 不显示 debug 装饰,避免编辑/预览模式混入 CodeMirror 断点 UI。
- `continued`、`terminated`、session 消失、tab 关闭或关窗时必须清理旧 exec-line 与断点,防止陈旧装饰。
- Debug panel 使用 `@/design` 组件与 renderer i18n catalog,不写硬编码可见文案。
- `breakpoints-changed` 事件携带该 source(`file`)的完整断点集合(adapter 校正后的行号),`debug.store` 整组替换该文件的记录、其它文件保留:同文件多个断点同时显示,同一逻辑断点被重新校正到别的行时不留旧红点。
- Debug 事件同步(`startDebugStoreSync`)在 renderer 启动入口(`main-app` 的 `init()`,首次渲染前)开始,不依赖 Debug 面板挂载;重复调用幂等(只订阅一次);Debug 面板自身不再调用。main 按 owner window 只把事件发给本窗口。
- renderer 重载(Cmd+R)后恢复现有调试会话:`subscribe` 返回本窗口(按 owner window 过滤)会话的快照 —— 状态、当前停点(stopSeq / reason / threadId)、按 source 的完整断点集合(每会话断点总数封顶 `DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX`,main 截断、renderer 校验时同样截断)。`debug.store` 据此初始化并拉取停点的栈帧 / 作用域,之后事件照常增量;快照送达前已收到事件的会话以事件为准(不改停点、只补缺的 source),已结束的会话不复活。
