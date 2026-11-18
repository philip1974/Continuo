# plugin-fs-rw-lock(plugin-fs 调用之间的读写锁:插件不能在另一次调用的「校验 → 操作」之间改目录结构)

## 背景

`app.fs.*` 的每个入口都是「scope 校验(realpath,结果须在已授 scope 内)→ 按得到的路径字符串做文件系统操作」。
两步之间路径由 OS 重新解析,而 Node 没有 `openat`。插件只用 SDK 就能钻这个间隙:scope 内有一条指向 scope 外的
既有符号链接 `dl`(SDK 没有建链接的 API,但可以挪动既有链接)时,

- 并发 `rename('<scope>/d', '<scope>/dbak')` + `rename('<scope>/dl', '<scope>/d')`,或
- `atomicReplaceWithinScope` 把含 `dl` 的目录 P 原子换到正被访问的目录 Q 上,

同时 `cp('<scope>/d/secret', '<scope>/copy')` / `readFile` / `writeFile` / `mkdir`:校验时 `d` 是真目录放行,操作时
`d` 已是外链。实测(真实 handler + 真实临时目录,每场景 3000 次):cp 越界读数百次、readFile / listDir 越界读、
writeFile 写到 scope 外、mkdir 在 scope 外建目录都能命中。叶子 no-follow(见 `plugin-fs-write-nofollow`)挡不住
目录级替换。

## 行为

只经 SDK 的插件改动目录结构的唯一手段是 plugin-fs 自己的变更调用,所以主进程用一把**进程内全局读写锁**把它们
与其它调用的「校验 + 操作」整段互斥:

| 类别 | 入口 | 锁 |
|---|---|---|
| 变更 | `writeFile` `mkdir` `rename` `rm` `cp` `atomicReplaceWithinScope`(含 trash 清扫) | 独占 |
| 只读 | `readFile` `listDir` `stat` `lstat` `readGitBlob` `realpath` `checkPath` | 共享 |
| 不取锁 | `requestScope`(等待用户点弹窗)、注册 / 注销 | — |

`realpath` / `checkPath` 自己在校验之后没有文件系统操作,取共享锁是因为 scope 校验的身份缓存要求调用方持锁
(见 `plugin-fs-protected-roots` README「身份缓存」)。锁另外暴露「独占累计授予次数」与「此刻是否有独占持有者」,
供该缓存判断失效。

- 任一调用处于校验与操作之间时,并发的变更调用排到它完成之后;变更本身照常完成,只是不会落在别人的间隙里。
- 只读调用之间不互斥。排队严格按到达顺序(独占在等待时,后到的共享排在它后面),写者不会饿死。
- 所有插件共用一把锁:不同插件的 scope 可以重叠。
- 调用抛错即释放。锁不可重入、无超时(不强行释放别人的锁)。
- `cp` 持独占锁运行,条目总数上限 100 000(含根),超限以 `FS_DIR_TOO_LARGE` 中止 —— 同时限定最坏持锁时间。
  已复制的部分留在目标处(与此前 `fs.cp` 中途失败一致)。

纵深(锁管不到的外部改动):`readFile` 打开文件后重新做一次完整的 scope 校验,并要求校验到的文件与已打开的 fd
是同一个 inode(dev / ino,bigint),之后只经这个 fd 读。校验之后叶子或某级目录被换成指向 scope 外的链接 →
拒绝(`target not in any granted scope`);打开与复核之间文件被替换(含正常的并发原子保存)→ 重试一次,仍不一致
则 `target changed during access`。

## 残余

- 锁只管 plugin-fs 自己的调用。**有 `shell` 权限的插件**(可运行任意命令,本就等于完全访问本机文件)、用户自己的
  进程、其它应用对同一目录的并发改动不在此列:它们在校验与操作之间替换目录分量,操作仍会跟到新位置。
- `readFile` 的打开后复核本身按路径进行:能在「打开 → 复核 realpath → 复核 stat」之间精确地换入、换回、再换入的
  外部竞态者理论上仍可通过。`listDir` / `stat` / `lstat` / `cp` / 写操作没有这层复核(macOS 上 Node 无法按 fd 枚举
  目录或做 `openat`,`/dev/fd/N` 不能当目录用),对外部改动只有锁之外的既有保护(叶子 no-follow、目标排他创建)。
- 一次大目录 `cp` / `rm` 会在其运行期间挡住所有 plugin-fs 调用(上限见上)。
- `checkPath` 只返回布尔值,调用方随后经其它通道按路径打开,不在本锁范围。

## 规范

- `plugin-fs-rw-lock.spec.ts` —— 真实 IPC handler + 真实 `PathScopeRegistry` + 真实临时目录;在「校验之后、操作
  之前」的系统调用上挂钩子,钩子里并发发起另一条调用并观察它是否被挡在外面:攻击复现(cp / readFile / writeFile /
  mkdir × rename / atomicReplace)、互斥矩阵(每个取锁入口各作为被保护方与变更方)、读读并行、抛错释放、
  requestScope 不持锁、cp 条目上限、readFile 的打开后复核。
- 锁本身的单元测试:`electron/main/__tests__/rw-lock.test.ts`。
