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

### 按 (dev, ino) 判定(文件系统认为相同、路径字符串认为不同)

上面的比较都在比路径字符串。同一个目录还可以有 realpath **不归一**的别的路径:macOS 根目录下内核合成的
`/.nofollow/<绝对路径>`(与 `<绝对路径>` 是同一个 inode,只是沿途不跟随符号链接)、数据卷 firmlink,Linux 的
bind mount,Windows 的 `subst` 盘符。scope 宽到覆盖别名所在的树(如 `/`)时,插件此前经
`/.nofollow/…/Continuo Dev/plugins/_permissions.json` 即可读写权限文件(自提权到 `shell`)、列插件目录、
`rm -r` / `rename` 整个 userData。

不再枚举别名 —— 每次校验在字符串判定之外,按 `(dev, ino)` 再判一次(`PathScopeRegistry.inodeDenial`):

| 判定 | 做法 |
|---|---|
| 之内(含根本身) | 解析后的路径(读:整条 realpath;其余:父目录 realpath + 叶子)的**各级字符串前缀**逐级 `stat`,任一级的 (dev, ino) 等于某条受保护根 → 拒 |
| 是受保护根的上级 | 目标自身(不跟随叶子的操作取链接本身)的 (dev, ino) 等于某条受保护根的某级上级目录 → 对会连带移动 / 删除 / 复制整棵子树的操作拒(同字符串判定的 opType 语义) |
| 受保护根尚不存在(没有 inode) | 目标的最近已存在上级就是该根的最近已存在上级(按 inode),且其下各段名字与根的各段保守折叠后相同 → 按「之内 / 上级」同样处理;标准写法另由字符串判定覆盖 |

依据(macOS 实测):路径解析必然依次经过各级前缀所指的目录,`stat(前缀)` 得到的就是途经的那个目录 ——
`/.nofollow/Users/x`、`/System/Volumes/Data/Users/x` 各级的 inode 与 `/Users/x` 各级相同;realpath 后途中没有
链接,所以这些前缀也就是目标在文件系统里的各级上级。不用 `<dir>/..` 逐级上溯(路径越拼越长,macOS `PATH_MAX`
只有 1024)。

受保护根一侧**每次校验现算**(不缓存:上级可被改名 / 替换,根可能启动后才出现):对每条根的词法形与(构造时的)
realpath 形 `lstat`(是链接再 `stat` 一次)。开销:

- 只看不动的操作(`readFile / stat / lstat / listDir / realpath / checkPath / mkdir`):目标路径级数 + 受保护根写法数
  次 `stat`(生产形态约 4~5 条根;路径 8 级时约 13 次,并行发出)。实测每次调用多约 0.1 ms(15 级深的路径)。
- 会连带整棵子树的操作(`rm / rename / cp / writeFile / atomicReplace`),以及目标尚不存在时:再加受保护根各写法的
  不同上级数(约 10 来次)。
- 没有受保护根的 registry 不做任何额外 `stat`;不新增 `realpath` / `readdir`。

某一级 `stat` 失败(权限等)就跳过那一级,不因此拒绝(字符串判定仍在)。`ino` 为 0 的文件系统不可比较,同样跳过。
Linux / Windows 走同一段代码(bind mount 同 dev/ino → 覆盖;Windows 未实测)。

### 身份缓存(性能:两次变更之间复用 (dev, ino))

inode 判定要 `stat` 目标的每一级目录前缀与每条受保护根(会动整棵子树的操作再加根的各级上级),次数随路径深度
线性增长(15 级路径、4 条受保护根:每次 `stat` 21 次、`readFile` 41 次系统调用)。只经 SDK 的插件改动目录结构的
唯一手段是 plugin-fs 的变更调用,它们都持全局读写锁的独占锁(见 `plugin-fs-rw-lock`),所以:

- **代际** = 独占锁累计被授予的次数。同一代际内,「目录前缀 → (dev, ino)」与「受保护根一侧的身份集合」只查一次;
  目标自身(叶子)**总是现查**。同一目录下反复 `stat` / `readFile` 的开销从 N × 深度降到 O(深度) + N。
- 失效都是**整体丢弃**:代际变了(有变更调用被授予过独占锁)、缓存存活满 **250ms**、时钟回拨、条目数超过 4096。
- 独占持有期间不读也不写缓存:变更调用自己的校验发生在它的变更之前,那时查到的身份对之后的调用是旧的。
  (所以写类调用的开销不变;它们本来就伴随落盘。)
- 缓存要求调用 `check` 的一方持锁 —— plugin-fs 所有经 `check` 的入口都持锁(`realpath` / `checkPath` 为此也取共享
  锁);`requestScope` 只做字符串判定,不经缓存。registry 未注入 `identityCache`(单独构造、测试)时不缓存。
- 字符串层的判定(受保护根之内 / 祖先、macOS 合成前缀、叶子的磁盘真实名)**不经缓存**,每次现算。

### macOS 合成前缀一律不认(第二层,与受保护根无关)

