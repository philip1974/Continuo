# terminal-buffer-capacity · 终端输出缓冲区容量

## 背景

Continuo 的终端 PTY 输出走 `@continuo-terminal/server-node` 的 `SessionManager`，每个会话有一个按**字节**截断的环形缓冲（FIFO）。`terminal_read_output` MCP 工具从该缓冲读取累积输出。

当缓冲容量过小时，较长的 agent 报告（例如经 Continuo MCP 终端跑的 codex 复审报告）会在被 `terminal_read_output` 读取**之前**就从缓冲头部被 FIFO 丢弃，导致读到的内容残缺（`truncated=true`），无法看到报告全文。

历史上 `terminal.service.ts` 把 `maxBytes` 硬编码压到 64 KiB，过小导致长报告提前丢失；曾恢复为库默认 4 MiB。当前 Continuo 显式选定 **1 MiB**（= B3 防回退下限），在内存占用与"长报告防丢"之间取折中，并用规范锁定这一容量契约，防止再次回退到 KiB 量级。

## 行为契约

- **B1 缓冲容量为显式选定值**：Continuo 实例化 `SessionManager` 时传入的 `maxBytes` 必须为 1 MiB（`1 * 1024 * 1024` 字节）—— Continuo 显式选定的每会话缓冲容量。

- **B2 容量是显式声明而非沿用隐式默认**：Continuo 必须在构造 `SessionManager` 时**显式**传入 `maxBytes`，使容量是仓内可审计的契约，而不是依赖上游库的默认值（上游改默认不应静默改变 Continuo 的行为）。

- **B3 防回退下限**：传入的 `maxBytes` 不得低于 1 MiB —— 锁住"长报告防丢"的最低保障，任何把容量压回 KiB 量级的改动都应让本规范失败。

## 备注

- 该容量是**每会话**常驻内存上限（按字节计）。
- 单次 `terminal_read_output` 仍受协议层 `READ_OUTPUT_MAX_LINES = 2000` 行上限约束；读取超长输出需配合 `since_seq` 游标分页。本主题只覆盖"缓冲不提前丢内容"，不覆盖单次读取截断。
