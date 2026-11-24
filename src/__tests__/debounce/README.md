# debounce(尾随防抖,可选 maxWait)

行为契约:**连续调用只在最后一次之后 delay 毫秒执行一次,参数取最后一次;给定 maxWait 时,自本轮首次调用起
至多 maxWait 毫秒必执行一次(lodash maxWait 语义),执行后开始新一轮。`cancel()` 丢弃未执行的调用。**

Explorer fs watch 的按 path 防抖(makeDebouncePerPath)与终端 OSC7 cwd 上报此前各手写一份 maxWait 公式,
现共用本实现。

## 接线守卫

fs-watch-helpers、useTerminal 调用 `debounce(`,且不再含手写的 `firstAt + ... - Date.now()` / `cwdFirstAt` 公式。
