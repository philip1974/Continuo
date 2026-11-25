# workspace-search — 工作区文本搜索视图(在文件中查找 ⇧⌘F)

对齐 VSCode Search 视图(`workbench.view.search` / `workbench.action.findInFiles`,ripgrep 搜索服务):在当前窗口工作区根下
按文本 / 正则搜索,结果按文件分组,点击打开并定位。替换(Replace All)不做(见末节)。

## 行为契约

1. **入口**(`search-command.spec.ts`):命令 `workbench.action.findInFiles`「在文件中查找」(三语),默认键 `mod+shift+f`
   (mac ⇧⌘F,Windows / Linux Ctrl+Shift+F,同 VSCode),不与其它命令默认键冲突;出现在命令面板。执行 = 打开(或激活已有的)
   单例 dock 面板 `search`(未给 position → 主窗落点,活动组在 popout 子窗时也落在主窗,见 popout-open-target),并把焦点交给
   查询框、全选已有内容。焦点在编辑器且有**单行**非空选区 → 选区文本带入查询框(VSCode `search.seedWithNearestWord` 关闭时
   的默认:只带选区);多行选区 / 无选区 → 保留上次查询。面板也出现在 dock「⋯」菜单里(注册的面板类型)。
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
     (FIFO / 设备)、> 1 MiB(`SEARCH_MAX_FILE_BYTES`)、非 UTF-8 或含 NUL 字节(二进制)的文件跳过;不读 `.gitignore`
     (与 VSCode 默认 `search.useIgnoreFiles` 的偏离,见末节)。文件数上限 `SEARCH_MAX_FILES`,超出标记 `filesLimitHit`。
     因过大跳过的文件计数(`done.skippedLargeCount`)并报告路径(`done.skippedLargePaths`,至多
     `SEARCH_SKIPPED_LARGE_REPORT_MAX` 个;其它原因的跳过不计),供视图提示「已跳过 N 个大文件」。
   - 逐行匹配(`\r\n` / `\n`),每个命中一条结果:行号 / 列号 1 起(列按 UTF-16,与编辑器定位一致)、命中长度、预览行
     (去行首空白;命中前超过 `SEARCH_PREVIEW_LEAD` 个字符时从命中前 `SEARCH_PREVIEW_LEAD` 处截起并加「…」,预览最长
     `SEARCH_PREVIEW_MAX`)。零长度命中跳过。每文件最多 `SEARCH_MAX_RESULTS_PER_FILE`(1000)条(文件标记 `truncated`),
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
     匹配行 `treeitem`(`aria-level=2`;预览文本,命中用 `<mark>` 高亮 —— 复用 Quick Open 的 `PICKER_MATCH_CLASS_NAME`,
     `--md-list-highlight`,强制颜色下改下划线)。虚拟化渲染,`aria-activedescendant` 只指向已挂载行。
   - 键盘:查询框 ↓ 进入结果树;树内 ↑ / ↓ 移动、Home / End、→ 展开 / 进入首个匹配、← 折叠 / 回到文件行、Enter / Space
     打开当前匹配(文件行:切换折叠);F4 / ⇧F4(面板内)下一个 / 上一个结果并打开。打开 = `editor.openFile(path, { line, column, length })`
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
7. **未做**:替换 / 全部替换(跨文件写入需确认与可撤销,超出本轮);搜索历史;`.gitignore`;多行正则;搜索编辑器。

## 规范文件

- `search-query.spec.ts` — 2 / 3(正则构建、glob 语义)
- `search-engine.spec.ts` — 4 的搜索引擎(排除、跳过、限额、预览、分批)
- `search-ipc.spec.ts` — 4 的 IPC / 服务(窗口根、取消、事件转发、schema、preload 守卫)
- `search-view.spec.tsx` — 5
- `search-command.spec.ts` — 1
- `search-open-editors.spec.tsx` — 6(及 5 的跳过大文件 / 无结果时的范围提示)
