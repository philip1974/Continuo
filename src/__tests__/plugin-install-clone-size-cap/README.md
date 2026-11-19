# plugin-install-clone-size-cap(插件 git 安装 / 更新的 clone 体积上限)

插件从 git URL 安装 / 更新(`installFromGit`,`electron/main/services/plugins.service.ts`)此前只有 60s 超时:
恶意仓库放高压缩比的巨型 blob,60s 内即可写满磁盘(超时后才终止 git 并删临时目录;前提是用户主动安装)。

## 行为契约

- clone 期间每 500ms 有界统计临时 clone 目录(含 `.git`)的逻辑字节数与条目数(上一次统计结束才排下一次,单次
  最多访问 `PLUGIN_CLONE_MAX_ENTRIES` 个条目)。超过 `PLUGIN_CLONE_MAX_BYTES`(200MiB)或 `PLUGIN_CLONE_MAX_ENTRIES`
  (20000)→ 终止 git(SIGTERM → 宽限后 SIGKILL),**等 git 退出后**结算为 `PLUGIN_REPO_TOO_LARGE`,临时目录随即删除,
  不等 60s 超时。
- clone 在两次轮询之间就完成:检出后复查一次,超限同样 `PLUGIN_REPO_TOO_LARGE`、不落地。
- 未超限的仓库照常安装,git 不被终止。
- 错误码三语文案:`errors.PLUGIN_REPO_TOO_LARGE`。
- 未采用 `--filter=blob:limit=<n>`(partial clone):依赖远端支持,且检出时缺失的 blob 会惰性回源拉取,行为不如
  直接统计体积可靠。

## 规范文件

- `clone-size-cap.spec.ts`:真实 `installFromGit`,git 子进程换成往真实 clone 目录写文件的桩(稀疏文件制造逻辑体积):
  clone 进行中超体积 → 终止、清理、报错且远早于超时;clone 很快完成但超体积 / 超文件数 → 复查拒绝、不落地;
  正常大小仓库照常安装、不终止 git。
