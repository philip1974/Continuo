# Release 供应链防线

本主题锁定发版 / CI 构建链路上的供应链与机密泄漏防线。

## 行为契约

### 构建产物机密扫描(`scripts/check-no-secrets.mjs`)

- 背景:v0.2.5 安装包曾把 GitHub token 打进 `app.asar`。
- 只扫构建产物,不扫源码(测试 fixture 里的假值不受影响)。位置参数整棵扫描(`out/`、`out-pack/`);`--packaged <dir>` 只扫其下的 `app.asar` 与 `app.asar.unpacked/`(Electron Framework 等上游二进制的随机字节会误中 AKIA 规则,且不可能含本仓凭据)。`app.asar` 未压缩,直接对文件字节匹配。
- 规则:`(gho|ghp|ghu|ghs|ghr)_[A-Za-z0-9]{20,}`、`github_pat_[A-Za-z0-9_]{20,}`、`AKIA[0-9A-Z]{16}`、`-----BEGIN [A-Z ]*PRIVATE KEY-----`。
- 命中 → 退出码 1,只输出「文件:字节偏移 (规则名)」,不输出命中值。按 8MiB 分块读取、块间重叠,跨块边界的命中不漏不重。
- fail-closed:路径不存在、`--packaged` 目录里找不到 `app.asar`、无参数 → 退出码 2。
- 跳过压缩容器(`.dmg` / `.zip` / `.blockmap` 等),其内容已以 `.app` / `app.asar` 形式被扫。
- 接线:所有 `build:app*` 在 `electron-builder` 之后自动运行 `pnpm check:secrets:pack`(`out-pack` 全量 + `dist-electron` 的 `app.asar`);CI `secret-scan` job 在 `pnpm build` 之后独立一步扫 `out/`。

## 规范文件

- `check-no-secrets.spec.ts`:扫描器退出码 / 不回显值 / 分块边界 / fail-closed,以及 package.json 与 CI 接线。
