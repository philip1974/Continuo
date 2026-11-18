# plugin-fs-scope-existence-oracle(scope 外路径一律同一条拒绝,不泄露存在性)

## 背景

`PathScopeRegistry.check` 此前先 `realpath` 再匹配 scope。只有 `fs` 权限、没拿到任何 scope 的插件,
对任意路径调 `app.fs.stat / readFile / writeFile …` 就能从错误文案区分:

- 不存在 → `target does not exist`;存在 → `target not in any granted scope`;
- 其它 → `realpath failed: EACCES / ENOTDIR`;写类方法对父目录同理(`parent missing`),
  叶子是符号链接 → `symlink leaf rejected`。

即全盘存在性 / 类型探测器。

## 行为

- 目标**词法上**(展开 `~` + `path.resolve`,不碰文件系统)不在该插件任何已授 scope 内 →
  统一抛 `ScopeError('target not in any granted scope')`,与目标是否存在、是文件 / 目录 / 链接、
  是否可访问无关;读、lstat、写、mkdir、rename、rm 全部如此。此时不做任何 `realpath` / `lstat`。
- 词法上在 scope 内 → 走原有 realpath 流程:`target does not exist` / `parent missing` 等细节照旧
  (属于已授权范围内的信息);realpath 后落到 scope 外(scope 内符号链接指向 scope 外)照旧拒绝。
- 「词法上在 scope 内」的根有两种:
  1. 已授 scope 的 canonical 路径;
  2. 插件 `requestScope` 时用的原始写法(如 macOS 的 `/tmp/x`、经符号链接的 workspace 路径),
     授予(含被已有授权静默覆盖)时登记为该 scope 的别名 —— 插件用它请求时的写法访问照常可用。
- macOS / Windows(默认大小写不敏感的文件系统)上词法比较忽略大小写;最终的 canonical 匹配不变。
- `requestScope` 本身不是探测器:它只返回 `grant` / `deny`,归一化后的路径只发给授权弹窗。
- 被词法预判拒绝的原因(插件、操作、路径)记入主进程日志。

## 行为收紧

- 经**既不是 canonical、也不是请求时写法**的路径访问 scope 内文件(如 scope 外的符号链接指向 scope 内、
  授的是 `/private/tmp/x` 却用 `/tmp/x` 访问)现在被拒绝。

## 残余

- scope 内已有的符号链接指向 scope 外时,`target does not exist`(悬空)与
  `target not in any granted scope`(目标存在)仍可区分该链接目标的存在性(插件 SDK 不能创建符号链接)。
