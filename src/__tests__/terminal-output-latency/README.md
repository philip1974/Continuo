# terminal-output-latency

行为契约:**PTY 输出到 renderer 的批处理延迟不拖慢交互回显**。

主进程 `terminal.service` 对 PTY chunk 做时间窗合批(减少 IPC 次数)。窗口过长会让每次按键的
回显都晚到 —— zsh 等行编辑器的回显几乎都带清行 / 光标移动 CSI(`\x1b[K`、`\x1b[1D` …),
此前走 64ms 的「原地更新」窗口,用户可感知输入延迟。

参考 VSCode `TerminalDataBufferer`:统一 5ms 合批。

## 行为

- 普通小输出(回显字符)在 **≤ 5ms** 内送达 renderer
- 含原地更新 CSI 的小输出(行编辑器回显 / 进度刷新)同样 **≤ 5ms**(不再单独放宽窗口)
- 同一窗口内连续到达的多个 chunk 仍合并为**一次** IPC 发送(合批不退化)
- overflow 时(>2MB/s)维持原有 100ms 窗口 + 截断(不在本主题改)
