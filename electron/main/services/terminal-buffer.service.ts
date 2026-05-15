// Per-session 环形 buffer + ANSI strip(Agent Terminal MCP Phase 3)。
// PTY 输出 chunk 入 buffer,terminal.read_output MCP tool 通过本 service
// 增量读 + 切行 + 可选 strip ANSI。
//
// BDD: src/__tests__/agent-terminal-mcp-buffer/

const DEFAULT_CAPACITY = 8000;
const DEFAULT_MAX_LINES = 200;

// 覆盖四类 ESC 序列(参考 MindAutonAgent3 + 实测 zsh + Powerlevel10k):
//   CSI:     ESC [ 参数(数字 / ; / ?)... 终结字母 — 含 DEC private mode \[?25h\[?25l 等
//   OSC:     ESC ] 参数 ... ST(BEL = \x07 或 ESC \)— window title / cwd
//   keypad:  ESC = / ESC >(application keypad mode 切换)
//   charset: ESC ( B / ESC ) 0 等(G0/G1 字符集选择,部分 TUI 启动时发)
// 不覆盖:DCS / SOS / PM / APC(罕见,等遇到再补)。
// 普通 ASCII 控制(\r / \b / \t)保留,不在本函数职责内。
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b(?:\[[\d;?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[=>]|[()][AB012])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

interface BufferEntry {
  readonly seq: number;
  readonly data: string;
}

interface SessionBuffer {
  entries: BufferEntry[];
  nextSeq: number;
  capacity: number;
}

const buffers = new Map<string, SessionBuffer>();

export interface ReadOptions {
  readonly sinceSeq?: number;
  readonly maxLines?: number;
  readonly stripAnsi?: boolean;
}

export interface ReadResult {
  readonly lines: string[];
  readonly nextSeq: number;
  readonly truncated: boolean;
}

const ERR_NOT_FOUND = (id: string) =>
  Object.assign(new Error(`buffer session not found: ${id}`), {
    code: 'BUFFER_SESSION_NOT_FOUND',
  });

export function ensure(id: string, capacity: number = DEFAULT_CAPACITY): void {
  if (buffers.has(id)) return;
  buffers.set(id, { entries: [], nextSeq: 0, capacity });
}

export function append(id: string, data: string): void {
  let buf = buffers.get(id);
  if (!buf) {
    ensure(id);
    buf = buffers.get(id)!;
  }
  buf.entries.push({ seq: buf.nextSeq, data });
  buf.nextSeq += 1;
  if (buf.entries.length > buf.capacity) {
    buf.entries.shift();
  }
}

/**
 * Replay 用:整段 raw 数据(保留 ANSI / 不切行)给 renderer xterm 灌入。
 * topic-07:dockview lazy-mount 错过初始 PTY 输出时,客户端 mount 后调此接口。
 * 不存在 buffer → 返回空(不抛),允许 mount-before-spawn 的安全 race。
 */
export function readRaw(id: string): { data: string; truncated: boolean } {
  const buf = buffers.get(id);
  if (!buf) return { data: '', truncated: false };
  return {
    data: buf.entries.map((e) => e.data).join(''),
    // 环形 buffer 已 shift 过任何 entry 即视为 truncated(无法精确判定首 seq)
    truncated: buf.nextSeq > buf.entries.length,
  };
}

export function read(id: string, opts?: ReadOptions): ReadResult {
  const buf = buffers.get(id);
  if (!buf) throw ERR_NOT_FOUND(id);

  const sinceSeq = opts?.sinceSeq ?? 0;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const stripAnsiFlag = opts?.stripAnsi !== false;

  const filtered = buf.entries.filter((e) => e.seq >= sinceSeq);

  // buffer 已丢底:客户端 sinceSeq 之前的数据已不可达 → truncated=true
  // (即使 maxLines 没切,数据缺口也要告诉客户端)
  let dataGap = false;
  if (buf.entries.length > 0) {
    const firstSeq = buf.entries[0]!.seq;
    if (firstSeq > sinceSeq) dataGap = true;
  }

  if (filtered.length === 0) {
    return {
      lines: [],
      nextSeq: buf.nextSeq,
      truncated: dataGap,
    };
  }

  let merged = filtered.map((e) => e.data).join('');
  if (stripAnsiFlag) merged = stripAnsi(merged);

  let lines = merged.split(/\r?\n/);
  // trim 末尾连续空行(PTY 输出多以 \n 结尾,split 会产生尾部空字符串)
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const linesTruncated = lines.length > maxLines;
  if (linesTruncated) {
    lines = lines.slice(-maxLines);
  }

  return {
    lines,
    nextSeq: buf.nextSeq,
    truncated: linesTruncated || dataGap,
  };
}

export function destroy(id: string): void {
  buffers.delete(id);
}

/** 测试用:清所有 buffer + counter. */
export function _resetForTest(): void {
  buffers.clear();
}
