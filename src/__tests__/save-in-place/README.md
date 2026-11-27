# save-in-place(编辑器保存覆盖已有文件:原地写,保留文件身份与元数据)

## 背景

编辑器保存(`fs:write-file` → `atomicWriteFile`)此前一律「同目录 tmp + `rename(tmp → 路径)`」替换**目录项**,副作用:

- 只读目录(555)里的可写文件(644)⌘S 报「拒绝访问」(rename 需要目录写权限),无出路;
- 扩展属性(Finder 标签 `com.apple.metadata:_kMDItemUserTags`、`user.note` 等)、ACL、创建时间随旧 inode 丢失;
- 硬链接被拆开(inode 变,另一个名字仍是旧内容);属主变成保存者。

## 行为(对齐 VSCode `diskFileSystemProvider.writeFile`)

VSCode 编辑器保存默认**原地写**已有文件(`open` 已有文件后写入;Windows 用 `r+` + `ftruncate` 保留隐藏属性 / ADS);
只有调用方显式要求 `atomic`(如用户设置文件)才写 tmp 再 rename,且对符号链接不做 atomic。没有 `files.atomicSave` 类设置。

- **已有普通文件 → 原地写**(同一 inode):目录权限、扩展属性 / Finder 标签、ACL、硬链接、属主、权限位、创建时间都不变。
  只读目录里的可写文件可以保存。
