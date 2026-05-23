# agent-terminal-mcp-stdio-framing (Agent Terminal MCP Stdio Transport)

行为契约:**NDJSON 行解析器**。stdio MCP transport 的消息边界用 `\n` 分隔,
server / client 双方累积字节流,按行切分后逐行 parse JSON-RPC。本主题测
splitLines 纯函数,**不**测 socket server 真行为(留 E2E)。

> 配套:[doc/17-agent-terminal-mcp.md](../../../doc/17-agent-terminal-mcp.md) §4
> 设计动机:HTTP host 需 token + url 配置,每次 Continuo 重启 token rotate
> 用户得重 add。stdio transport 走 unix socket(file 权限 0600),Claude Code
> spawn CLI,无 token,一次 `claude mcp add` 永久使用。

## 模块

| 文件 | 职责 |
|---|---|
| `@continuo-terminal/server-node` CT-B1 `splitLines` | 共享 NDJSON 行切分 primitive |
| `electron/main/services/mcp-stdio-server.service.ts` | 完整 stdio socket server,适配 CT-B1 splitLines shape |

需 export:

| 名字 | 签名 | 描述 |
|---|---|---|
| `splitLines(buffer, chunk)` | `(string, string | Buffer) => { buffer, lines }` | 按 `\n` 切行,残行入 buffer |

```ts
interface SplitResult {
  readonly buffer: string;          // 新状态(残行)
  readonly lines: readonly string[]; // 完整行(不含末尾 \n)
}
```

## 关键行为

### `splitLines(state, chunk)`

- 把 chunk append 到 buffer 后,按 `\n` 切
- 完整行 push 到 lines(不含 `\n`)
- 最后一段(没遇到 `\n`)留在新 buffer
- 空字符串 chunk → buffer 不变,lines = []
- 多个 `\n` 连续 → 中间空字符串 lines 保留(调用方决定是否过滤)

CT-B3 adopts the CT-B1 splitter from `@continuo-terminal/server-node`.
CRLF handling now matches SDK stdio framing: a trailing `\r` before `\n`
is stripped. JSON-RPC stdio framing tolerates CRLF; payload itself never
contains CR. Pre-CT-B3 CR-retention was an accidental legacy detail, not a
feature contract.

### 边界

- 初始 buffer `''`
- chunk 不含 `\n` → 全留 buffer,lines = []
- chunk 全是 `\n` → 多个空 lines + buf 清空
- 跨 chunk 一行:第一 chunk `'{"a":'`,第二 chunk `'1}\n'` → 第二次调返回 lines = [`'{"a":1}'`]
- CRLF? SDK stdio parity strips trailing `\r` before `\n`;如果出现 `\r\n`,split 后 lines 不含行尾 `\r`

## 不在本主题验证

- socket 真启动 / 文件权限 0600 / connection 处理 — 留 E2E
- JSON-RPC parse / dispatch — 复用 mcp-host 已有 BDD
- CLI proxy 行为 — 留 manual 验证
