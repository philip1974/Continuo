# terminal-overflow-throttle

行为契约:**PTY 输出超过 2MiB/s 进入 overflow(截断 + 100ms 合批 + `terminal:overflow`),速率回落后发
`terminal:overflow-recovered`;空闲终端不持有周期定时器。**

主进程 `terminal.service` 以 1s 吞吐窗口(创建时刻对齐)按 UTF-8 字节累计输出。此前每个 PTY 一个永久 1Hz
`setInterval` 清零计数并补发恢复(上限 256 会话 → 空闲时 256 次/秒唤醒主进程)。现改为在 chunk 到达时按时间戳
惰性滚动窗口,只在 overflow 期间按窗口边界安排一次性恢复检查,语义与旧 interval 等价。

## 行为

- 空闲终端、普通输出合批发送后:不持有任何定时器
- 窗口以创建时刻对齐:跨窗口边界的两段各 <2MiB 不触发 overflow;同一窗口内累计 >2MiB → overflow
- overflow 后流静默 → 在 overflow 所在窗口之后的第二个边界补发 recovered(t=0 进入 → t=2000),之后不再持有定时器
- overflow 后下一窗口来低速输出 → 立即 recovered(chunk 路径)
- 下一窗口仍持续高速 → 该窗口结束时不恢复,再下一边界静默时恢复
- 系统时间回拨 → 以当前时刻重新起窗,仍能及时恢复(不因墙钟回退长期卡在 overflow)
- overflow 期间会话被清理 → 恢复检查定时器一并清除
