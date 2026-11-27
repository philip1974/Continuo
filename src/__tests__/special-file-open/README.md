# special-file-open(打开 FIFO / socket 等特殊文件)

行为契约:在资源管理器 / Quick Open 打开命名管道(FIFO)、Unix socket、设备文件时,统一提示「不是文件」(`FS_NOT_FILE`),
不再出现 FIFO 提示「不是文件」、socket 提示「文件 I/O 错误」的不一致。

- FIFO:`open(O_NONBLOCK)` 成功,fstat 判出非普通文件 → `EFTYPE` → `FS_NOT_FILE`(既有)。
- socket:`open` 本身失败(macOS `EOPNOTSUPP`,libuv 未映射成「Unknown system error -102」;Linux `ENXIO`)。
  `readFileCappedFd`(`electron/main/lib/read-fh-capped.ts`)对非常见 open 错误再 stat 一次,是 socket / FIFO / 设备 → `EFTYPE`。

参考:VSCode 对特殊文件没有专门分类,这里只统一 Continuo 自己的错误码,保证同类文件同一提示。
