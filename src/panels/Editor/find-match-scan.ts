// 查找计数的分片扫描(对齐 VSCode 查找控件:计数 / 装饰不阻塞按键,见 findModel.ts 的 _updateDecorationsScheduler)。
// CodeMirror 的 SearchCursor.next() 一次调用会一直扫到下一个匹配 —— 罕见词 / 不存在的词在 10 万行文档上一次就是整篇(~0.5s),
// 无法中途让出。这里把文档切成块,每块一个限定范围的 cursor,按时间预算一块一块扫;结果与整篇一个 cursor 扫出的序列一致
//(不重叠、按位置升序;块边界处理见 step)。
// BDD: src/__tests__/editor-find-widget/

import type { EditorState } from '@codemirror/state';
import type { SearchQuery } from '@codemirror/search';
import { FIND_MATCH_LIMIT } from './find-widget-model';

/** 普通文本查询的块大小(UTF-16 码元)。实测 ~20K 码元 / ms:一块约 1–2ms,时间预算按块检查。 */
const LITERAL_CHUNK = 32 * 1024;
/** 正则块大小(块边界对齐到行,见 step)。 */
const REGEXP_CHUNK = 64 * 1024;
/** 可跨行的正则(同 @codemirror/search 选用 MultilineRegExpCursor 的判断):块尾向后多扫这么多,接住跨块边界的匹配。 */
const MULTILINE_OVERLAP = 64 * 1024;
const MULTILINE_REGEXP = /\\[sWDnr]|\n|\r|\[\^/;

export interface MatchScanOptions {
  readonly limit?: number;
  /** 测试用:块大小(码元)。 */
  readonly chunk?: number;
}

export class MatchScan {
  /** 已数到的匹配(扁平 [from, to, ...],升序)。 */
  readonly ranges: number[] = [];
  /** 超过上限停止(第 limit + 1 个匹配存在)。 */
  capped = false;
  done = false;
  /** 下一块的起点。 */
  private pos = 0;
  /** 上一个已收匹配的终点:下一块从不早于它处开始(与整篇 cursor 一样不收重叠匹配)。 */
  private lastTo = 0;
  private readonly limit: number;
  private readonly chunk: number;
  private readonly overlap: number;

  constructor(
    private readonly state: EditorState,
    private readonly query: SearchQuery,
    options: MatchScanOptions = {},
  ) {
    this.limit = options.limit ?? FIND_MATCH_LIMIT;
    this.chunk = options.chunk ?? (query.regexp ? REGEXP_CHUNK : LITERAL_CHUNK);
    // 文本查询:一个匹配在文档里的跨度不超过归一化(NFKD + 大小写)后的查询长度的两倍(代理对);用原查询词(转义 \n 等反转义后只会更短)
    this.overlap = query.regexp
      ? MULTILINE_REGEXP.test(query.search)
        ? MULTILINE_OVERLAP
        : 0
      : query.search.normalize('NFKD').toLowerCase().length * 2 + 16;
    if (!query.valid) this.done = true;
  }

  /** 扫到结束或 `now()` 达到 deadline(按块检查,至少扫一块);返回是否已扫完。 */
  run(deadline: number, now: () => number = () => performance.now()): boolean {
    while (!this.done) {
      this.step();
      if (now() >= deadline) break;
    }
    return this.done;
  }

  /**
   * 扫一块 [start, chunkEnd):cursor 范围延伸到 chunkEnd 之后 overlap(接住起点在块内、终点越过块尾的匹配),只收起点在
   * [start, chunkEnd) 的匹配;最后一块不设上界(文档末尾的空匹配也收)。
   */
  private step(): void {
    const { doc } = this.state;
    const len = doc.length;
    // 块边界对齐到行:正则的 ^ / 后顾依赖行首上下文;全字匹配的词边界判断把 cursor 缓冲区的首尾当边界(整篇扫描时缓冲区就是一行)
    const aligned = this.query.regexp || this.query.wholeWord;
    const start = Math.max(this.pos, this.lastTo);
    let chunkEnd = Math.min(len, start + this.chunk);
    // 推到下一行行首
    if (aligned && chunkEnd < len) chunkEnd = Math.min(len, doc.lineAt(chunkEnd).to + 1);
    const last = chunkEnd >= len;
    let cursorTo = len;
    if (!last) {
      cursorTo = Math.min(len, chunkEnd + this.overlap);
      if (aligned && cursorTo > chunkEnd) cursorTo = doc.lineAt(cursorTo).to;
    }
    // 对齐时从行首开扫(start 只在匹配越过块尾时才不在行首),起点早于 start 的匹配不收
    const cursorFrom = aligned ? doc.lineAt(start).from : start;
    const cursor = this.query.getCursor(this.state, cursorFrom, cursorTo);
    for (let r = cursor.next(); !r.done; r = cursor.next()) {
      const { from, to } = r.value;
      if (from < start) continue;
      if (!last && from >= chunkEnd) break;
      if (this.ranges.length >= this.limit * 2) {
        this.capped = true;
        this.done = true;
        return;
      }
      this.ranges.push(from, to);
      this.lastTo = to;
    }
    this.pos = chunkEnd;
    if (last) this.done = true;
  }
}
