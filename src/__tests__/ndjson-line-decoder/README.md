# ndjson-line-decoder (E135)

stdio MCP NDJSON framing 的流式行解码器:socket Buffer chunk 可能切在多字节 UTF-8 字符中间,
须用 `TextDecoder({stream:true})` 跨 chunk 缓存未完成序列、正确还原后再按 '\n' 分行。

## 行为契约
- 多字节字符(CJK/emoji)被拆到多个 chunk → 整体正确还原(非逐 chunk toString 的 U+FFFD 损坏)。
- 多行一次返回;尾随 \r 剥离;未终结残行留在 `buffered`(供字节上限背压检查)。

边界审计 E135(替代 @continuo-terminal/server-node splitLines 的跨 chunk 拆字 bug;E131/E132 同族)。
