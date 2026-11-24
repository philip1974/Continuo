# plugin-fs-win-reparse-dirent(Windows 上 dirent 报 symlink 时按 lstat 判真实类型)

## 背景

Windows 上 libuv 对**任何** reparse point 都把 dirent 报成链接(DT_LINK),而 lstat 只把
SYMLINK / LX_SYMLINK / junction / APPEXECLINK 视为链接。OneDrive 按需文件、Dedup 等其它 reparse tag
在 lstat 下是普通文件 / 目录。宿主 Explorer 的 `listDir`(`electron/main/ipc/fs/list-dir.ts`)早已在
win32 上对这类 dirent 回退 lstat,插件侧两个兄弟入口没有:

- 插件 `app.fs.listDir`:OneDrive 同步目录里的普通目录被报成 `isDirectory:false, isSymlink:true`。
- 插件 `app.fs.readGitBlob`:pack 目录里带 reparse 标记的 `.pack` / `.idx` 被当成符号链接,
  报 `git repository not found within granted scope`。

## 行为

- 三处共用 `electron/main/lib/dirent-real-type.ts`:dirent 类型未知,或 win32 上报 symlink → lstat
  (不跟随链接)判真实类型;其它情况直接采信 dirent。
- 插件 `listDir`:win32 上 dirent 报 symlink 而 lstat 是目录 / 文件 → 报目录 / 文件;真符号链接在 lstat
  下仍是链接 → 仍报 `isSymlink:true`;lstat 失败(边读边删)→ 沿用 dirent 报的类型。
- `readGitBlob` 的 pack 目录检查:win32 上 dirent 报 symlink 而 lstat 是普通文件 → 放行;真符号链接
  → 仍拒;lstat 失败 → 拒(fail-closed)。scope 防护不因此削弱。
- 非 win32 平台行为不变。
