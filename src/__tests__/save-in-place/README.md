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
     ≥ 2 × 新内容字节数 + 1 MiB(`statfs`);不够 → 「磁盘空间不足」(`FS_NO_SPACE`),一个字节都不写。
     statfs 不可用 / 报 0 块(部分 FUSE / 网络卷)→ 视为未知,照常写。
  1. 新内容更长 → 先把超出原长度的尾部写到原文件末尾之后并 fdatasync。
  2. 覆盖原有长度内的部分并 fsync;3. 新内容更短 → 覆盖落盘**之后**才截到新长度并 fsync。
  - 任一步失败 → 只把动过的范围用备份写回、截回原长度、fsync,再**逐字节读回核对**:一致 → 报原错误(如 `FS_NO_SPACE`),原文件不变;
    写回 / fsync 失败或核对不一致 → 报「保存失败,且未能还原原文件,原文件可能已损坏。完整的原内容已另存到 <路径>」
   (`FS_SAVE_ORIGINAL_DAMAGED`,`details.recoveryPath`):副本写到 `<userData>/save-recovery/<时间戳>-<文件名>`(0600),
    写不了再退到系统临时目录 `continuo-save-recovery/`;同一文件同样的原内容再次失败(自动保存反复重试)复用上次的副本;两处都写不了 → 提示也没能写出备份、不要关闭此标签页、腾出空间后重新保存。
    提示文案由 main 按当前语言写好(含路径),renderer 对这个 code 原样显示 message(`localizeErrorByCode`);通知带「另存为… / 重试」。
  - **写时复制卷 / 磁盘将满**:APFS 克隆文件(`cp -c`、Finder 复制)、本地快照仍引用的块、btrfs / ZFS / XFS reflink 上,覆盖已有块
    也要新空间,ENOSPC 常拖到 fsync / ftruncate 才报,回滚本身也会 ENOSPC。修前实测(20 MB APFS dmg,约 6 MB 克隆文件,卷剩约 1.1 MB):
    删一行保存 → 原文件末尾 30 字节变 NUL;开头改一字 + 末尾加 20 KB → 原文件尾部接上新内容。预检按 2 倍算:实测 APFS 改写克隆文件
    所需空间明显多于文件大小(statfs 报的可用空间里含 APFS 不让用的保留量,随容器大小变化),预检并不精确,兜底靠上面的核对与恢复副本。
  - 代价:普通卷上可用空间 < 2 × 文件大小 + 1 MiB 时,本可原地完成的保存也报「磁盘空间不足」(原文件不变)。
  - 权衡:进程在第 2、3 步中途被杀 / 断电会留下新旧混合内容(VSCode 原地写同样);tmp + rename 无此窗口,但丢上述元数据。
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
| `save-in-place-cow-no-space.spec.ts` | 可用空间预检;覆盖 / 截短后 fsync 报 ENOSPC、回滚也失败(写时复制卷)→ 原文件不变或恢复副本 = 完整原内容;fs:write-file 提示带副本路径 |
| `tests/e2e/editor-save-in-place.spec.ts` | 真实 Electron:⌘S 保存后硬链接 / xattr / 权限位 / 符号链接保持;只读目录可保存;小 dmg 卷写满时原文件完整;APFS dmg 上 `cp -c` 克隆文件磁盘将满时删一行 / 变长保存 → 提示磁盘空间不足,原文件逐字节不变 |
