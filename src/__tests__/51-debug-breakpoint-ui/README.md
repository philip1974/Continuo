# topic-51 debug breakpoint UI

本主题覆盖调试状态在 renderer 的可视化契约:

- `debug.store` 的断点按文件路径匹配到 CodeMirror tab 后,显示在独立 debug gutter。
- 最近 `stopped` 的 active session 位置按文件路径匹配到 CodeMirror tab 后,显示 exec-line。
- 路径匹配使用 `path-cross.pathEquals`,包含 Windows 大小写折叠语义。
- Markdown/Milkdown tab 不显示 debug 装饰,避免编辑/预览模式混入 CodeMirror 断点 UI。
- `continued`、`terminated`、session 消失、tab 关闭或关窗时必须清理旧 exec-line 与断点,防止陈旧装饰。
- debuggee 自然结束(DAP `terminated` / `exited`,含所有 child 都结束)时 main 立即向 renderer 发 `terminated`(只发一次;停住时被 kill、adapter 未先发 `continued` 也同样清掉停点),renderer 移除该会话(面板消失、执行行与红点清掉),不必等 disconnect / 关窗 / 名额满回收。MCP 侧会话仍保留到 teardown(`debug_list_sessions` 显示 `terminated`);`subscribe` 快照不含已结束会话(重载前后一致),之后不再推它的 `breakpoints-changed`(不把已移除的会话重新建出来);teardown 时再发的 `terminated` 对 renderer 是幂等空操作。
- Debug panel 使用 `@/design` 组件与 renderer i18n catalog,不写硬编码可见文案。空态(无会话 / 无栈帧 / 无变量 / 无断点)用
  design `EmptyState`(与 Output 面板同一空态);视图切换用 design `Tabs`(选中样式同设置页导航)。
- 会话标题显示会话名(VSCode 调用栈 / 调试工具栏同):main 在 `breakpoints-changed` / `stopped` 事件与 `subscribe` 快照里带
  `label`(launch 的 `name`,未给则被调试程序的文件名),`debug.store` 记为 `label`(之后不带 label 的事件不清掉;非字符串忽略);
  缺省时回退内部 sessionId。
- 源码位置(停点行、栈帧、断点)以「文件名:行号」为主,父目录弱化放其后并从前截断(design `TruncateStart`,保留靠近文件的
  目录),完整「路径:行号」在 title;路径未知显示「未知:行号」。
