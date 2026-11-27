# terminal-pty-fd-leak

行为契约:**关闭终端后主进程不残留 PTY 句柄**。开关多少个终端,主进程持有的 PTY 主端(`/dev/ptmx`)、
从端(`/dev/ttys*`,子进程退出后显示为 `(revoked)`)与 kqueue 数都回到开终端前的基线。

## 背景

node-pty 1.1.0 在 macOS 走 `posix_spawn` 路径(`src/unix/pty.cc` 的 `pty_posix_spawn`):父进程打开 slave
设好终端属性后从不 `close(slave)`,等待子进程退出的 kqueue 也不关。每关一个终端主进程就多 1 个 ptmx 主端 +
1 个 revoked 从端 + 1 个 KQUEUE;macOS `kern.tty.ptmx_max = 511`,累计约 400+ 次后全机都建不了新终端。
node-pty 1.2.0-beta.18 在 `done:` 段补了 `close(slave)` 并关闭 kqueue,Continuo 据此把 node-pty 锁到该版本
(并经 pnpm overrides 让 sibling `server-node` 共用同一份,主进程 bundle 与测试加载的是同一个 native 模块)。

## 模块

| 文件 | 职责 |
|---|---|
| `package.json` / `pnpm-workspace.yaml` | `node-pty` 精确版本 + overrides(pnpm 9 读前者,pnpm 10+ 读后者) |
| sibling `@continuo-terminal/server-node` `SessionManager` | 主进程实际 spawn / kill PTY 的地方(terminal.service 经它关终端) |

## 关键行为

- 真实 spawn N 个 PTY 后以 SIGKILL 关闭(⌘W 关终端走的 `sm.kill({ signal: 'SIGKILL' })`)→ PTY 相关 fd 回到基线。
- 真实 spawn N 个 PTY 后让 shell 自行 `exit`(exit 后关面板)→ PTY 相关 fd 回到基线。
- 计数:macOS 用 `lsof -p` 数 `/dev/ptmx`、`/dev/ttys*` / `(revoked)`、`KQUEUE`;Linux 读 `/proc/self/fd`
  数 `/dev/ptmx` 与 `/dev/pts/*`。Windows(ConPTY 无此类 fd)或无 `/bin/sh` → 跳过。
- e2e(`tests/e2e/terminal-pty-fd-leak.spec.ts`):真实应用里开关 10 个终端,主进程 PTY 相关 fd 不增长(仅 macOS)。

## 不在本主题验证

- Windows ConPTY 句柄泄漏(无本机验证手段)。