- **符号链接**:保存写到链接目标(读写对称,链接本身保持是链接,目标 inode 不变)。
- **新建文件 / 非普通文件** → 仍 tmp + rename(新建本就要目录写权限,也无元数据可保留;不会留下半截新文件)。
- **写失败:要么原文件逐字节不变,要么明确告知并给出完整原内容副本**(比 VSCode 更严:VSCode 先截断再写,写到一半磁盘满会只剩半截):
  0. 改动任何字节前读出**完整**原内容作内存备份(原文件超过写入上限 64 MiB → 退回 tmp + rename),并预检可用空间
     ≥ 3 × 新内容字节数 + 卷大小的 4%(夹在 4 MiB 与 48 MiB 之间)(`statfs`);不够 → 不原地写(原文件一个字节都不写),
     **退回 tmp + rename**(见下「预检不过的退路」)。statfs 不可用 / 报 0 块(部分 FUSE / 网络卷)→ 视为未知,照常写。
  1. 新内容更长 → 先把超出原长度的尾部写到原文件末尾之后并 fdatasync。
  2. 覆盖原有长度内的部分并 fsync;3. 新内容更短 → 覆盖落盘**之后**才截到新长度并 fsync。
  - 任一步失败 → 只把动过的范围用备份写回、截回原长度、fsync(三步各自尝试,某步失败不跳过后面的),再**逐字节读回核对**,结论只看核对:
    一致 → 报原错误(如 `FS_NO_SPACE`),原文件未改动,**不写恢复副本**(回滚的 fsync 失败也算 —— 写时复制卷将满时它同样 ENOSPC,
    但写回已进入文件;修前这种情况一律报「可能已损坏」并写副本,实测原文件逐字节完好、卸载重挂也完好);
    核对不一致 / 读不回来 → 报「保存失败,且未能还原原文件,原文件可能已损坏。完整的原内容已另存到 <路径>」
   (`FS_SAVE_ORIGINAL_DAMAGED`,`details.recoveryPath`):副本写到 `<userData>/save-recovery/<时间戳>-<文件名>`(0600),
    写不了再退到系统临时目录 `continuo-save-recovery/`;同一文件同样的原内容再次失败(自动保存反复重试)复用上次的副本;两处都写不了 → 提示也没能写出备份、不要关闭此标签页、腾出空间后重新保存。
    提示文案由 main 按当前语言写好(含路径),renderer 对这个 code 原样显示 message(`localizeErrorByCode`);通知带「另存为… / 重试」。
  - **写时复制卷 / 磁盘将满**:APFS 克隆文件(`cp -c`、Finder 复制)、本地快照仍引用的块、btrfs / ZFS / XFS reflink 上,覆盖已有块
    也要新空间,ENOSPC 常拖到 fsync / ftruncate 才报,回滚本身也会 ENOSPC。修前实测(20 MB APFS dmg,约 6 MB 克隆文件,卷剩约 1.1 MB):
    删一行保存 → 原文件末尾 30 字节变 NUL;开头改一字 + 末尾加 20 KB → 原文件尾部接上新内容。
  - **预检不过的退路**(第四十九轮 A1):新内容写成同目录新文件(`.<名>.continuo.tmp`)、fsync、rename 替换 —— 不覆盖原文件的块,
    写时复制卷上改写共享块要的额外空间都不要,只要新内容本身的空间。修前 536 GB 卷剩 200 MB 时 23 字节的 note.txt 加一行也报
   「磁盘空间不足」(余量上限 256 MiB),VSCode 能存。退路丢 inode / 创建时间(b07031dd 的取舍),权限位照旧继承;macOS 上 tmp 先
    克隆原文件(`cp -c -p`,不占数据空间)再截空写新内容,扩展属性 / Finder 标签 / ACL / 文件标志随之保留(其它平台扩展属性丢失)。
    成功即静默(同 VSCode 原子保存)。**不走退路、直接报 `FS_NO_SPACE`「原文件未改动」**:硬链接(nlink > 1,rename 会把它拆开 ——
    宁可不存,不悄悄拆开,所以也无需「硬链接被拆开」的提示)、属主不是当前用户(rename 后属主会变)。退路任何一步失败(只读目录建不了 tmp、
    tmp 写入 / fsync ENOSPC、rename 失败)→ 删 tmp,报 `FS_NO_SPACE`「原文件未改动」:rename 成功之前从不触碰原文件,保证天然成立。
  - 预检系数依据(实测,APFS dmg 上克隆文件整段改写 + fsync 成功所需的最小 statfs 可用空间,见 `MEASURED_COW_REWRITE`):
    ≈ 卷的保留量 + 文件大小 + min(文件大小, 约 2 MB);保留量 20 MB 卷约 2 MB、200 MB 卷约 5.7 MB、1 GB 卷约 23 MB、4 GB 卷与 536 GB 卷都约 33 MB
   (statfs 报的可用空间里含 APFS 不让改写克隆块用的部分)。20 MB 卷上 2 MB 文件需约 6.3 MB:旧预检 2 × 内容 + 1 MiB ≈ 5.2 MB,
    在 5.2–6.3 MB 之间放行、写入必然失败(且旧回滚在 fsync 失败时直接报「可能已损坏」)。3 × 内容 + 卷大小的 4%(4 MiB–48 MiB)覆盖全部实测
    (536 GB 卷:0.1 MB 文件需约 34.3 MB、2 MB 文件约 37.4 MB;上限 48 MiB 下要 50.6 / 56.4 MB)。旧上限 256 MiB 在 ≥ 6.4 GB 的卷上约高估 7 倍。
  - 读回核对读的是内核页缓存:fsync 失败后缓存里可以是没落盘的数据(实测:覆盖后 fsync ENOSPC,同一句柄或重新打开读回都是新内容,
    卸载重挂后盘上部分块已是新内容)。所以只在写回之后核对 —— 此时缓存是原内容,盘上的块要么从未被覆盖,要么之后按缓存回写;
    实测(20 MB / 200 MB 卷,删一行 / 加一行 / 同长替换,可用空间 2.5–9 MB,绕过预检强制走回滚)回滚的 fsync 全部 ENOSPC,
    卸载重挂后原文件逐块等于原内容。残留风险:回滚的 fsync 失败后、缓存回写前断电 / 内核崩溃,之前已部分落盘的块可能仍是新内容 ——
    用户态无法核实(`fh.sync()` 在 macOS 上已是 `F_FULLFSYNC`,重新打开再读走同一页缓存),预检按实测留足余量就是为了不走到这里。
  - 代价:可用空间小于预检要求时改走 tmp + rename(上述元数据变化);硬链接 / 别人的文件此时报「磁盘空间不足」(原文件未改动)。
  - 权衡:进程在第 2、3 步中途被杀 / 断电会留下新旧混合内容(VSCode 原地写同样);tmp + rename 无此窗口,但丢上述元数据。
