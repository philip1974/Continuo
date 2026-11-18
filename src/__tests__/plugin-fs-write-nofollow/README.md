# plugin-fs-write-nofollow(plugin-fs 写操作不跟随叶子符号链接,校验与操作同一策略)

## 背景

`app.fs.writeFile` 的 scope 校验(`check('write')` → `resolveForWrite`)lstat 叶子并拒绝符号链接;但随后的写入器
`atomicWriteFile`(为编辑器保存设计)会**再 lstat 一次并 realpath 跟随链接**。两次 lstat 之间叶子可被换成链接:
插件在已授 rw scope 内有一条指向 scope 外的链接 `link`(真实仓库常见),并发
`app.fs.rename('<scope>/link', '<scope>/x')` 与 `app.fs.writeFile('<scope>/x', data)` →
校验时 `x` 不存在放行,rename 把 `x` 变成链接,写入跟到 scope 外(实测 5000 次约 250 次命中)。

## 行为

写操作都在校验得到的「父目录 realpath + 叶子名」上进行,且实际操作不跟随叶子链接:

| 操作 | 校验(叶子) | 实际操作 |
|---|---|---|
| `writeFile` | lstat,拒绝链接 | `atomicReplaceFileNoFollow`:同目录 tmp(`wx` 排他)+ `rename(tmp → 路径)`,替换的是路径本身 |
| `mkdir` | lstat,拒绝链接 | `fs.mkdir`:叶子已是任何条目(含链接)时不会在链接目标处建目录 |
| `rename` | src 不跟随;dst lstat 拒绝链接 | `fs.rename`:移动 / 替换条目本身 |
| `rm` | 不跟随 | `fs.rm`:链接只删链接本身 |
| `cp` | src realpath 后查 scope;dst lstat 拒绝链接 | `fs.cp`(`force:false` + `errorOnExist` + `COPYFILE_EXCL`):目标以排他方式创建,已存在任何条目即 EEXIST |
| `atomicReplaceWithinScope` | staging / final lstat 拒绝链接 | 全部是 `fs.rename`;trash 清理 `fs.rm` 不跟随 |

- `writeFile`:校验之后叶子被换成指向 scope 外的链接 → 外部文件不变,scope 内的链接被替换成普通文件。
- `cp`:Node 的 `fs.cp` 在自己的检查与落盘 `copyFile` 之间目标被换成链接 → `copyFile` 因 `COPYFILE_EXCL` 以 EEXIST
  失败(映射为「destination already exists」),不跟随链接。
- 非竞态下叶子本来就是链接的写入 / 建目录 / 原子替换,照旧在校验阶段以 `symlink leaf rejected` 拒绝。

## 残余

- Node 没有 `openat`:校验之后**父目录的某一级**被换成链接,操作会跟到新位置。需要攻击者能在两次系统调用之间
  替换 scope 内的目录分量;所有写操作同此残余。
- 读操作(`readFile` / `stat` / `listDir` / `cp` 的源)按 realpath 结果查 scope 后再按该路径打开,其间叶子被换成链接
  的窗口不在本主题范围(读取本就「跟随后查 scope」,策略一致;窗口同上属 check → open 非原子)。

## 规范

- `write-file-symlink-race.spec.ts` —— 真实 IPC handler + 真实 `PathScopeRegistry` + 真实临时目录;用 `vi.mock`
  包住写入器在「校验后、写入前」换入链接,确定性复现。
