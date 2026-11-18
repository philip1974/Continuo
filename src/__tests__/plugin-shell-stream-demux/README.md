# plugin-shell-stream-demux(perf:preload 单 listener 分发)

## 行为

`app.shell.execStream()` 的 preload 适配层(`pluginShellStreamRaw.execStream`)接收 main 推送的
`plugin-shell-stream:event`。此前每次 execStream 都向同一通道挂一个独立 listener、回调里自行过滤
streamId → 活跃 S 条流时每个 chunk 触发 S 个 handler(单 renderer 上限 32 条)。

- 整窗口只挂**一个** EVENT listener,按 streamId 经 `Map` 定向分发到对应流
- listener 只在有活跃流时挂载:首条流注册时挂、最后一条流结束(exit / 合成 exit / 提前 return)时摘
- 非活跃流(含已结束流的迟到事件)的事件被忽略
- 无主畸形 payload(无 string streamId)只 warn 一次并丢弃,不影响任何活跃流
- 本流畸形 payload → 只收敛本流(合成 exit -1),其它流不受影响

## 未做:main 侧 chunk 合批

见实现 commit 说明:收益次要(IPC 次数本就受 OS pipe 读块大小约束),合批会引入额外延迟与新的定时器
生命周期(finalize / forceKill / wc-gone 各路径都要 flush 或清理),风险大于收益。

## 实现

`electron/preload/plugin-shell-stream.preload.ts`:`streamHandlers` + `onStreamEvent`。
