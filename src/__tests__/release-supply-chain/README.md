# Release 供应链防线

本主题锁定发版 / CI 构建链路上的供应链与机密泄漏防线。

## 行为契约

### 构建产物机密扫描(`scripts/check-no-secrets.mjs`)

- 背景:v0.2.5 安装包曾把 GitHub token 打进 `app.asar`。
- 只扫构建产物,不扫源码(测试 fixture 里的假值不受影响)。位置参数整棵扫描(`out/`、`out-pack/`);`--packaged <dir>` 扫其下每个含 `app.asar` 的资源目录整体(`app.asar`、`app.asar.unpacked/`,以及 extraResources 放入的 `continuo-mcp-stdio.mjs`、`js-debug/` 等);资源目录之外的 Electron Framework 等上游二进制不扫(随机字节会误中 AKIA 规则,且不可能含本仓凭据)。`app.asar` 未压缩,直接对文件字节匹配。
- 规则:`(gho|ghp|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`、`github_pat_[A-Za-z0-9_]{20,}`、`AKIA[0-9A-Z]{16}`、`-----BEGIN [A-Z ]*PRIVATE KEY-----`、`npm_[A-Za-z0-9]{36}`、`sk-[A-Za-z0-9]{20,}` 及带前缀形态 `sk-(proj-|svcacct-|admin-|ant-<类型>-)[A-Za-z0-9_-]{20,}`(放宽字符集只限已知前缀之后,且 `sk-` 前不是字母数字,避免连字符类名误报)、`xox[baprs]-[A-Za-z0-9-]{10,}`。
- 命中 → 退出码 1,只输出「文件:字节偏移 (规则名)」,不输出命中值。按 8MiB 分块读取、块间重叠,跨块边界的命中不漏不重。
- 命中时删除 `--packaged` 目录顶层本次构建的分发产物(dmg / zip / blockmap / exe 等、`SHA256SUMS*`、`latest*.yml`;mtime 不早于「有命中的资源目录」的 `app.asar` 视为本次产物,多个目录命中取最早;命中只在位置参数目录时取最新的 `app.asar`;未命中的旧构建解包目录不参与定界),防止手动 `gh release create` 照样上传;保留解包的 `.app` / `app.asar` 以便定位,历史版本产物不动。未命中不删任何文件。
- fail-closed:路径不存在、`--packaged` 目录里找不到 `app.asar`、无参数 → 退出码 2。
- 跳过压缩容器(`.dmg` / `.zip` / `.blockmap` 等),其内容已以 `.app` / `app.asar` 形式被扫。
- 接线:所有 `build:app*` 在 `electron-builder` 之后自动运行 `pnpm check:secrets:pack`(`out-pack` 全量 + `dist-electron` 的 `app.asar`);CI `secret-scan` job 在 `pnpm build` 之后独立一步扫 `out/`。

### sibling 依赖 ContinuoTerminal 固定版本(`.continuo-terminal-ref`)

- package.json 以 `file:../ContinuoTerminal/...` 引用 sibling 仓库,本身不固定版本;仓库根 `.continuo-terminal-ref` 记录应使用的 40 位 commit SHA。
- CI(ci.yml / e2e.yml 所有 job)经 `scripts/ci-checkout-continuo-terminal.sh` 浅克隆后按 SHA `fetch --depth 1` 并 `checkout --detach`,检出后核对 HEAD;不再跟随 sibling 默认分支最新提交。
- 所有 `build:app*` 第一步运行 `pnpm check:sibling-ref`(`scripts/check-sibling-ref.mjs`):`../ContinuoTerminal` 必须是独立 git 仓库根(不是外层仓库里的普通子目录)、工作区干净(含未跟踪文件)、HEAD 等于记录的 SHA,且没有 skip-worktree / assume-unchanged 标记的文件(`git ls-files -v` 出现非 `H` 行;这两种标记让 `git status` 看不到工作区改动);否则中止打包并提示。记录文件缺失或格式不对同样中止。
- 打进安装包的是 `pnpm install` 时复制进 `node_modules/.pnpm` 的 `file:` 依赖副本(硬链接,sibling `git checkout` 重建文件后不再随之变化)。因此脚本还逐文件比对:package.json 中每个指向 sibling 的 `file:` 依赖,其 `node_modules/<name>` 副本里的每个文件(仅豁免副本顶层、只含 `.bin` 的 `node_modules`——pnpm 把依赖放在副本同级,副本自身只有可执行垫片;其它位置或含其它条目的 `node_modules` 会劫持副本内的模块解析,出现即中止)都必须是固定 SHA 的 tree 里的 blob 且字节一致(期望内容取自 git 对象——对副本文件算 git blob 哈希与 `git ls-tree -r <sha>` 比对——不读 sibling 工作区文件:标记位或本地 clean filter 可让被改的工作区在 `git status` 下显示干净);副本缺失、多出未跟踪文件、内容不同、或一个 sibling `file:` 依赖都没有 → 中止并提示 `pnpm install`。只校验「副本 ⊆ 固定 SHA」(pnpm 按 `files` 字段过滤,副本本就不含全部跟踪文件)。
- 升级 sibling:确认新 commit 已推送到远端后更新 `.continuo-terminal-ref`,并重新 `pnpm install`(`file:` 依赖在 install 时被复制进 `node_modules/.pnpm`)。

### GitHub Actions 固定 SHA 与最小权限

- `.github/workflows/*.yml` 里每个 `uses:` 固定到 40 位 commit SHA,行尾 `# vX.Y.Z` 注明版本(标签可被重新指向,SHA 不可)。
- 每个 workflow 顶层 `permissions: contents: read`;需要更多权限的 job 单独声明(当前无:upload-artifact / setup-node 缓存走 Actions runtime token)。
- `.github/dependabot.yml` 每周检查 `github-actions` 更新,由 PR 同步升级 SHA 与版本注释。

## 规范文件

- `check-no-secrets.spec.ts`:扫描器退出码 / 不回显值 / 分块边界 / fail-closed,以及 package.json 与 CI 接线。
- `actions-pinned.spec.ts`:workflow action 固定 SHA、顶层只读权限、Dependabot 配置。
- `sibling-ref-pinned.spec.ts`:sibling 版本核对(干净 / HEAD 一致 / 非外层仓库子目录)与 CI 固定 SHA 检出接线。
