# 跨仓 / 待办 follow-ups

已识别、本仓暂不处理(需兄弟仓库或后续专项)的事项。处理完从此处删除并在 commit 中说明。

## ContinuoTerminal `server-node` · bash / fish shell integration 污染子进程环境

- **现状**(`prepareShellIntegrationEnv`):
  - **bash**:返回 `['--rcfile', <生成的 rc>, '-i']`(非 login),rcfile 无条件依次 source
    `~/.bash_profile` / `~/.profile` / `~/.bashrc`,且不读 `/etc/profile`(macOS `path_helper` 在其中)
    → 启动文件重复执行、PATH 与原 `-l -i` 不一致。env 另注入 `BASH_ENV=<rc>` 与 `ENV=<rc>` →
    终端里每个非交互 `bash -c '...'` / bash 脚本都会重复 source 用户启动文件,并把 OSC7 转义打到
    stdout(实测 `bash -c 'printf OK'` 输出 `"\e]7;file://<host><cwd>\aOK"`,污染脚本输出与 `$(...)` 捕获)。
  - **fish**:env 把 `XDG_CONFIG_HOME` 改为临时目录 → 该终端里启动的所有子程序(nvim / git / gh /
    starship …)找错配置目录,用户 `~/.config/fish/conf.d`、`functions` 也不再加载。
- **Continuo 侧处理**:`electron/main/services/terminal.service.ts` 对 bash / fish **不调用 helper**
  (`shell-args.ts` 的 `skipsShellIntegration`),使用原始 env,bash / fish 仍以 `-l -i` 启动
  (代价:bash / fish 暂无 OSC7 cwd 跟踪;zsh 在 helper 内本就是 no-op)。契约见
  `src/__tests__/migration-shell-env/integration-args-contract.spec.ts`。
- **helper 需改**:
  - bash 集成**不得**用 `BASH_ENV` / `ENV` 污染子 shell;需模拟 login 启动文件选择(参考 VSCode
    `shellIntegration-bash.sh`):login 模式 `/etc/profile` + `~/.bash_profile` | `~/.bash_login` |
    `~/.profile` 中**第一个存在**的一个;非 login 模式 `~/.bashrc`。
  - fish 集成**不得**改写 `XDG_CONFIG_HOME`(改用 `fish --init-command` 或 conf.d 之外的方式注入)。
  - helper 修好后 Continuo 再对 bash / fish 启用(删 `skipsShellIntegration` 分支),并更新上述 BDD 规范。

## Windows 上 DAP 端点改用命名管道并收紧 ACL

- **现状**(`electron/main/services/dap-client.ts`):POSIX 上 js-debug `dapDebugServer` 监听私有目录(0700)
  里的 unix socket;Windows 上监听 TCP `127.0.0.1` 随机端口 —— 本机其它用户也能连上,向 adapter 发 DAP
  请求(launch / evaluate 即以 Continuo 用户身份执行代码)。
- **待办**:Windows 上 DAP 端点改用命名管道(`\\.\pipe\...`)并收紧 ACL(仅当前用户),消除本机跨用户连接。
  需先验证 js-debug `dapDebugServer` 对 `\\.\pipe\` 路径的支持(其参数为 `[port|socket path] [host]`)。

## e2e 偶发 teardown 30s 超时:Electron 在 will-quit 之后的原生关闭阶段偶尔延迟约 30s 才退出

- **现象**:全量 e2e(437 用例)约每 3~4 轮出现 1 次某用例 `Tearing down "electronApp" exceeded the test timeout of 30000ms`,
  用例不固定(file-create / hotkey-override-trigger / settings-search-autofocus / palette-unbind-no-keycap /
  markdown-mode-segmented 等),单独循环重跑无法复现。
- **证据**(`tests/e2e/helpers/close-app.ts` 的 `captureMainProcessLog` + CONTINUO_E2E 下的 `[quit-trace]`):
  应用退出流程(flush / 最终检查 / 各项清理 / MCP 关闭)在 ~30-80ms 内完成并调用 `app.quit()`;窗口 close → closed →
  quit → will-quit(prevented=false)均在数毫秒内发生;但 Electron 进程在 will-quit 之后约 31.8s 才以 code=0 退出,
  `exit` 与 `close` 仅差 2ms(stdio 管道未被残留子孙进程持有)。
- **结论**:延迟发生在应用逻辑之外的 Electron/Chromium 原生关闭阶段;历史记忆中该现象早于本轮改动即存在。
- **未采用**:在清理完成后改用 `app.exit()` 强退 —— 会跳过 Chromium 的 localStorage / session 落盘等收尾,有丢数据风险。
- **后续方向**:用 `ELECTRON_ENABLE_LOGGING=1` / `--enable-logging --v=1` 抓原生关闭日志定位等待对象(GPU / network service /
  某个 utility process);确认后再决定是否在 e2e fixture 里放宽 teardown 超时或针对性规避。
