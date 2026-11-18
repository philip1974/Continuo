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

### 叶子按磁盘上的真实名字判定(文件系统折叠 ≠ JS 折叠)

不跟随叶子的操作(`writeFile / mkdir / rename / rm / lstat / cp` 的目标 / `atomicReplaceWithinScope`)按
「父目录 realpath + 插件给的叶子名」判定,而上面的「忽略大小写」只是 JS 的 `NFC + toLowerCase`。大小写不敏感的
文件系统折得更多:APFS 上长 s `ſ`(U+017F)≡ `s`,`~/Library/Application ſupport` 就是
`~/Library/Application Support`;连字、`ß` 等同理。此前插件换这种写法即可把受保护根的祖先整棵改名移走,
在新位置随意读写(偷其它插件数据、改 `_permissions.json` 自提权),再移回或删光。

不枚举字符 —— 让文件系统报出叶子的真实名字再判一次(与原有的词法形判定并列,任一命中即拒):

| 叶子 | 取真实名字的办法 |
|---|---|
| 存在、不是符号链接 | 整条路径 realpath,最后一段即磁盘上的名字 |
| 存在、是符号链接(操作作用在链接本身,不能跟随) | 在父目录里按 dev/ino 找到它的条目名(有条目与叶子逐字相同则直接认定);扫描超过 10 000 条或找不到 → 拒绝(fail-closed) |
| 不存在 | 不可能是现有条目的别名;但新建它可能抢占受保护根(或其尚不存在的上级)应在位置上的名字 —— 与那一段名字做更保守的折叠比较(NFKC + 大小写往返 + 去掉默认可忽略码位),相等即拒 |

**只在父目录是某条受保护根的祖先时才做**(父目录已 realpath,名字是真的;不在祖先链上时叶子不可能是受保护根
或其祖先)。所以只有直接位于 `~`、`~/Library`、`~/Library/Application Support` 这类目录下的条目多一次
`lstat` + `realpath`;其它目录的写操作不多任何文件系统调用,链接叶子的目录扫描也只发生在这些目录里。
Linux(默认大小写敏感,比较本就不折叠)不做,行为不变。

校验与操作在 plugin-fs 的同一次持锁内完成(全局读写锁),只经 SDK 的插件无法在两步之间改名。

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
- 比较按路径字符串(realpath 后),不是按 inode。realpath 不归一的其它文件系统级别名未覆盖:Windows 的
  `subst` 盘符 / UNC 写法,Linux 的 bind mount —— 都要求 scope 宽到覆盖别名所在的另一棵目录树。
- Windows 的 8.3 短名作叶子(`…\Roaming\CONTIN~1`):写类 / 不跟随叶子的操作本就拒绝任何含 `~` 的叶子名
  (`leafNameRejectReason`),读类整条 realpath 会还原成长名;「叶子按真实名字判定」对存在的叶子同样会把短名
  还原。按代码推断已覆盖,**未在 Windows 实测**(包括 Windows 上 `lstat` 的 dev/ino 是否足以在目录里认出链接条目
  —— 认不出时是 fail-closed 拒绝,不会放行)。
- 「叶子按真实名字判定」的边界:
  - 只管 plugin-fs 自己的调用。校验与操作之间由外部进程(有 `shell` 权限的插件、用户自己的程序)改名不在此列。
  - 尚不存在的受保护根:保守折叠不保证与每种文件系统的折叠表逐字一致(如 NTFS 的 `$UpCase` 对个别字符的映射、
    土耳其语带点 `İ`)。默认的 `Continuo` / `Continuo Dev` 与 `Application Support` / `AppData\Roaming` /
    `.config` 都是纯 ASCII、且祖先在正常系统上已存在,只有自定义 userData 路径里含此类字符、且该路径尚未被
    创建时才有缝。
  - Linux 上开了 casefold 的目录(ext4 `+F`)、挂载的大小写不敏感卷:比较不折叠,也不解析真实名字(同此前)。
  - 受保护根祖先目录里条目极多(> 10 000)时,对其中**符号链接**条目用「非磁盘原名」的写法做
    `rm / rename / lstat` 会被拒(用磁盘上的原名通常也要扫到它才放行,扫描按目录顺序,超限即拒)。
- 日志目录(macOS `~/Library/Logs/Continuo`)等 userData 之外的应用文件不在受保护根内。

## 规范

- `protected-roots.spec.ts` —— 真实 IPC handler + 真实 `PathScopeRegistry` + 真实临时目录:端到端提权复现、
  每个入口、符号链接、祖先、requestScope、大小写变体、尚不存在的根;长 s 变体(审计复现的五步链、各入口、
  受保护根本身、符号链接叶子、扫描超限 fail-closed、抢先创建)、解析范围与开销、Linux 分支。
  长 s 用例在临时目录所在卷不折叠 `ſ` 时跳过(Linux CI)。
- `ipc-wiring.spec.ts` —— `registerPluginFsIpc` 实际注入了本实例与两种发行形态的 userData。
- `electron/main/__tests__/user-data-path.test.ts` —— `resolveProtectedRoots` 各平台 / 发行形态的清单。