- `breakpoints-changed` 事件携带该 source(`file`)的完整断点集合(adapter 校正后的行号),`debug.store` 整组替换该文件的记录、其它文件保留:同文件多个断点同时显示,同一逻辑断点被重新校正到别的行时不留旧红点。
- Debug 事件同步(`startDebugStoreSync`)在 renderer 启动入口(`main-app` 的 `init()`,首次渲染前)开始,不依赖 Debug 面板挂载;重复调用幂等(只订阅一次);Debug 面板自身不再调用。main 按 owner window 只把事件发给本窗口。
- renderer 重载(Cmd+R)后恢复现有调试会话:`subscribe` 返回本窗口(按 owner window 过滤)会话的快照 —— 当前停点(stopSeq / reason;栈帧由 main 按当前停点的线程取)、按 source 的完整断点集合(每会话断点总数封顶 `DEBUG_VIEW_SNAPSHOT_BREAKPOINTS_MAX`,超限**最新优先**:文件按最后一次发事件先后排列,保留最近的;main 快照、renderer 事件累计 / 快照校验 / 快照与事件合并共用 `capGroupsNewestFirst`)。`debug.store` 据此初始化并拉取停点的栈帧 / 作用域,之后事件照常增量;快照送达前已收到事件的会话以事件为准(不改停点、只补缺的 source,补入的排在前,与 main 顺序一致),已结束的会话不复活。
- 拉取失败不静默(`fetch-failure-feedback.spec.tsx`):停下后取栈 / 作用域失败(`ok:false` 或 reject)按错误码本地化提示,但仅当会话仍停在发起拉取的那一停(`stopSeq` 未变)—— continue 或进入下一停后迟到的旧失败不提示;用户点「加载作用域」取变量失败同样提示、按钮恢复可点;所有失败路径都不产生未处理 rejection。
- 变量分页(`debug-view-get-variables.spec.ts`、`debug-store.spec.ts`、`debug-panel.spec.tsx`):`debug:getVariables` 收可选 `start`(非负整数,同 MCP `debug.variables` 的 `start`),每页条数仍走 `DEBUG_VARIABLE_COUNT_DEFAULT`,满页回 `truncated` + `next_start`。`debug.store` 按 reference 记 `next_start`(`variableNextStart`,随 `variableRefs` 在 stopped / continued 时清空);面板有下一页时在该作用域变量列表末尾显示「加载更多」,点击从 `next_start` 取下一页并追加进同一 reference 的缓存,取完即消失,不满页不显示。过期守卫同首页:发起后继续运行 / 进入下一停的迟到结果不回写、迟到失败不提示。
- 面板交互对齐 VSCode(`debug-panel-navigation.spec.tsx`):
  - 点栈帧 / 断点 → 经编辑器打开 API(`coApp.editor.openFile(path, { line })`,同插件 SDK)打开源码并定位到该行;打开失败按错误码本地化提示(`openFileOrNotify`),不静默;无源码路径的栈帧不可点。
  - 变量名 / 值超长截断时悬停(`title`)可看全文。
  - 变量列表是 WAI-ARIA 树(每个作用域一棵 `role="tree"`,节点 `role="treeitem"` + `aria-level`):`variables_reference > 0` 的对象变量可展开(`aria-expanded`),展开时按需加载子变量(`loadVariables(childRef)`,同一停内缓存);键盘 ↑↓ 移动焦点,→ 展开 / 进入第一个子节点,← 收起 / 回到父节点,Enter 切换。子节点同样支持「加载更多」。
  - 焦点(APG Tree View / VSCode 变量视图):roving tabindex —— 每棵树只有一个节点 `tabindex=0`,跟随焦点(Tab 离开再回来回到上次的节点;初始为第一个节点);收起父节点时若焦点记忆在其子孙上则回到该父节点。
  - 「加载更多」是树节点(`role="treeitem"`,与同级变量同 `aria-level`):↑↓ 可到达,Enter / 空格加载下一页,加载后焦点移到新加载的第一项;点击不冒泡成父节点的展开 / 收起。展开中、子变量尚未加载到的节点 `aria-busy="true"`(「加载中」只是视觉提示,不是树节点)。
  - 读屏播报(VSCode aria.status):经全局 `announce()`(`src/lib/announce`,`live-announcer`)写进主窗 / 有焦点 popout 子窗的常驻 polite 区域 —— 面板被 dockview 隐藏(DOM 不在文档)时照样播。每一停播一次「已暂停：原因，文件名:行」(`panels.debug.paused_at`,每次新节点,同位置同文本也会再读);位置随栈帧稍后才到时等位置到了再播,1 秒内没到(取栈失败)只播「已暂停：原因」(`common.label_detail`);继续运行后 `RUNNING_ANNOUNCE_DELAY_MS`(300ms)仍在运行才播「运行中」,期间新的一停到达即取消(连按单步不堆积);多个调试会话时前缀会话名(`会话名: …`);挂载时不播。
  - 停下原因按当前语言显示(徽章与播报共用 `STOP_REASON_KEYS` → `panels.debug.stop_reason.*`):DAP 规范列出的 step / breakpoint / exception / pause / entry / goto / function breakpoint / data breakpoint / instruction breakpoint 映射为本地化名称;未知原因(adapter 自定义)不露原始值 —— 徽章显示「已暂停」,播报为「已暂停：文件名:行」/「已暂停」。
  - 进入变量页自动加载第一个作用域(通常是 Locals,`expensive` 的除外),其余作用域仍点「加载」;已加载的作用域不再显示「加载」按钮,加载失败则保留按钮可重试。每一停重置展开状态与自动加载。
