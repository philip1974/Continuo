# plugin-fs-git-blob-scope(readGitBlob 的对象库必须在已授 scope 内)

## 背景

`app.fs.readGitBlob(repoDir, sha)` 在主进程跑 `git cat-file blob <sha>`(cwd = repoDir)。此前只校验
`repoDir` 在插件的只读 scope 内,而**读哪个对象库由 git 自己决定**,守规矩的插件经 SDK 即可读到 scope 外的对象:

1. 向上发现:用户只授 `repo/docs`,git 从 `repo/docs` 向上找到 `repo/.git` → 读到整个仓库的 blob
  (含已从工作树删除的 `.env` 历史版本)。
2. gitfile 重定向:有任一 rw scope 的插件写 `scope/.git` = `gitdir: /任意仓库/.git` 后读任意仓库。
3. alternates:在 scope 内仓库的 `.git/objects/info/alternates` 写入任意对象目录。

## 行为

- 仓库的 gitdir、commondir、对象目录(realpath 后)都在该插件的只读 scope 内 → 正常返回 blob 内容
  (`repoDir` 可以是仓库内的子目录)。
- gitdir / commondir / 对象目录任一不在 scope 内(向上发现到 scope 外的 `.git`、gitfile 指向 scope 外、
  linked worktree 的主仓在 scope 外、`objects` 或其下的扇出目录 / pack 目录 / 对象文件是指向 scope 外的
  符号链接)→ `ScopeError`,统一文案 `git repository not found within granted scope`(与「不是 git 仓库」
  不可区分)。
- 对象库带非空 `objects/info/alternates` → `ScopeError`(不逐项判定,一律拒绝)。
- 宿主进程 env 里会重定向仓库 / 对象库的 `GIT_*` 变量(`GIT_DIR`、`GIT_OBJECT_DIRECTORY`、
  `GIT_ALTERNATE_OBJECT_DIRECTORIES` 等)不传给 git。
- 不跟随 replace-ref(`GIT_NO_REPLACE_OBJECTS=1`,`rev-parse` 与 `cat-file` 两次调用共用 `gitBlobEnv()`):
  对象路径校验只覆盖**被请求 sha** 的扇出目录 / 对象文件。有 rw scope 的插件可在 scope 内仓库写
  `refs/replace/<请求的 sha>` 指向另一个 OID T,并让 `objects/<T 前两位>` 成为指向 scope 外对象目录的符号链接
  (SDK 的 cp 按链接复制,可把工作区里已有的外链搬进去);git 默认跟随 replace-ref 就会读到未校验扇出里的
  scope 外对象。禁用后读到的永远是被请求 sha 自己的对象。
- `sha` 必须是完整的 40(SHA-1)或 64(SHA-256)位 hex;缩写 sha 一律拒绝(防唯一前缀枚举)。
  大写 hex 在入口统一转成小写(renderer 预检与主进程 handler 都转):git 内部按小写找对象,校验若按大写前缀
  去看扇出目录,大小写敏感文件系统上 `objects/AB` 不存在(跳过校验),而 git 实际读的 `objects/ab` 可以是外链。
- git < 2.31(不认 `rev-parse --path-format`)→ 无法确认对象库位置,一律拒绝(fail-closed)。

## 实现

`electron/main/services/plugin-fs.service.ts`:`resolveGitObjectStoreInScope` 用
`git rev-parse --path-format=absolute --absolute-git-dir --git-common-dir` 取位置,逐项经
`PathScopeRegistry.check` 校验后,把 `GIT_DIR` / `GIT_COMMON_DIR` / `GIT_OBJECT_DIRECTORY` 钉成已校验的
路径再跑 `cat-file`(校验后再改 `.git` 文件 / `objects` 链接不影响本次读取)。env 剥离见
`child-spawn-hardening.ts` 的 `stripGitRepoRedirectEnv`。

## 残余

- 校验后、`cat-file` 读取前的极短窗口内写入 `objects/info/alternates` 或把 pack / 对象文件换成符号链接
  (需要对该 `.git` 有 rw scope,且插件 SDK 没有创建符号链接的方法)。
- 已知残留(存在性探测,未改代码):对 scope 内仓库有 rw scope 的插件可在其 `.git/config` 写
  `include.path = <scope 外路径>`。`rev-parse` 读 config 时,被包含文件存在但不是合法 config → git 报错退出
  (本接口返回统一的 `git repository not found within granted scope`);不存在 → 静默忽略、调用成功。
  成功 / 失败的差异可用来探测 scope 外路径是否存在(以及是否是合法 git config),读不到内容。
