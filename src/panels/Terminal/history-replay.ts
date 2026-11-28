// 历史回放按录制时的 PTY 尺寸分段写入(对齐 VSCode BasePty.handleReplay:每段先 OverrideDimensions 到录制尺寸、
// 等写入提交,全部回放完再撤掉覆盖;录制侧见 main 的 recordPtyDimensions / VSCode TerminalRecorder)。
// 原始输出里的自动换行、光标定位都按产生时的宽度编码:按当前宽度回放(popout 里的终端崩溃恢复后回到主窗、
// 窗口宽度变了之后重新挂载)会整屏错位;按原宽度写入后再 resize,由 xterm 重排。见 src/__tests__/terminal-replay-dimensions。

import type { Terminal } from '@xterm/xterm';
import type { TerminalHistorySnapshot } from '../../../electron/shared/terminal-channels';

export interface ReplaySegment {
  readonly data: string;
  readonly cols: number;
  readonly rows: number;
}

/**
 * 快照 → 按尺寸切开的段。不需要分段(无尺寸记录 / 只有一段且与当前尺寸相同 / 坐标缺失)→ null,调用方照常整段写入。
 * 截断快照开头的 reset 前缀(不计入坐标)归入第一段。
 */
export function replaySegments(
  snapshot: TerminalHistorySnapshot,
  current: { readonly cols: number; readonly rows: number },
): ReplaySegment[] | null {
  const { data, startOffset, endOffset, dimensions } = snapshot;
  if (!dimensions || dimensions.length === 0 || startOffset === undefined || endOffset === undefined) return null;
  const only = dimensions.length === 1 ? dimensions[0]! : null;
  if (only && only.cols === current.cols && only.rows === current.rows) return null;
  const prefix = data.length - (endOffset - startOffset);
  if (prefix < 0) return null;
  const segments: ReplaySegment[] = [];
  for (let i = 0; i < dimensions.length; i++) {
    const d = dimensions[i]!;
    if (!(d.cols > 0) || !(d.rows > 0)) return null;
    const from = i === 0 ? 0 : prefix + Math.max(0, d.offset - startOffset);
    const next = dimensions[i + 1];
    const to = next ? prefix + Math.max(0, next.offset - startOffset) : data.length;
    const piece = data.slice(from, Math.min(to, data.length));
    if (piece) segments.push({ data: piece, cols: d.cols, rows: d.rows });
  }
  return segments.length > 0 ? segments : null;
}

/**
 * 逐段:resize 到录制尺寸 → 写入并等 xterm 解析完 → 下一段;最后恢复回放前的尺寸(调用方随后按容器 fit)。
 * isCancelled:面板已卸载 / term 已 dispose → 立即停止(不再碰 term)。
 */
export async function replayWithDimensions(
  term: Pick<Terminal, 'cols' | 'rows' | 'resize' | 'write'>,
  segments: readonly ReplaySegment[],
  isCancelled: () => boolean,
): Promise<void> {
  const restore = { cols: term.cols, rows: term.rows };
  for (const segment of segments) {
    if (isCancelled()) return;
    if (term.cols !== segment.cols || term.rows !== segment.rows) term.resize(segment.cols, segment.rows);
    await new Promise<void>((resolve) => term.write(segment.data, resolve));
  }
  if (isCancelled()) return;
  if (term.cols !== restore.cols || term.rows !== restore.rows) term.resize(restore.cols, restore.rows);
}
