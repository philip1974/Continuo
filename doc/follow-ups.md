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
