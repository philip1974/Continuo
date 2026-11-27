# workspace-search — 工作区文本搜索视图(在文件中查找 ⇧⌘F)

对齐 VSCode Search 视图(`workbench.view.search` / `workbench.action.findInFiles`,ripgrep 搜索服务):在当前窗口工作区根下
按文本 / 正则搜索,结果按文件分组,点击打开并定位。替换(Replace All)不做(见末节)。

## 行为契约

1. **入口**(`search-command.spec.ts`):命令 `workbench.action.findInFiles`「在文件中查找」(三语),默认键 `mod+shift+f`
   (mac ⇧⌘F,Windows / Linux Ctrl+Shift+F,同 VSCode),不与其它命令默认键冲突;出现在命令面板。执行 = 打开(或激活已有的)
   单例 dock 面板 `search`(落点见 1a),并把焦点交给查询框、全选已有内容。焦点在编辑器且有**单行**非空选区 → 选区文本带入查询框(VSCode `search.seedWithNearestWord` 关闭时
   的默认:只带选区);多行选区 / 无选区 → 保留上次查询。面板也出现在 dock「⋯」菜单里(注册的面板类型)。
1a. **面板落点**(`search-panel-placement.spec.ts`;VSCode:搜索是侧栏视图,`openView` 打开在它所在的视图容器 —— 默认侧栏,
   用户拖到别处后在那里;编辑器永远不进侧栏):
   - **新建**(没有 search 面板)→ 主窗 dock 网格**最左侧的独立组**(全高,相当于 VSCode 侧栏位置;多个编辑器组 / 其它组时
     也在它们全部的左侧),初始宽 `SIDEBAR_DEFAULT_WIDTH`(280,同资源管理器侧栏默认宽);不再落进活动组与编辑器叠在一起
     (此前单组时点结果后组切回编辑器 tab,结果列表被盖住)。入口一致:命令 / ⇧⌘F、「查看 > 搜索」、组右上「⋯」→ 搜索
     (含 popout 子窗里的「⋯」)、调用该命令的其它入口;从 popout 子窗触发也建在主窗并激活主窗。
   - **已存在**(在任何组、浮动组或 popout 子窗)→ 只在其所在窗口激活并聚焦,不挪动;用户拖到别处的位置随 dock 布局持久化,
     重启后照旧,不被挪回。关闭后再打开(没有面板)→ 重新放回最左侧。
   - **侧栏组只放侧栏面板**:活动组是只含 search 面板的组时,从主窗入口新建的其它面板(补建编辑器面板 / 主窗没有编辑器组时
     新建的编辑器组、设置、输出、插件面板、没有终端可参照的新终端)不落进它 —— 改落主窗最近使用的其它组;主窗没有其它组 →
     在它右侧新建一组。点结果打开的文件落在编辑器组,搜索结果保持可见。用户经该组「⋯」菜单显式加入的面板照旧落在该组。
   - 「重置布局」:search 面板回到最左侧独立组(见 dock-reset-layout)。
   - **侧栏组保持自身宽度**(第五十二轮审计 A3 / B;VSCode 侧栏 `LayoutPriority.Low`、最小宽 170,窗口变窄时编辑区先缩到 220):
     主网格里全高的只含侧栏面板的组,在它旁边新建组(主窗只剩它时新开文件 / 终端)、窗口缩放、资源管理器侧栏开关后宽度不变,
     由其它组吸收;窗口窄到编辑区不足 220 时它才缩,最窄 170(组最小宽约束)。用户拖分隔条 / 双击等分改的宽被记住。dockview 6
     网格按比例布局、无每视图优先级,由 `keepSidePanelWidth` 在布局变化后校正(此前被劈成一半宽并随窗口按比例缩放,最窄到 100,
     选项按钮被裁掉)。查询框一行在窄宽下选项按钮(Aa / ab / .* / 详细信息)换到下一行靠右,不被裁。
