# agent-terminal-mcp-buffer (Agent Terminal MCP Phase 3)

行为契约:**per-session 环形 buffer + ANSI 剥离**。
PTY 输出 chunk 按 seq(单调递增)入 buffer;`terminal.read_output` MCP tool
通过本 service 增量读 + 按行切 + 可选 strip ANSI。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §5.3
> 容量决策:8000 chunk(粗估 ~几 MB,够 agent 长时间观察输出)。

## 模块

| 文件 | 职责 |
|---|---|
| `electron/main/services/terminal-buffer.service.ts` | per-session Map<id, SessionBuffer> + ensure/append/read/destroy + stripAnsi 纯函数 |

需 export:

| 名字 | 签名 | 描述 |
|---|---|---|
| `stripAnsi(s)` | `(string) => string` | 去 CSI(ESC [ ... letter)序列,保留普通文本 |
| `ensure(id)` | `(string) => void` | 创建空 buffer(已存在 → no-op) |
| `append(id, data)` | `(string, string) => void` | 入 chunk,自动 ensure;内部 seq +1 |
| `read(id, opts?)` | `(string, ReadOptions?) => ReadResult` | 增量读 + 切行 + 可选 strip |
| `destroy(id)` | `(string) => void` | 删 buffer(session 关闭时调) |
| `_resetForTest()` | `() => void` | 清所有 buffer + counter |

```ts
interface ReadOptions {
  readonly sinceSeq?: number;       // 缺省:0(返回所有当前 entries)
  readonly maxLines?: number;       // 默认 200,超 → truncated=true,取最后 N 行
  readonly stripAnsi?: boolean;     // 默认 true
}

interface ReadResult {
  readonly lines: string[];
  readonly nextSeq: number;         // 客户端下次传作 sinceSeq 实现增量
  readonly truncated: boolean;      // maxLines 截断 / buffer 满丢底
}
```

## 关键行为

### `stripAnsi(s)`

去除 CSI 序列(`\x1b[...letter`),保留普通文本。
- `'\x1b[31mred\x1b[0m'` → `'red'`
- `'plain text'` → `'plain text'`
- `'\x1b[2J\x1b[H' + 'hello'` → `'hello'`(清屏 + 光标定位被剥)
- 多字节 UTF-8 不破坏(ESC byte 是 0x1b,UTF-8 字节都 ≥ 0x80,不冲突)

### `ensure(id)` / `append(id, data)`

- ensure 创建空 buffer,seq counter = 0
- 重复 ensure 同 id → no-op(不重置)
- append 不存在的 id → 自动 ensure 后追加(silent)
- append 同一 id 多次 → seq 单调递增 0, 1, 2, ...
- 容量超 8000 → entries[0] 丢弃,但 seq counter 不复用(下一条仍 +1)

### `read(id, opts)`

- 不存在 id → 抛 `BUFFER_SESSION_NOT_FOUND`(read_output tool 转 INVALID_PARAMS)
- 空 buffer → `{ lines: [], nextSeq: 0, truncated: false }`
- sinceSeq 缺省 → 0(从最早 entry,buffer 满时即"自动从最近保留的开始")
- sinceSeq 大于所有现有 seq → `{ lines: [], nextSeq: 当前 nextSeq, truncated: false }`
- 合并 sinceSeq 之后的 entries.data → 如果 stripAnsi=true(默认)→ stripAnsi 后切 \r?\n
- 末尾连续空字符串行 trim(对 agent 友好,因 PTY 输出多以 \n 结尾)
- lines 超 maxLines → truncated=true,取最后 maxLines 行
- buffer 满丢底导致 entries[0].seq > sinceSeq → truncated=true(数据有缺口)

### `destroy(id)`

- 删 buffer + counter,后续 read 抛 BUFFER_SESSION_NOT_FOUND

## 不在本主题验证

- `terminal.service.ts` 在 onData 内调 append — 留 E2E 集成
- `read_output` MCP tool 接 buffer service — 在 `agent-terminal-mcp-read-output`
- 真 PTY 输出节流 / overflow 触发 — 在 `terminal-service`
