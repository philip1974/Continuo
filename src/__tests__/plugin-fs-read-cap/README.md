# plugin-fs-read-cap (E28 + E29 + E30 + E31)

边界审计 E28-E31(外部输入边界族,plugin-fs 是 Explorer fs 的平行入口 / 插件直传 IPC payload 须校验)。
E30:list-dir 条目数硬上限(opendir 惰性迭代 + FS_DIR_TOO_LARGE);E31:request-scope 入口校验
(scopes 数量/路径长度/mode 枚举,超限抛 BAD_INPUT,不进 canonicalize/弹窗/持久化)。

## 行为

`plugin-fs:read-file` 是 Explorer `fs:read-file` 的平行入口。已授权插件读文件时,主进程
不得无上限整块读入超大文件再经 IPC 回 renderer(内存峰值/卡死)。

- 普通文件 → 正常返回 utf-8 内容。
- 文件超 64MiB(与主 `fs:read-file` E18 同上限)→ 读前 `stat.size` 拦截,抛
  `FS_FILE_TOO_LARGE`,不整文件读入内存。
- 读目标是目录 → 抛 `FS_NOT_FILE`(复用主 read-file 的目录守卫)。

## write 侧(E29,E13 平行入口)

`plugin-fs:write-file` 的 `content` 此前无大小上限直接进 `atomicWriteFile`。已授权插件可经单次
IPC 发超大字符串 → 主进程内存峰值 + 超大临时文件 + fsync/rename 阻塞。

- 正常 content → 正常写入。
- content 超 64MiB(复用主 `fs:write-file` 的 `MAX_WRITE_BYTES`)→ 进 `atomicWriteFile`
  前抛 `FS_FILE_TOO_LARGE`,不落盘。

## 实现

`plugin-fs:read-file` handler 复用 `electron/main/ipc/fs/read-file.ts` 的 `readFile`
(单一来源:stat.size 上限 + FS_FILE_TOO_LARGE + 目录守卫 + errno 映射);`plugin-fs:write-file`
复用 `electron/main/ipc/fs.ipc.ts` 导出的 `MAX_WRITE_BYTES`,content.length 超限即抛
FS_FILE_TOO_LARGE。与 `write-file` 复用 `atomicWriteFile`(R4)同手法 —— Explorer fs 的每项保护
都要传播到 plugin-fs 平行入口。

## 并发上限(内存峰值)

单次读取有上限,但并发数此前没有:插件 `Promise.all` 几十个大文件读取即可把主进程撑大数 GB(审计实测 96 个并发
30MB 文件 RSS +3.5GB;read-file 32 并发 +1.6GB)。

- `plugin-fs:read-file` / `plugin-fs:read-for-editor`(插件 `editor.openFile`)/ `plugin-fs:list-dir` /
  `plugin-fs:read-git-blob` 共用一个全局闸:同时在途至多 `PLUGIN_FS_HEAVY_READ_CONCURRENCY`(4)个,其余排队,最终都完成。
- 名额按插件(pluginId;同一插件多窗口 / 多实例共享,多开窗口不放大):每插件在途 + 排队至多
  `PLUGIN_FS_HEAVY_READ_PER_PLUGIN_MAX`(64)个,超出只有该插件的新请求立即以 `FS_BUSY` 拒绝(read-for-editor 以结果
  对象返回,`editor.openFile` 映射为 `EXCEPTION`);被拒的请求不占名额。
- 放行顺序在插件之间轮转:有空位时从下一个有排队的插件取一个(插件内按到达顺序)。一个插件的长队不挡别的插件 ——
  此前是一条全局队列,一个插件保持上千个排队读取,其它插件的 readFile / listDir / editor.openFile 全部 `FS_BUSY`
  (审计实测 8 秒 147 次全拒;修复后同场景全部成功,中位延迟约等于一次大文件读取)。
- 全局排队上限 `PLUGIN_FS_HEAVY_READ_QUEUE_MAX`(1024)保留作总量兜底:所有插件合计在途 + 排队到顶后,任何插件的新
  请求都 `FS_BUSY`。
- 嵌套顺序:先取闸、再取 plugin-fs 读写锁的共享锁。排队者不持锁,独占写者只等在途的至多 4 个读取,不会被整条
  队列饿死;写者不取闸,不会成环。
- 不经此闸:`stat` / `lstat` / `realpath` / `check-path`(结果常数大小);变更类调用持独占锁本就串行(`cp` 经
  copyFile 在内核里复制);宿主自己的 `fs:read-file`(用户编辑器)—— 插件占满闸不影响用户打开文件。
- 残余:要 16 个以上各自占满名额的插件才会触到全局上限;被拒后忙等重试的插件消耗主进程 CPU(拒绝本身是常数
  开销);`plugin-fs:write-file` 的 content 在 IPC 反序列化时就已进入主进程内存,排队等独占锁期间仍占着 —— 不在 handler
  层能挡的范围内。

`read-concurrency.spec.ts`:40 个并发 readFile 在途峰值 = 4 且全部按内容完成;三个入口共用同一个闸;该插件名额满后
read-file / list-dir / read-git-blob 抛 `FS_BUSY`、read-for-editor 返回 `FS_BUSY` 结果,放行后恢复;闸满时 stat
照常;与独占写交错:只放行在途的 4 个,写者即完成,其余排队读取随后完成;多个插件合计到全局上限后任何插件都 `FS_BUSY`。

`read-fairness.spec.ts`:插件 A 占满名额 → A(含它在另一窗口的实例)的新请求 `FS_BUSY`,插件 B 的 readFile / listDir /
editor.openFile 不被拒,并在 A 在途的 4 个读完后立即轮到;两个插件各 30 个排队 → 在途 ≤ 4,放行顺序 A/B 严格交替。