2. **查询**(`search-query.spec.ts`):查询框 + 三个开关「使用正则表达式 / 区分大小写 / 全词匹配」(`aria-pressed`,成组)。
   字面量按字面匹配(元字符转义);全词按 VSCode `createRegExp` 规则在首 / 尾是单词字符时加 `\b`;不区分大小写加 `i`。
   正则模式下非法正则 → 不发起搜索,查询框 `aria-invalid`、提示「正则表达式无效」(`regexSyntaxError`,错误信息作 title)。
   查询长度截到 `MAX_SEARCH_QUERY_LEN`(`clampSearchQuery`)。
3. **包含 / 排除的文件**(`search-query.spec.ts`):「切换搜索详细信息」按钮(`aria-expanded`)展开两个 glob 输入,逗号分隔;
   语义同 VSCode:`./` 开头相对工作区根,否则在任意层级匹配(`src` ≡ `**/src` 与 `**/src/**`,`*.ts` ≡ `**/*.ts`);
   支持 `*` `**` `?` `{a,b}` `[...]`;路径分隔符统一按 `/`、大小写不敏感。包含为空 = 全部;排除优先于包含。
4. **main 端搜索**(`search-engine.spec.ts` / `search-ipc.spec.ts`):
   - 范围:只搜**发送窗口**的工作区根(main 按发送方窗口取根,renderer 不传根);无工作区 → 错误。
   - 文件枚举复用 fs:list-dir 的 walker(不跟随符号链接、深度上限 `LIST_DIR_MAX_DEPTH`),排除表与 Quick Open 同一来源
     (`WORKSPACE_SCAN_EXCLUDE`:`.git` / `node_modules` / `dist` / `out` / `build` / `.next` …);符号链接、非普通文件
     (FIFO / 设备)、> 1 MiB(`SEARCH_MAX_FILE_BYTES`,按磁盘字节)、含 NUL 的文件(二进制)跳过。编码(`search-bom-encoding.spec.ts`;
     VSCode 默认 `files.encoding=utf8` 时 ripgrep 按 BOM 嗅探):带 BOM 的 UTF-8 / UTF-16 LE / BE 按 BOM 可逆解码后搜(与编辑器打开
     同一解码实现),BOM 不计入列号 —— 行 / 列 / 预览与编辑器里(内容不含 BOM)一致,点击打开时 tab 自动识别为同一编码;BOM 后字节
     不可逆(奇数字节的 UTF-16、非法 UTF-8)的跳过;无 BOM 的须是合法 UTF-8,GBK 等(及无 BOM 的 UTF-16)不猜编码、跳过;遵从工作区内的
     `.gitignore` / `.ignore`(VSCode `search.useIgnoreFiles`,见 `search-ignore-files`)。文件数上限 `SEARCH_MAX_FILES`,超出标记 `filesLimitHit`。
     因过大跳过的文件计数(`done.skippedLargeCount`)并报告路径(`done.skippedLargePaths`,至多
     `SEARCH_SKIPPED_LARGE_REPORT_MAX` 个;其它原因的跳过不计 —— 过大的二进制(无 BOM、开头 8 KiB 含 NUL,ripgrep / git 同口径)
     先判二进制、静默跳过,同 VSCode),供视图提示「已跳过 N 个大文件」。
   - 逐行匹配(`\r\n` / `\n`),每个命中一条结果:行号 / 列号 1 起(列按 UTF-16,与编辑器定位一致)、命中长度、预览行
     (`search-preview.spec.ts`,VSCode `Match.preview`:命中前文 `lcut(before, 26, '…')` —— 去前导空白,超过
     `SEARCH_PREVIEW_LEAD`(26)个字符时在「保留至少 26 个字符」的最后一个词边界处截掉并加「…」;无词边界的长前文(整行 CJK /
     base64,截后仍超 `SEARCH_PREVIEW_BEFORE_MAX`)按码点硬截到末 26 个字符;前文 + 命中 + 后文总长封顶 `SEARCH_PREVIEW_MAX`;
     截点不拆代理对)。零长度命中跳过。每文件最多 `SEARCH_MAX_RESULTS_PER_FILE`(1000)条(文件标记 `truncated`),
     总计最多 `SEARCH_MAX_RESULTS`(10000)条(`limitHit`,停止搜索)。
   - 流式分批:命中文件攒批推送(`SEARCH_BATCH_MS` / 文件数),大工作区先出的结果先显示;结果顺序稳定(按枚举顺序)。
   - 执行在 worker 线程(VSCode 把 ripgrep 放在独立进程):用户正则的灾难性回溯不卡主进程;取消 = 终止 worker。
   - IPC:`search:start`(searchId + 查询)、`search:cancel`、推送 `search:event`(`files` / `done` / `error`,带 searchId)。
     同一 webContents 新查询取消旧查询;窗口关闭 / 重载 → 取消。入参 zod `.strict()` 限长(pattern / glob / searchId)。
     preload 对推送做形态守卫(畸形丢弃)。
