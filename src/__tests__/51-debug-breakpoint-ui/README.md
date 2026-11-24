# topic-51 debug breakpoint UI

本主题覆盖调试状态在 renderer 的可视化契约:

- `debug.store` 的断点按文件路径匹配到 CodeMirror tab 后,显示在独立 debug gutter。
- 最近 `stopped` 的 active session 位置按文件路径匹配到 CodeMirror tab 后,显示 exec-line。
- 路径匹配使用 `path-cross.pathEquals`,包含 Windows 大小写折叠语义。
- Markdown/Milkdown tab 不显示 debug 装饰,避免编辑/预览模式混入 CodeMirror 断点 UI。
- `continued`、`terminated`、session 消失、tab 关闭或关窗时必须清理旧 exec-line 与断点,防止陈旧装饰。
- debuggee 自然结束(DAP `terminated` / `exited`,含所有 child 都结束)时 main 立即向 renderer 发 `terminated`(只发一次;停住时被 kill、adapter 未先发 `continued` 也同样清掉停点),renderer 移除该会话(面板消失、执行行与红点清掉),不必等 disconnect / 关窗 / 名额满回收。MCP 侧会话仍保留到 teardown(`debug_list_sessions` 显示 `terminated`);`subscribe` 快照不含已结束会话(重载前后一致),之后不再推它的 `breakpoints-changed`(不把已移除的会话重新建出来);teardown 时再发的 `terminated` 对 renderer 是幂等空操作。
- Debug panel 使用 `@/design` 组件与 renderer i18n catalog,不写硬编码可见文案。
- `breakpoints-changed` 事件携带该 source(`file`)的完整断点集合(adapter 校正后的行号),`debug.store` 整组替换该文件的记录、其它文件保留:同文件多个断点同时显示,同一逻辑断点被重新校正到别的行时不留旧红点。
- Debug 事件同步(`startDebugStoreSync`)在 renderer 启动入口(`main-app` 的 `init()`,首次渲染前)开始,不依赖 Debug 面板挂载;重复调用幂等(只订阅一次);Debug 面板自身不再调用。main 按 owner window 只把事件发给本窗口。
- renderer 重载(Cmd+R)后恢复现有调试会话:`subscribe` 返回本窗口(按 owner window 过滤)会话的快照 —— 当前停点(stopSeq / reason;栈帧由 main 按当前停点的线程取)、按 source 的完整断点集合(每会话断点总数封顶 `DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX`,超限**最新优先**:文件按最后一次发事件先后排列,保留最近的;main 快照、renderer 事件累计 / 快照校验 / 快照与事件合并共用 `capGroupsNewestFirst`)。`debug.store` 据此初始化并拉取停点的栈帧 / 作用域,之后事件照常增量;快照送达前已收到事件的会话以事件为准(不改停点、只补缺的 source,补入的排在前,与 main 顺序一致),已结束的会话不复活。
- 拉取失败不静默(`fetch-failure-feedback.spec.tsx`):停下后取栈 / 作用域失败(`ok:false` 或 reject)按错误码本地化提示,但仅当会话仍停在发起拉取的那一停(`stopSeq` 未变)—— continue 或进入下一停后迟到的旧失败不提示;用户点「加载作用域」取变量失败同样提示、按钮恢复可点;所有失败路径都不产生未处理 rejection。
- 变量分页(`debug-view-get-variables.spec.ts`、`debug-store.spec.ts`、`debug-panel.spec.tsx`):`debug:getVariables` 收可选 `start`(非负整数,同 MCP `debug.variables` 的 `start`),每页条数仍走 `DEBUG_VARIABLE_COUNT_DEFAULT`,满页回 `truncated` + `next_start`。`debug.store` 按 reference 记 `next_start`(`variableNextStart`,随 `variableRefs` 在 stopped / continued 时清空);面板有下一页时在该作用域变量列表末尾显示「加载更多」,点击从 `next_start` 取下一页并追加进同一 reference 的缓存,取完即消失,不满页不显示。过期守卫同首页:发起后继续运行 / 进入下一停的迟到结果不回写、迟到失败不提示。
