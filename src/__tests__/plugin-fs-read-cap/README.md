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
