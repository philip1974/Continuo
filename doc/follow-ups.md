# 跨仓 / 待办 follow-ups

已识别、本仓暂不处理(需兄弟仓库或后续专项)的事项。处理完从此处删除并在 commit 中说明。

## ContinuoTerminal `server-node` · bash shell integration 需模拟 login 启动

- **现状**:`prepareShellIntegrationEnv` 给 bash 返回 `['--rcfile', <生成的 rc>, '-i']`(非 login)。
  生成的 rcfile 无条件依次 source `~/.bash_profile` / `~/.profile` / `~/.bashrc`,且不读
  `/etc/profile`(macOS `path_helper` 在其中)→ 启动文件重复执行、PATH 与原 `-l -i` 不一致。
- **Continuo 侧处理**:`electron/main/services/terminal.service.ts` 暂不采用 helper 的 bash args,
  bash 仍以 `-l -i` 启动(代价:bash 无 OSC7 cwd 跟踪)。契约见
  `src/__tests__/migration-shell-env/integration-args-contract.spec.ts`。
- **helper 需改**(参考 VSCode `shellIntegration-bash.sh` 的 login 模拟):rcfile 内按 bash 自身规则选择
  启动文件 —— login 模式:`/etc/profile` + `~/.bash_profile` | `~/.bash_login` | `~/.profile` 中
  **第一个存在**的一个;非 login 模式:`~/.bashrc`。helper 改好后 Continuo 恢复使用其 bash args,
  并更新上述 BDD 规范。
