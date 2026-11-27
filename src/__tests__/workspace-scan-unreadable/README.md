# workspace-scan-unreadable(工作区里有读不了的目录:搜索 / ⌘P 跳过并提示)

行为契约:工作区里只要有一个读不了的子目录(`chmod 000`、无执行权限、路径超过系统上限等),全局搜索(⇧⌘F)与
Quick Open(⌘P)**不再整体失败**,而是跳过该目录、照常给出其余结果,并提示「已跳过 N 个无法读取的目录」。

对齐 VSCode:搜索走 ripgrep,读不了的目录 / 文件只写进输出通道(`rgErrorMsgForDisplay` 只把正则 / glob / 编码类错误
报给用户),其余结果照常显示。Continuo 额外给一条计数提示(三语,合成一条不逐个刷屏),免得用户误以为文件不存在。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/ipc/fs/list-dir.ts` | `scanDir`:递归时子目录 opendir / 读取 / 子项 lstat 失败 → 跳过该子树并计数;根失败照旧抛;`listDir` = `scanDir().entries` |
| `electron/main/search/text-search.ts` | 枚举用 `scanDir`,summary 带 `skippedUnreadableDirs`;单个文件读失败只跳过该文件 |
| `fs:scan-files`(`fs.ipc.ts` / preload `fs.scanFiles`) | Quick Open 专用:同 list-dir 选项,data = `{ entries, skippedDirs }` |
| `src/plugins/quick-open/walk-files.ts` / `QuickOpenModal.tsx` | 结果带 `skippedDirs`,列表下方 role=status 提示 |
| `src/panels/Search/search-store.ts` / `SearchPanel.tsx` | done 事件 `skippedUnreadableDirs` → 状态行追加提示 |

## 关键行为

### 扫描(main)
- 子目录 `chmod 000` → 其余文件照常列出,`skippedDirs` 计 1;被丢弃子树里已计入的文件不占 maxFiles 名额。
- 路径超过系统上限(macOS 1024 字节)的深层目录 → 同样跳过计数(不再「文件 I/O 错误」整体失败)。
- 根目录本身读不了 → 照旧抛 `FS_DENIED`(资源管理器 / 搜索显示失败)。
- 总条目超硬上限 `FS_DIR_TOO_LARGE` 仍整体抛(滥用 backstop 不因跳过而失效)。

### 资源管理器(单层列目录)
- 目录有读权限、无执行权限(如 644):能读出名字但逐项 lstat 全部 EACCES。旧实现当「边读边删」逐项跳过 → 展开后显示为空;
  现在按读取失败抛 `FS_DENIED`,资源管理器显示与其它读取失败目录相同的错误行。

### 在文件中查找
- 结果照常给出;状态行追加「已跳过 N 个无法读取的目录」(N > 0 时)。
- 单个文件读失败(EACCES / EISDIR / ELOOP / ENAMETOOLONG / FIFO 等)只跳过该文件,不计入目录提示。

### Quick Open
- 列表照常;下方 role=status 提示「已跳过 N 个无法读取的目录」(与「只搜索了前 N 个文件」同一区域)。

## 不在本主题
- 读文件的上限 / 二进制判定:`workspace-search`。
- 资源管理器读取失败行的样式与重试:既有 Explorer 主题。
