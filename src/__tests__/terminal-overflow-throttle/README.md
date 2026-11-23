# terminal-overflow-throttle

行为契约:**PTY 输出超过 2MiB/s 进入 overflow(单批截断到 64KiB 尾部 + 100ms 合批),速率回落后恢复普通 5ms
合批;空闲终端不持有周期定时器。**

主进程 `terminal.service` 以 1s 吞吐窗口(创建时刻对齐)按 UTF-8 字节累计输出,在 chunk 到达时按时间戳惰性滚动
窗口(此前每个 PTY 一个永久 1Hz `setInterval`,上限 256 会话 → 空闲时 256 次/秒唤醒主进程)。

overflow 只体现在输出批次本身(截断 + 更长的合批窗口)。早期另有 `terminal:overflow` /
`terminal:overflow-recovered` 两个推送事件及配套的恢复检查定时器,但 renderer 从未订阅,已删除。

## 行为

- 空闲终端、普通输出合批发送后:不持有任何定时器
- 窗口以创建时刻对齐:跨窗口边界的两段各 <2MiB 不截断;同一窗口内累计 >2MiB → 截断到 64KiB + 100ms 合批
- overflow 后流静默 → flush 完不残留定时器
- overflow 后下一窗口来低速输出 → 不截断,按普通 5ms 合批
- 下一窗口仍持续高速 → 继续截断
- 吞吐窗口用单调时钟:系统时间回拨不影响窗口滚动
- overflow 批次在途时会话被清理 → 定时器一并清除
