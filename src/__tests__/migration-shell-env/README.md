本主题验证 Continuo 侧 terminal shell-env host-helper API 已从 ContinuoTerminal 的 `@continuo-terminal/server-node` 导入,并能在 Continuo terminal 链路中使用。Byte-identical snippet 测试已委托给 ContinuoTerminal 包级 TDD,本 BDD 只覆盖外部行为契约。

## spawn 参数约定(`integration-args-contract.spec.ts`)

- `prepareShellIntegrationEnv` 返回 `{ env, args, cleanup }`,调用方必须同时使用 env 与 args。
- bash 且用户未传 args → 以 helper 的 `['--rcfile', <生成的 rc>, '-i']` 启动(不再用 `-l -i`:
  login bash 不读 `--rcfile`,交互式 bash 又忽略 `BASH_ENV`,否则 OSC7 cwd hook 永不安装);
  生成的 rcfile 回 source `~/.bash_profile` / `~/.profile` / `~/.bashrc` 补齐 login 语义。
- 用户显式传 args → 用户 args 优先。
- helper 返回空 args(zsh / fish / 其它)→ 仍走 `defaultShellArgs`(zsh/bash/fish 为 `-l -i`)。
