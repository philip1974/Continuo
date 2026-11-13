# terminal-service (M-Terminal Step T1)

行为契约:**主进程 PTY service 的纯函数部分**(节流截断、ANSI 检测)。
node-pty 真行为(spawn/write/resize/kill)需 Electron 运行时,留 E2E 验证。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/terminal.service.ts` | createTerminal/write/resize/interrupt/kill + helpers |

## 关键行为(本主题覆盖)

### `safeTruncate(data, maxBytes)`
- data.length ≤ maxBytes → 原样返回
- 超出 → 保留尾部 maxBytes 字节,前置 `\x1b[0m` 重置 ANSI 状态
- 截断点落在某个 CSI 序列内部(含恰好落在终结符上)→ 截断点向后挪到该序列之后(不留半截色码残片,
  且总字节仍 ≤ maxBytes)

### `isInPlaceUpdate(data)`
- 含 `\x1b[<n>(A|B|C|D|G|H|K)`(光标移动 / 清行 / 定位)且长度 < 512 → true
- 用于 flush 节流:in-place 更新延后到 64ms(降帧率,避免抖动)

## 不在本主题验证

- node-pty spawn / write / resize 真行为(留 E2E)
- IPC 接线(留 T2 fs-ipc-bridge 风的 spec)
- 多 session 并发(留 T3 store + T5 集成)
