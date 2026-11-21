# terminal-write (M-Terminal Step T4)

行为契约:**Renderer 端 safeWrite 异步写队列**。
xterm.js 一次性写超大 buffer 会阻塞 UI 渲染;safeWrite 切 16KB chunks,
8ms 一片让出主线程。

## 模块

| 文件 | 职责 |
|---|---|
| `@continuo-terminal/react-terminal` (safeWrite) | chunkifyData(纯)+ safeWrite + disposeQueue(state)(已上游化到共享包) |

## 关键行为

### `chunkifyData(data, chunkSize)` 纯函数
- 数据 ≤ chunkSize → 一片
- 超出 → 切等长 chunks(最后一片可能更小)
- 空字符串 → 空数组
- chunkSize 不影响数据完整性(顺序拼回 = 原 data)

### `safeWrite(term, data)`
- 把 data 切片入 queue,逐片 term.write,8ms 间隔
- 同 term 多次 safeWrite 共享 queue(不并发,顺序处理)

### `disposeQueue(term)`
- 移除 term 的队列(防止 component unmount 后还在写)

### 写入合并(`src/panels/Terminal/output-coalescer.ts`,useTerminal 接在 safeWrite 之前)
- 背景:主进程 5ms 合批,持续输出约每 5-6ms 一条小块;safeWrite 按 chunk **数**节流(burst 4 片后每 8ms 1 片,
  与大小无关)→ 到达 ~166 条/s > 排空 ~125 条/s,积压与显示延迟线性增长
- 空闲时首块**立即**写出(无首字节延迟);随后 16ms 窗口内的块合并为一次写出,有数据续开窗口,空窗口回空闲
- 每次写出 ≤ 16KB(= safeWrite CHUNK_SIZE):加入会超限先写出已缓冲部分;累计达限立即写出;单块本身超限整块直写
- 输出内容与顺序与逐块直写完全一致
- 卸载 / 切 session:未写出的缓冲丢弃并撤销定时器(与 disposeQueue 丢弃排队 chunk 一致),不写已 dispose 的 xterm
- 用 setTimeout 而非 rAF(隐藏 tab 下 rAF 暂停)

## 不在本主题验证

- xterm 真渲染(留 E2E)
- React useEffect 生命周期(同上)
- IPC onData 真触发(留 E2E)
