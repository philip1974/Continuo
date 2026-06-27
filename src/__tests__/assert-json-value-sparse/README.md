# assert-json-value-sparse (E183)

assertJsonValue 数组分支:限 length 上限(1M)+ 索引循环拒 sparse 空洞。防 `new Array(1e9)` 稀疏巨
数组绕过校验后 JSON.stringify OOM,及空洞被序列化成 null 的「校验通过但落盘变形」。
