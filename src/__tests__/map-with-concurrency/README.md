# map-with-concurrency (E234/E251)

有界并发的 allSettled helper(`allSettledWithConcurrency`)。worker 池把最大同时在途任务数钳到 limit,
保留 allSettled 语义(结果按输入顺序对位 + 单任务失败不影响其它)。

## 行为契约

- 结果与输入等长、按 index 对位;每项 {status:'fulfilled',value} 或 {status:'rejected',reason}。
- 最大同时在途 fn 数 ≤ limit。
- 边界(E251):limit 非有限(NaN/Infinity)/≤0/小数 → 归一化为有效正整数(非有限/≤0 视为 1,小数 trunc),
  绝不产生 0 worker 而静默丢全部任务(Math.max(1,Math.min(NaN,len))=NaN → Array.from({length:NaN})=0)。
- 空输入 → 返回 []。
