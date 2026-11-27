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
- **写失败原文件完整**(比 VSCode 更严:VSCode 先截断再写,写到一半磁盘满会只剩半截):
  1. 新内容更长 → 先把超出原长度的尾部写到原文件末尾之后并 fdatasync,一次要到新增空间;空间不足 → 截回原长度,原内容一个字节不动,报「磁盘空间不足」(`FS_NO_SPACE`)。
  2. 再覆盖原有长度内的部分并截到新长度、fsync;这一步失败 → 用写前读出的原内容写回、截回原长度,再报错。
  - 权衡:进程在第 2 步中途被杀 / 断电会留下新旧混合内容(VSCode 原地写同样);tmp + rename 无此窗口,但丢上述元数据。
- **写保护**:检查与「覆盖(去掉写保护)」流程不变(见 `save-readonly-file`);可写不可读的文件(读不了回滚备份)退回 tmp + rename。
- **并发**:同路径写仍 per-path 串行(见 `49-polish-bugfixes/atomic-write-concurrent-same-path`)。
- **回声身份**:关闭写句柄后按路径 stat,与关闭前经句柄取的 dev / ino / mtime 一致、size = 写入字节数才返回
  `{ mtimeMs, size, ino }`;其间被外部改写 → `undefined`(照旧整文件读)。Windows 关闭写句柄才刷新 mtime → 通常 `undefined`,只少一次省读。
- 插件写 / 拖入覆盖 / CLI 配置写(`atomicReplaceFileNoFollow`)不变:始终 tmp + rename、不跟随链接。

## Modules

| File | Role |
|---|---|
| `electron/main/ipc/fs/atomic-write.ts` | `atomicWriteFile` 分流:已有普通文件 `writeInPlace`(两阶段 + 回滚),其它 `replaceViaTmp` |
| `save-in-place.spec.ts` | 真实文件系统:硬链接 / 扩展属性 / 权限位 / 符号链接 / 只读目录 / 创建时间 / 回声身份 |
| `save-in-place-failure.spec.ts` | 注入写失败:磁盘满时原文件完整、覆盖阶段失败回滚、可写不可读退回 rename |
| `tests/e2e/editor-save-in-place.spec.ts` | 真实 Electron:⌘S 保存后硬链接 / xattr / 权限位 / 符号链接保持;只读目录可保存;小 dmg 卷写满时原文件完整 |
