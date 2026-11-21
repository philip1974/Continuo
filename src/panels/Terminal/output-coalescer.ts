// 终端输出写入合并(性能 P1,见 src/__tests__/terminal-write「写入合并」)。
//
// 主进程按 5ms 合批推 terminal:data,持续输出时约每 5-6ms 一条小块(通常远小于 16KB)。
// 下游 safeWrite 按 chunk 数节流:每轮排空只同步写前 4 个 chunk,之后每 8ms 只写 1 个,
// 与 chunk 大小无关 → 到达 ~166 条/s > 排空 ~125 条/s,积压与显示延迟随时间线性增长。
// 这里在 safeWrite 之前把一个短窗口内的小块拼成接近 CHUNK_SIZE 的一次调用,排空能力回到
// 按字节(≈16KB/8ms)。
//
// 节流语义(leading + trailing):空闲后的前 OUTPUT_COALESCE_LEADING_CHUNKS 块立即写出 —— 交互回显 /
// prompt 零额外延迟,且一屏 TUI 重绘跨主进程 5ms 合批边界拆成的 A、B 两条仍同帧渲染(只立即写首块时
// B 必等满窗口,半帧画面可见)。之后窗口内到达的块进缓冲,窗口结束一次写出,有数据则续开窗口,空窗口
// 回到空闲。持续输出时立即写只占每轮空闲后的头两块,写入频率仍由窗口决定(不回到逐条写)。
// 用 setTimeout 而非 rAF:rAF 在隐藏 tab / 窗口会暂停,缓冲会滞留到切回可见。

/** 合并窗口:约一帧。 */
export const OUTPUT_COALESCE_WINDOW_MS = 16;
/** 空闲后立即写出的块数(首块 + 紧随的一块)。 */
export const OUTPUT_COALESCE_LEADING_CHUNKS = 2;
/** 缓冲上限 = safeWrite 的 CHUNK_SIZE(16KB,按 UTF-16 code unit 计):每次写出恰占一个节流槽。 */
export const OUTPUT_COALESCE_MAX_CHARS = 16 * 1024;

export interface OutputCoalescer {
  push(data: string): void;
  /** 丢弃未写出的缓冲并停止写出(与 disposeQueue 丢弃排队 chunk 的语义一致)。 */
  dispose(): void;
}

export function createOutputCoalescer(write: (data: string) => void): OutputCoalescer {
  let parts: string[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  /** 本轮空闲后还可立即写出的块数;缓冲一旦开始累积即不再立即写(保持顺序)。 */
  let leadingLeft = 0;

  const flush = () => {
    if (size === 0) return;
    const data = parts.length === 1 ? parts[0]! : parts.join('');
    parts = [];
    size = 0;
    write(data);
  };

  const onWindowEnd = () => {
    timer = null;
    leadingLeft = 0;
    if (disposed || size === 0) return; // 空窗口 → 回到空闲
    flush();
    timer = setTimeout(onWindowEnd, OUTPUT_COALESCE_WINDOW_MS);
  };

  return {
    push(data) {
      if (disposed || data.length === 0) return;
      if (timer === null) {
        // 空闲:立即写出,并开窗口收集紧随其后的块
        write(data);
        leadingLeft = OUTPUT_COALESCE_LEADING_CHUNKS - 1;
        timer = setTimeout(onWindowEnd, OUTPUT_COALESCE_WINDOW_MS);
        return;
      }
      if (leadingLeft > 0 && size === 0) {
        leadingLeft -= 1;
        write(data);
        return;
      }
      leadingLeft = 0;
      // 加入会超上限 → 先写出已缓冲部分,保持每次写出 ≤ 一个 chunk
      if (size + data.length > OUTPUT_COALESCE_MAX_CHARS) flush();
      parts.push(data);
      size += data.length;
      if (size >= OUTPUT_COALESCE_MAX_CHARS) flush();
    },
    dispose() {
      disposed = true;
      parts = [];
      size = 0;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
