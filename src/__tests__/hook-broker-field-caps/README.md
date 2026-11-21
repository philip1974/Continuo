# hook-broker-field-caps (E150)

stop-hook broker 的 parseStopPayload 各字段长度上限:标识/路径 ≤FIELD_MAX(1024)、
last_assistant_message ≤LAST_MSG_MAX(64KiB)。

防单字段接近 MAX_HOOK_FILE_BYTES(1MiB)进 buffered / 非 raw MCP 响应 / 日志放大。
配合 broker buffered 总字节预算(MAX_BUFFERED_BYTES,可注入 maxBufferedBytes)双闸淘汰。
