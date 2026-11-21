# json-byte-budget (E286)

边界(E286，E283/E285「stringify 前 fail-fast」族 —— 字节预算维度）。

多处入口用 `assertJsonValue(x)` → `JSON.stringify(x)` → `utf8BytesExceed(serialized, CAP)` 校验序列化字节
上限。`assertJsonValue` 只限**形态**（数组 1M / 对象 10万 key / key 长 8192 / string 值 16MiB / 深度 256），
远超各调用方字节 CAP（RESULT_BYTES_MAX 10MiB / SCHEMA_BYTES_MAX 64KiB / MAX_PLUGIN_DATA_BYTES 16MiB）。
形态合法但「很多中等元素」的序列化字节可远超 CAP —— 而字节上限在 `JSON.stringify` **之后**才裁决，那个
stringify 已先把巨大字符串物化（stringify 本身=OOM 点）。

`jsonByteLowerBoundExceeds(value, limit)` 在 stringify **之前**对序列化字节做**下界**估算并短路：
下界 > CAP ⇒ 真实字节必 > CAP（下界永不高估）⇒ 安全提前拒，**不改变 accept/reject 判定**（合法输入
下界 ≤ CAP 照常走精确 stringify 裁决）。

## 行为契约

- 下界永不高估：`jsonByteLowerBoundExceeds(v, L) === true` ⇒ `utf8ByteLength(JSON.stringify(v)) > L`。
- 永不误伤：序列化字节 ≤ L 的值 → 返回 `false`（含转义致下界 < 真实的情形）。
- 短路 fail-fast：「很多中等元素」的形态合法值 → 在不物化完整序列化字符串的前提下提前判超限。
- 收口接线：result（isInvokeResultAdmissible）/ schema（RegisterPayloadSchema）/ plugin-data
  （renderer PluginDataStore + main plugin-data-store.service）全部在 stringify 前调用本 helper。
