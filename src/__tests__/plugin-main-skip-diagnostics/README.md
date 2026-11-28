# plugin-main-skip-diagnostics

插件 main 入口不可用(入口名非法 / 文件缺失或经链接指向插件目录外 / 不是普通文件 / 超大 / 无法打开)时,该插件不可激活。
`LIST_DIRS` 把它带结构化原因返回、renderer 显示为无效插件行(见 `plugin-dev-experience/`);主进程内部的 `listPluginDirs(baseDir)`
默认仍不含它。为便于排障:

- 每种原因都在主进程记一条告警,含原因与插件目录(此前只有「超大」有日志)。
- 按「目录 + 原因」只记一次:每次列举都会重新判定,不刷屏(去重只影响日志 —— 修好入口后下一次列举 / watcher 周期即列出)。

另:启动时还原被崩溃中断的插件更新失败(rename 报 EBUSY / EPERM / EACCES)同样记告警,含 backup 与目标路径。
