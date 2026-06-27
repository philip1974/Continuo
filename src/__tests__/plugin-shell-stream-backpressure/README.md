# plugin-shell-stream-backpressure (E61)

边界审计 E61(外部输入边界族,流式 shell 背压)。

## 行为

`app.shell.execStream()` 的 preload 适配层(`pluginShellStreamRaw.execStream`)在消费者未及时
`next()` 时把到达的 stdout/stderr chunk 缓冲进 `chunkQueue`。此前缓冲无上限:插件启动高输出命令
却不消费/慢消费,preload 内存随输出无界增长(命令最长跑 5-30min)。

- 未消费缓冲总字节超 `MAX_STREAM_QUEUE_BYTES`(16MiB)→ 自动 ABORT 子进程 + 合成错误 exit
  (exitCode -1),并停止接收更多 chunk(摘 EVENT listener);已缓冲的 chunk 仍可被消费者 drain。
- 上限内正常消费 → 不触发背压 ABORT(消费即释放 `queuedBytes` 计数)。

## 实现

`electron/preload/plugin-shell-stream.preload.ts`:`queuedBytes` 跟踪未消费字节,push 时累加、
next() shift 时释放;超限走 ABORT + synthesizeExit。
