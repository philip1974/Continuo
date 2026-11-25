# fs-adapter (M-Explorer Step 1)

行为契约:**主进程纯 fs 函数**。这一层不知道 IPC、不知道 Electron,只用 `node:fs/promises`,
方便单测直接 import 跑。Step 2 在 IPC handler 里把这些函数包成 safeHandle 即可。

对应 doc/08 § 接口契约 的 `FsApi`,以及 ADR-009(原子写)、R6(fs.watch 限制,本步骤不涉及)、R7(VSCode 风权限,无沙箱)。

## 模块拆分

| 文件 | 导出 | 职责 |
|---|---|---|
| `electron/main/ipc/fs/list-dir.ts` | `listDir` | 列目录 + 深度限制 + 排除黑名单 + symlink 处理 |
| `electron/main/ipc/fs/read-file.ts` | `readFile` | utf-8 读 |
| `electron/main/ipc/fs/atomic-write.ts` | `atomicWriteFile` | 固定 tmp + fsync + 一次 rename,同路径串行(ADR-009) |
| `electron/main/ipc/fs/rename.ts` | `renameEntry` | 同目录改 basename,返回新绝对路径 |
| `electron/main/ipc/fs/create.ts` | `createFile` / `createDir` | 拼路径 → 写空 / mkdir,返回新绝对路径 |
| `electron/shared/fs-entry.ts` | `FileEntry` 类型 | 主/渲染共享数据形状 |

## 关键行为

### listDir(absPath, opts?)
- `opts.maxDepth` 默认 1(只列当前层),传 >1 才递归
- 递归深度硬上限 `LIST_DIR_MAX_DEPTH = 32`(electron/shared/fs-limits.ts,main 与 Quick Open 共用),传 100 也截断到 32;只是递归兜底(不跟随 symlink 不会死循环,工作量由 maxFiles / 总条目上限约束)。旧值 10 会让 Quick Open 漏掉深层文件
- `opts.exclude` 默认 `['.git', '.svn', '.hg', 'node_modules', '.DS_Store', 'Thumbs.db']`
- 自定义 `exclude` 完全替换默认(传空数组 = 显式要看 `.git`)
- 不跟随符号链接:用 `lstat`,symlink 标 `isSymlink: true` 不递归
- `opts.withStats` 默认 true;false 时不回传 size/mtime/ctime,类型取自 dirent 不逐项 `lstat`(仅 dirent 类型未知、或 win32 上 dirent 报 symlink(libuv 把所有 reparse point 报成链接)时回退 `lstat`),结构字段与 true 逐项一致(Quick Open 用,见 `list-dir-without-stats.spec.ts`)
- 排序(借鉴 Lokus):**目录优先,再按 `localeCompare`**
- 路径不存在 → 抛 `code: 'FS_NOT_FOUND'`
- 路径是文件不是目录 → 抛 `code: 'FS_NOT_DIRECTORY'`
- 目录不可读(`opendir` 报 EACCES / EPERM,含递归时的子目录)→ 抛 `code: 'FS_DENIED'`(原始 errno 经
  `mapNodeErrnoCode` 映射,renderer 按码本地化,不显示 `EACCES: permission denied, opendir '<路径>'`)

### readFile(absPath)
- utf-8 字符串
- 不存在 → 抛 `FS_NOT_FOUND`
- 是目录 → 抛 `FS_NOT_FILE`
- 是 FIFO / socket / 设备,或符号链接指向它们 → **迅速**抛 `FS_NOT_FILE`:open 带 `O_NONBLOCK`(FIFO 无写端时
  阻塞 open 永不返回,会占满 libuv 线程池让主进程所有 fs.promises 挂死),open 后 fstat 非普通文件即拒
  (`read-file-fifo.spec.ts`;同族:插件列举 main 可用性探测同样不挂死)

### atomicWriteFile(absPath, content) — ADR-009
执行顺序(同一路径的写串行化):
1. 写同目录固定 tmp `.<base>.continuo.tmp`(`open('wx')`;残留的旧 tmp 先删再建)+ fsync(fd)
2. rename tmp → `path`(原子替换;leaf 为 symlink 时写穿到目标)

失败时回滚:
- 步骤 1 失败:删 tmp,原文件不动
- 步骤 2 失败:rename 不改动目标,原文件完好;删 tmp 后抛错
- 不做预备份(`.backup`):rename 本身就是原子替换,预备份反而留下「原文件已挪走、tmp 未就位」的丢失窗口
- 多次连续 write 不留残留

### renameEntry(oldAbsPath, newName) → string
- `newName` 是 basename(不含 `/` 或 `\`)
- 含分隔符或为 `.`/`..` → 抛 `FS_BAD_NAME`
- 同目录 rename
- 返回新绝对路径

### createFile(dirAbsPath, name) → string
- 拼出 `${dir}/${name}`
- `open(path, 'wx')` 原子排他创建空文件;已存在 → 抛 `FS_EEXIST`(防覆盖既有文件)
- 返回新 path

### createDir(parentAbsPath, name) → string
- 拼出 `${parent}/${name}`
- 已存在 → 抛 `FS_EEXIST`
- `mkdir`(non-recursive,父目录必须存在)
- 返回新 path

## 错误码约定(透传到 IpcResult.code)

| code | 场景 |
|---|---|
| `FS_NOT_FOUND` | 路径不存在 |
| `FS_NOT_DIRECTORY` | 期望目录,实际是文件 |
| `FS_NOT_FILE` | 期望文件,实际是目录 |
| `FS_EEXIST` | 创建时已存在 |
| `FS_BAD_NAME` | 不合法的名字(含 `/`、`.`、`..`) |
| `FS_DENIED` | OS 权限拒绝(EACCES) |
| `FS_NO_SPACE` | 磁盘空间不足(ENOSPC) |
| `FS_READONLY_FS` | 只读文件系统(EROFS) |
| `FS_READONLY` | 保存目标文件写保护(无写位 / 当前用户不可写),见 save-readonly-file |
| `FS_IO` | 其他 IO 错(EBUSY / ELOOP 等) |

异常对象形如 `Object.assign(new Error(msg), { code: 'FS_NOT_FOUND' })`,safeHandle 会透传 `code` 字段。

## 不在本主题验证

- IPC 注册(留 Step 2 `fs-ipc-bridge/`)
- `shell.trashItem`(需要 Electron 运行时,留 E2E)
- `fs.watch`(留 Step 6 `explorer-watch/`)
- 路径权限拒绝的真实 OS 行为(单测构造不出可靠的 EACCES 场景)
