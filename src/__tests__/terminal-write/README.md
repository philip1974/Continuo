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

## 不在本主题验证

- xterm 真渲染(留 E2E)
- React useEffect 生命周期(同上)
- IPC onData 真触发(留 E2E)