macOS 上,路径(词法形或解析后)的第一段是 `.nofollow`、`.resolve`、`.vol` → 与 scope 外路径同一条拒绝;
`requestScope` 请求这些前缀下的 scope 直接 `deny`(不弹窗)。它们不是访问用户文件的正当写法;scope 内指向它们的
符号链接(realpath 会报出 `/.nofollow/…`)同样不认。`/.resolve/<n>/…`、`/.vol/<dev>/<ino>` 此前只是因为 realpath
恰好失败才不可用。两层各自独立成立:去掉任一层,`/.nofollow` 的全部复现仍被另一层挡住(变异验证)。
Linux 上这些只是普通名字,不特殊对待。

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

解析失败(目标 / 父目录不存在等)时,按「最近的已存在上级 realpath + 其余各级」再判一次,落在受保护根内同样是
统一拒绝 —— 经 scope 内的目录链接或上述折叠等价的祖先段访问受保护根时,其下存在 / 不存在的路径不可区分。

## 行为

- **受保护根之内(含根本身)**:`readFile / writeFile / listDir / stat / lstat / realpath / mkdir / rename / rm /
  cp(源与目标)/ atomicReplaceWithinScope / readGitBlob / checkPath / readForEditor(→ `editor.openFile`)` 一律拒绝,
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
- macOS:`/.nofollow/…`、`/.resolve/…`、`/.vol/…` 写法的路径插件一律不可用(此前 `/.nofollow/<scope 内路径>` 可用)。
- 工作区根本身位于受保护根之内时(把 userData 当工作区打开),插件对它的 `requestScope` 直接被拒。

## 残余

- 有 `shell` 权限的插件可运行任意命令,仍能直接改这些文件 —— 与「shell = 完全访问」一致。
- 另一发行形态的 userData 只按默认位置保护;它若被用户放到别处(自定义 `--user-data-dir`),本实例不知道。
  本实例自己的 userData 无论在哪都受保护。
- 受保护根的**路径写法**在启动时确定。启动后才出现、且经符号链接指到别处的根:根本身与其内部按 inode 受保护
  (每次校验现 `stat`),它途经的链接所指的目录也算上级;但真实位置更上面的各级目录不在上级链里(对它们
  `rm -r` / `rename` 不被拒)。
- 指向受保护文件的**硬链接**(须由 SDK 之外的手段事先建在 scope 内)不被识别:可经它读到内容;写入走
  「临时文件 + rename」替换的是链接这个名字,不会改到原文件。
- 已存在的受保护根(及其上级)按 (dev, ino) 判定,realpath 不归一的别名(`/.nofollow`、firmlink、bind mount、
  `subst`)不再能绕过;**尚不存在的根没有 inode**:其最近已存在上级按 inode 认,再往下各段仍是名字比较(保守折叠)。
  Windows(`subst` / UNC、`ino` 是否稳定)未实测;`ino` 为 0 的文件系统退回纯字符串判定。
- inode 判定同样只管 plugin-fs 自己的调用:校验与操作在同一次持锁内,外部进程在其间改名 / 换目录不在此列。
- **身份缓存把上一条的窗口从「一次调用之内」放宽到「最多 250ms」**:不经过锁的改动(外部进程、有 `shell` 权限的
  插件、应用自己在主进程里建目录)在 TTL 内可能让 inode 判定用到旧身份。方向两种都有:
  - 多拒:受保护根被移走后,旧目录在 TTL 内仍按受保护处理。
  - 漏拒(仅 inode 这一层):受保护根的路径在 TTL 内换了 inode(删除重建、作为根写法的符号链接被改指、上级被
    改名后别的目录顶上来),或目标的某级目录被换成受保护根的**非链接别名**(bind mount / `subst`)——此时经
    「字符串认不出的写法」访问新目录,TTL 内不被 inode 层拒绝。字符串层不受影响:标准写法、数据卷别名、
    macOS 合成前缀、经符号链接到达(realpath 每次现做)照拒。只经 SDK 的插件做不到这些改动(对受保护根及其
    上级的 `rm` / `rename` 本就被拒,且任何变更调用都会使缓存失效)。
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
  受保护根本身、符号链接叶子、扫描超限 fail-closed、抢先创建)、存在性不可区分、解析范围与开销、Linux 分支。
  长 s 用例在临时目录所在卷不折叠 `ſ` 时跳过(Linux CI)。
  文件系统别名:`/.nofollow`(scope 授到 `/`;审计复现的六个操作、其余入口、祖先、尚不存在的根、存在性不可区分、
  第二层前缀拒绝与 requestScope、合法回归;系统不提供 `/.nofollow` 时跳过)、按 inode 判定(启动后经链接出现在别处的
  根:之内 / 上级;经目录链接别名操作祖先;每次校验的 stat 次数上限;无受保护根时零开销)。
- `identity-cache.spec.ts` —— 身份缓存:同一代际内的 stat 次数(计数断言)、叶子现查、代际变化 / TTL / 时钟回拨 /
  条目上限的失效、独占持有期间不缓存、接到 plugin-fs 锁之后「变更调用之后不用旧身份放行」。
  `protected-roots.spec.ts` 整套攻击回归也跑在带缓存的生产接线下。
- `ipc-wiring.spec.ts` —— `registerPluginFsIpc` 实际注入了本实例与两种发行形态的 userData。
- `electron/main/__tests__/user-data-path.test.ts` —— `resolveProtectedRoots` 各平台 / 发行形态的清单。
