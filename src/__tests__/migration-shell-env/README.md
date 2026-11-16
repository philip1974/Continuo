本主题验证 Continuo 侧 terminal shell-env host-helper API 已从 ContinuoTerminal 的 `@continuo-terminal/server-node` 导入,并能在 Continuo terminal 链路中使用。Byte-identical snippet 测试已委托给 ContinuoTerminal 包级 TDD,本 BDD 只覆盖外部行为契约。

## spawn 参数约定(`integration-args-contract.spec.ts`)

- `prepareShellIntegrationEnv` 返回 `{ env, args, cleanup }`;Continuo 只使用 env / cleanup,
  **暂不采用 bash 的 `args`**(`['--rcfile', <生成的 rc>, '-i']`):那是非 login 启动,不读
  `/etc/profile`(macOS `path_helper` 在此),且 rcfile 无条件依次 source `~/.bash_profile` /
  `~/.profile` / `~/.bashrc` → 重复执行、偏离原 `-l -i` 语义。代价是 bash 暂无 OSC7 cwd hook,
  待 helper 模拟 login 启动文件选择后再启用(跨仓 follow-up 见 `doc/follow-ups.md`)。
- bash 且用户未传 args → `['-l', '-i']`。
- 用户显式传 args → 用户 args 优先。
- zsh / fish → 仍走 `defaultShellArgs`(`-l -i`)。
