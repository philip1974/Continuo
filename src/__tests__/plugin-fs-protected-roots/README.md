# plugin-fs-protected-roots(应用自身的数据 / 程序目录对插件不可达,与已授 path-scope 无关)

## 背景

path-scope 判定是纯前缀匹配,此前不排除应用自己的 `userData`。用户给插件授了包含它的宽 scope(如 `~`)后,
只有 `fs` 权限的插件经 SDK 正常调用即可:

- `app.fs.writeFile('<userData>/plugins/_permissions.json', …)` 给自己追加 `shell` 授权 → 下次启动生效,
  自提权到「完全访问」;
- 写 `_plugin-path-scopes.json` 给自己加 `/` 的 rw scope;
- 改写另一个已有 `shell` 权限插件的 `main.js`,借其权限执行;
- 只读 scope 也能读其它插件的 `data.json`(可能含 token)、`explorer.json`、`hook-events` 等。

## 受保护根

主进程启动时由 `electron/main/ipc/plugin-fs.ipc.ts` 注入 `PathScopeRegistry`(`resolveProtectedRoots`,
`electron/main/user-data-path.ts`):

| 根 | 说明 |
|---|---|
| 本实例的 `app.getPath('userData')` | 含 e2e 的 `--user-data-dir`、用户自定义位置 |
| `<appData>/Continuo` 与 `<appData>/Continuo Dev` | 两种发行形态的默认 userData 都列入:dev 实例里的插件不能改 packaged 实例的权限文件,反之亦然 |
| 打包版的 `process.resourcesPath` 与安装目录 | macOS 是整个 `.app` 包,其它平台是 resources 的上级目录;dev 下不加(那是仓库里的 `node_modules/electron`) |

每条根同时按「词法绝对形」与「realpath 形」比较(根尚不存在时解析最近的已存在上级)。macOS / Windows 上比较
忽略大小写与 Unicode 规范化形式(写类操作的叶子名不经 realpath,保留插件的写法);macOS 上还登记数据卷别名
(`/System/Volumes/Data/Users/…` 与 `/Users/…` 是同一目录,而 realpath 不归一这两种写法)。空串 / 相对路径 /
文件系统根不构成受保护根。

## 行为

- **受保护根之内(含根本身)**:`readFile / writeFile / listDir / stat / lstat / realpath / mkdir / rename / rm /
  cp(源与目标)/ atomicReplaceWithinScope / readGitBlob / checkPath(→ `editor.openFile`)` 一律拒绝,
  与已授 scope 无关。错误与 scope 外路径是同一条(`target not in any granted scope`),不暴露「这是受保护目录」;
  原因(插件、操作、路径)只进主进程日志。
- 词法上就在受保护根内的路径不碰文件系统即拒绝 —— 其下存在 / 不存在的路径得到完全相同的错误。
- **经符号链接**:scope 内指向受保护根内的链接,读类操作 realpath 后落在受保护根内 → 拒;写类 / 不跟随叶子的
  操作按「父目录 realpath + 叶子名」判定。删除 / lstat 链接本身不受影响(作用在链接,不是目标)。
- **受保护根的祖先**(如 `~/Library`、`~/Library/Application Support`):会连带删除 / 移走 / 复制整棵受保护
  子树的操作被拒 —— `rm`、`rename`(源或目标)、`cp`(源或目标)、`atomicReplaceWithinScope`(staging 或
  final)、`writeFile`。只读地看祖先(`stat / lstat / listDir / realpath / checkPath`)与 `mkdir`(对已存在
  目录是 no-op)照常;`listDir` 父目录能看到 `Continuo` 这个条目名。
- **requestScope**:
  - 请求里有任何一条的根位于受保护根之内(或就是受保护根)→ 整个请求直接 `deny`,不弹窗、不计入节流,
    也不会被已有的更宽授权静默覆盖成 `grant`;
  - 请求**包含**受保护根的更宽目录(如 `~`)→ 照常弹窗与授予(用户的意图是授予 home),受保护子树仍不可达。
    弹窗文案不变(不提示「不包括 Continuo 自身的数据目录」)。
- 旧会话已持久化的 scope(水合自 `_plugin-path-scopes.json`)同样受约束,无需迁移。
- 受保护根之外(同一 scope 内)的路径行为不变;名字只是以受保护根为前缀的兄弟目录(`Continuo Devtools`)不受影响。

## 行为收紧

- 插件不能再经 `app.fs` 访问自己的安装目录(`<userData>/plugins/<id>/`);插件数据走 `loadData / saveData`。
- 工作区根本身位于受保护根之内时(把 userData 当工作区打开),插件对它的 `requestScope` 直接被拒。

## 残余

- 有 `shell` 权限的插件可运行任意命令,仍能直接改这些文件 —— 与「shell = 完全访问」一致。
- 另一发行形态的 userData 只按默认位置保护;它若被用户放到别处(自定义 `--user-data-dir`),本实例不知道。
  本实例自己的 userData 无论在哪都受保护。
- 受保护根在启动时确定:启动后才出现、且经符号链接指到别处的根,只按启动时算出的路径保护。
- 指向受保护文件的**硬链接**(须由 SDK 之外的手段事先建在 scope 内)不被识别:可经它读到内容;写入走
  「临时文件 + rename」替换的是链接这个名字,不会改到原文件。
- 比较按路径字符串(realpath 后),不是按 inode。realpath 不归一的其它文件系统级别名未覆盖:Windows 的 8.3 短名
  作叶子(`…\Roaming\CONTIN~1`,只有 dev 形态的 `Continuo Dev` 有短名)、`subst` 盘符 / UNC 写法,Linux 的
  bind mount。除 8.3 短名外都要求 scope 宽到覆盖别名所在的另一棵目录树。
- 日志目录(macOS `~/Library/Logs/Continuo`)等 userData 之外的应用文件不在受保护根内。

## 规范

- `protected-roots.spec.ts` —— 真实 IPC handler + 真实 `PathScopeRegistry` + 真实临时目录:端到端提权复现、
  每个入口、符号链接、祖先、requestScope、大小写变体、尚不存在的根。
- `ipc-wiring.spec.ts` —— `registerPluginFsIpc` 实际注入了本实例与两种发行形态的 userData。
- `electron/main/__tests__/user-data-path.test.ts` —— `resolveProtectedRoots` 各平台 / 发行形态的清单。