5. **视图**(`search-view.spec.tsx`):
   - 输入后去抖 `SEARCH_DEBOUNCE_MS`(300ms,同 VSCode `search.searchOnTypeDebouncePeriod`)自动搜索,Enter 立即搜索;
     新查询发起前取消在途查询,迟到的旧 searchId 事件丢弃;查询清空 → 取消并清空结果。
   - 结果树 `role=tree`:文件行 `treeitem`(`aria-level=1`、`aria-expanded`;文件名 + 相对目录 + 匹配数徽标,超长时目录先收缩、
     再截断文件名,徽标始终可见),可折叠;
     匹配行 `treeitem`(`aria-level=2`;预览文本用 UI 比例字体(VSCode `.linematch` 不设等宽字体),一行放不下时先截后文、
     再从左侧截前文(省略号在左),命中词在默认侧栏宽度下始终可见(e2e `search-preview-visible`);命中用 `<mark>` 高亮 —— 复用 Quick Open 的 `PICKER_MATCH_CLASS_NAME`,
     `--md-list-highlight`,强制颜色下改下划线)。虚拟化渲染,`aria-activedescendant` 只指向已挂载行。
   - 键盘:查询框 ↓ 进入结果树;树内 ↑ / ↓ 移动、Home / End、PageDown / PageUp(先到可视区末 / 首行,再按可视行数翻页,不循环;VSCode `list.focusPageDown/Up`,共用 `src/lib/list-page-nav.ts`)、→ 展开 / 进入首个匹配、← 折叠 / 回到文件行、Enter / Space
     打开当前匹配(文件行:切换折叠);F4 / ⇧F4(面板内)下一个 / 上一个结果并以预览方式打开(VSCode pinned=false,见 editor-preview-tab)。打开 = `editor.openFile(path, { line, column, length })`
     (公共 API,打开失败统一提示):选中匹配范围(列 / 长度为 UTF-16,与 worker 同一单位);Markdown 编辑 / 预览模式同样定位并选中
     (见 `search-open-markdown`)。单击匹配行打开;单击文件行切换折叠。
   - 状态行(`role=status`,`aria-live=polite`):搜索中「正在搜索…」/「{files} 个文件中有 {results} 个结果」(三语单复数)/
     「未找到结果」/ 截断提示「结果过多,只显示了一部分。请缩小搜索范围」/ 文件数上限提示 / 「已跳过 N 个超过 1 MiB 的文件
     (在编辑器中打开后可搜索)」(三语单复数)/ 失败原因(本地化)。文件数上限与跳过大文件的提示在「未找到结果」时同样显示。
     未打开工作区 → 提示先打开文件夹,不发起搜索。
   - 设计系统:design `Input` / `IconButton`,语义 token;亮暗主题、窄宽(输入与开关在窄面板内换行不溢出)。