- **提示**(`save-failure-notice.spec.tsx`):保存报 `FS_NO_SPACE` → 「保存失败 <文件名>:磁盘空间不足,磁盘上的原文件未改动」
 (`FS_NO_SPACE` 只来自预检不过且退路不可行 / 退路失败、回滚核对一致、tmp + rename 失败,都不动原文件)。同一文件反复保存失败(⌘S 重试、自动保存)
  只留最新一条通知,新的替换旧的,不叠成「×2」(VSCode `TextFileSaveErrorHandler` 每个文件只留最近一次保存错误的通知;
  通知 `replaceKey` = 文件路径);不同文件各自一条。
- **写保护**:检查与「覆盖(去掉写保护)」流程不变(见 `save-readonly-file`);可写不可读的文件(读不了回滚备份)退回 tmp + rename。
- **并发**:同路径写仍 per-path 串行(见 `49-polish-bugfixes/atomic-write-concurrent-same-path`)。
- **回声身份**:关闭写句柄后按路径 stat,与关闭前经句柄取的 dev / ino / mtime 一致、size = 写入字节数才返回
  `{ mtimeMs, size, ino }`;其间被外部改写 → `undefined`(照旧整文件读)。Windows 关闭写句柄才刷新 mtime → 通常 `undefined`,只少一次省读。
- 插件写 / 拖入覆盖 / CLI 配置写(`atomicReplaceFileNoFollow`)不变:始终 tmp + rename、不跟随链接。

## Modules

| File | Role |
|---|---|
| `electron/main/ipc/fs/atomic-write.ts` | `atomicWriteFile` 分流:已有普通文件 `writeInPlace`(空间预检 + 分步写 + 核对回滚 + 恢复副本),其它 `replaceViaTmp` |
| `electron/main/ipc/fs.ipc.ts` | `writeFileHandler`:`FS_SAVE_ORIGINAL_DAMAGED` 的提示按当前语言带恢复副本路径;`configureSaveRecovery`(main 启动时设副本目录) |
| `save-in-place.spec.ts` | 真实文件系统:硬链接 / 扩展属性 / 权限位 / 符号链接 / 只读目录 / 创建时间 / 回声身份 |
| `save-in-place-failure.spec.ts` | 注入写失败:磁盘满时原文件完整、覆盖阶段失败回滚、可写不可读退回 rename |
| `save-in-place-cow-no-space.spec.ts` | 可用空间预检(覆盖实测阈值,含 536 GB 卷;大卷余量上限 48 MiB);预检不过退回 tmp + rename(原文件块上 0 写入、权限位 / macOS 扩展属性保留;硬链接 / 属主不同 / tmp ENOSPC / rename 失败 / 只读目录 → FS_NO_SPACE 原文件不变);覆盖 / 截短后 fsync 报 ENOSPC、回滚 fsync 也失败但读回一致 → FS_NO_SPACE 不写副本;写不回 / 读不回 → 恢复副本 = 完整原内容;fs:write-file 提示带副本路径 |
| `save-failure-notice.spec.tsx` | 磁盘空间不足的提示说明原文件未改动;同一文件反复保存失败只留一条(replaceKey) |
| `src/notifications/notify-open-failed.ts` | `notifySaveFailed(…, filePath)`、`saveFailureReason`、`saveFailureNotifyKey` |
| `tests/e2e/editor-save-in-place.spec.ts` | 真实 Electron:⌘S 保存后硬链接 / xattr / 权限位 / 符号链接保持;只读目录可保存;小 dmg 卷写满时原文件完整;APFS dmg 上 `cp -c` 克隆文件磁盘将满时删一行 / 变长保存 → 提示磁盘空间不足,原文件逐字节不变;20 MB 卷、2 MB 克隆文件、卷剩约 5.4 MB(旧预检放行的区间)删一行 / 加一行 / 同长替换 → 「原文件未改动」、无恢复副本、重复保存只一条提示 |
