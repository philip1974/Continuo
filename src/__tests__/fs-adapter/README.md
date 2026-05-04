# fs-adapter (M-Explorer Step 1)

行为契约:**主进程纯 fs 函数**。这一层不知道 IPC、不知道 Electron,只用 `node:fs/promises`,
方便单测直接 import 跑。Step 2 在 IPC handler 里把这些函数包成 safeHandle 即可。

对应 doc/08 § 接口契约 的 `FsApi`,以及 ADR-009(原子写)、R6(fs.watch 限制,本步骤不涉及)、R7(VSCode 风权限,无沙箱)。

## 模块拆分

| 文件 | 导出 | 职责 |
|---|---|---|
| `electron/main/ipc/fs/path-utils.ts` | `normalizePath` | 绝对化 + 解析 ../,无 home 沙箱 |
| `electron/main/ipc/fs/list-dir.ts` | `listDir` | 列目录 + 深度限制 + 排除黑名单 + symlink 处理 |
| `electron/main/ipc/fs/read-file.ts` | `readFile` | utf-8 读 |
| `electron/main/ipc/fs/atomic-write.ts` | `atomicWriteFile` | temp + fsync + rename + backup cleanup(ADR-009) |
| `electron/main/ipc/fs/rename.ts` | `renameEntry` | 同目录改 basename,返回新绝对路径 |
| `electron/main/ipc/fs/remove.ts` | `removeEntry` | 硬删(trash 走系统回收站留 IPC 层调 shell.trashItem) |
| `electron/main/ipc/fs/create.ts` | `createFile` / `createDir` | 拼路径 → 写空 / mkdir,返回新绝对路径 |
| `electron/shared/fs-entry.ts` | `FileEntry` 类型 | 主/渲染共享数据形状 |

## 关键行为

### path-utils.normalizePath
- 相对路径 → 绝对路径(基于 `process.cwd()`)
- 解析 `..` 防遍历(`/a/b/../c` → `/a/c`)
- **不做** home 沙箱、敏感目录黑名单(VSCode 风,信任 OS 权限)

### listDir(absPath, opts?)
- `opts.maxDepth` 默认 1(只列当前层),传 >1 才递归
- `MAX_DEPTH_HARD_LIMIT = 10`,即便传 100 也截断到 10(防 symlink 死循环)
- `opts.exclude` 默认 `['.git', '.svn', '.hg', 'node_modules', '.DS_Store', 'Thumbs.db']`
- 自定义 `exclude` 完全替换默认(传空数组 = 显式要看 `.git`)
- `opts.followSymlinks` 默认 false:用 `lstat`,symlink 标 `isSymlink: true` 不递归
- 排序(借鉴 Lokus):**目录优先,再按 `localeCompare`**
- 路径不存在 → 抛 `code: 'FS_NOT_FOUND'`
- 路径是文件不是目录 → 抛 `code: 'FS_NOT_DIRECTORY'`

### readFile(absPath)
- utf-8 字符串
- 不存在 → 抛 `FS_NOT_FOUND`
- 是目录 → 抛 `FS_NOT_FILE`

### atomicWriteFile(absPath, content) — ADR-009
执行顺序:
1. 写 `${path}.tmp`
2. fsync(fd)
3. 若 path 已存在,rename `path` → `${path}.backup`
4. rename `${path}.tmp` → `path`(原子)
5. 删 `${path}.backup`

失败时回滚:
- 若步骤 4 之前失败,删 `.tmp`,**不动** path 与 `.backup`
- 若步骤 4 后失败,`.backup` 仍可被 cleanup 路径找到(留为 debug)
- 多次连续 write 不留残留

### renameEntry(oldAbsPath, newName) → string
- `newName` 是 basename(不含 `/` 或 `\`)
- 含分隔符或为 `.`/`..` → 抛 `FS_BAD_NAME`
- 同目录 rename
- 返回新绝对路径

### removeEntry(absPath)
- 走 `fs.rm(path, { recursive: true, force: false })`
- 不存在 → 抛 `FS_NOT_FOUND`(force: false 的语义)
- **trash 走系统回收站**由 IPC 层 `shell.trashItem` 单独实现,本函数只做硬删

### createFile(dirAbsPath, name) → string
- 拼出 `${dir}/${name}`
- 已存在 → 抛 `FS_EEXIST`(防覆盖既有文件)
- 调 atomicWriteFile(path, ''),返回新 path

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
| `FS_IO` | 其他 IO 错(ENOSPC / EBUSY 等) |

异常对象形如 `Object.assign(new Error(msg), { code: 'FS_NOT_FOUND' })`,safeHandle 会透传 `code` 字段。

## 不在本主题验证

- IPC 注册(留 Step 2 `fs-ipc-bridge/`)
- `shell.trashItem`(需要 Electron 运行时,留 E2E)
- `fs.watch`(留 Step 6 `explorer-watch/`)
- 路径权限拒绝的真实 OS 行为(单测构造不出可靠的 EACCES 场景)