6. **已打开编辑器的内存内容**(`search-open-editors.spec.tsx`,`search-engine.spec.ts` 同口径一节;VSCode
   `searchService.getLocalResults`):工作区根下已打开的文本编辑器(图片标签除外)按编辑器 store 里的当前内容匹配 —— 含未保存
   修改、不受 `SEARCH_MAX_FILE_BYTES` 限制;与 worker 同一匹配实现 `matchSearchText`(逐行、UTF-16 列号、正则 / 大小写 /
   全词、每文件上限),同样受工作区排除表与包含 / 排除 glob 约束。发起搜索时即显示(排在磁盘结果前),main 推来的同一文件
   (相对路径按平台大小写策略比较)结果丢弃 —— 未保存修改删掉的命中不显示。内存 + 磁盘合并后总数仍最多 `SEARCH_MAX_RESULTS`
   (超出截断并标记 `limitHit`)。main 报告的跳过大文件中已打开的不计入提示。只读编辑器 store,不改它;搜索发起后编辑器
   继续修改不实时刷新结果(重新搜索即更新)。
7. **文件删除 / 改名 / 移动**(`search-path-gone.spec.ts`;VSCode `SearchView.onFilesChanged`:文件删除时移除其匹配,移动 =
   旧路径删除,新位置不自动补搜):订阅编辑器 store 的路径变更通知(`removePaths` / `renamePath` / `markPathsDeleted` —— 资源管理器删除 / 改名 /
   移动 / 撤销;已打开 tab 的外部删除确认,tab 保留并标记已删除),被删除或移走的文件(目录则其下全部,包含判断平台感知大小写、分隔符无关,
   同前缀兄弟目录不受影响)的结果从列表移除,计数、折叠集合、活动行一并修正,不再指向旧路径(点击报「找不到文件」)。
   取舍:外部程序删除**未打开**的结果文件不实时移除(只有已打开 tab 的外部删除经确认后发通知;未打开文件没有
   可复用的「已确认删除」通知,为此逐事件 stat 结果文件成本偏高),点击时照常提示打开失败,重新搜索即更新。
8. **搜索输入跨重启**(`search-input-restart.spec.ts`;VSCode SearchView 视图状态 `query.contentPattern` / `regex` /
   `caseSensitive` / `wholeWords` / `folderIncludes` / `folderExclusions` / `queryDetailsExpanded`):查询词、三个开关、包含 /
   排除、详情展开随 explorer.json 的**窗口段**(`windows[].search`,按窗口独立)持久化,写盘时机即窗口段既有的去抖写 / 关窗
   立即落盘(只在这些输入变化时标脏,结果流式更新不触发写);只写非默认项,全默认不写该字段(旧形态不变)。重启只恢复输入,
   **不自动重搜**,结果为空、状态行空白(VSCode 同:恢复后只在用户提交 / 改输入时搜索);恢复后工作区根变化也不触发搜索
   (还没搜过)。查询词上限 `SEARCH_PATTERN_MAX`、glob 上限 `SEARCH_GLOB_MAX`(与 search:start 入参同一常量,运行时输入已截到
   此上限);超限的快照按损坏处理(同其它字段)。旧数据无该字段 → 输入保持空。新开窗口(fresh)/ 别的窗口段不带入。
9. **未做**:替换 / 全部替换(跨文件写入需确认与可撤销,超出本轮);搜索历史;`.git/info/exclude` 与全局 gitignore;多行正则;搜索编辑器。

## 规范文件

- `search-query.spec.ts` — 2 / 3(正则构建、glob 语义)
- `search-engine.spec.ts` — 4 的搜索引擎(排除、跳过、限额、预览、分批)
- `search-bom-encoding.spec.ts` — 4 的编码(带 BOM 的 UTF-8 / UTF-16)及 6 的覆盖键对这些文件同样成立
- `search-ipc.spec.ts` — 4 的 IPC / 服务(窗口根、取消、事件转发、schema、preload 守卫)
- `search-view.spec.tsx` — 5
- `search-command.spec.ts` — 1
- `search-panel-placement.spec.ts` — 1a(含侧栏组保持宽度:新建组 / 窗口缩放 / 拖分隔条)
- `search-open-editors.spec.tsx` — 6(及 5 的跳过大文件 / 无结果时的范围提示)
- `search-path-gone.spec.ts` — 7
- `search-input-restart.spec.ts` — 8
