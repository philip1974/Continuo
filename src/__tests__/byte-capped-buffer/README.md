# byte-capped-buffer (E131)

git stderr 等流式输出按真实 UTF-8 **字节**累积并在字节上限处截断,decode 延后整体进行。

## 行为契约
- 跨 chunk 边界的多字节字符整体 decode 不乱码(非逐 chunk `String(chunk)`)。
- 字节上限按真实 UTF-8 字节(非 UTF-16 `String.length` code unit)截断,超限置 `truncated`。
- 截断后继续 `push` 被忽略。

边界审计 E131(E62 stderr 上限 / E125 byte-vs-char 字节语义族)。
