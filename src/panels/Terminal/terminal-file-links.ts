// 终端本地文件链接(对齐 VSCode TerminalLocalLinkDetector + TerminalLinkResolver):从输出识别相对 / 绝对路径与
// `:line` / `:line:col` / `(line,col)` 后缀,交给 main 按终端当前 cwd(OSC 7 跟踪)/ 工作区根解析,确认是**存在的普通
// 文件**才显示为链接(不存在的不划线,避免大量误报);修饰键 + 单击(同 URL 链接:mac ⌘,其它 Ctrl)在编辑器打开并定位行列。
// 性能:xterm 只在鼠标悬停到某行时才向 provider 要链接(不随输出扫描);每行最多 MAX_LINKS_PER_LINE 个候选、超长行不扫,
// 解析结果按 (cwd, 路径) 缓存 RESOLVE_CACHE_TTL_MS,同一次悬停的候选合并成一次 IPC。
// BDD: src/__tests__/terminal-file-links/

import type { IBufferCell, ILink, ILinkProvider, Terminal } from '@xterm/xterm';

/** 每行最多解析的候选数(VSCode TerminalLocalLinkDetector MaxResolvedLinksInLine)。 */
export const MAX_LINKS_PER_LINE = 10;
/** 超过此长度的(逻辑)行不扫描(VSCode MaxLineLength)。 */
export const MAX_LINK_LINE_LENGTH = 2000;
/** 路径解析结果缓存时长(VSCode TerminalLinkResolver 同为 10s)。 */
export const RESOLVE_CACHE_TTL_MS = 10_000;
const RESOLVE_CACHE_MAX_ENTRIES = 500;

export interface ParsedTerminalLink {
  /** 路径部分(未解析,可能相对)。 */
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  /** 整个链接(路径 + 行列后缀)在行文本中的 [start, end)。 */
  readonly start: number;
  readonly end: number;
}

// 路径:可选前缀(盘符 / ~/ / ./ / ../ / 根)+ 不含空白、引号、括号、分隔符与冒号的字符;后缀 `:12` / `:12:5` / `(12,5)` / `(12, 5)`。
const LINK_RE =
  /((?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?[^\s'"`<>()[\]{}|,;:]+)(?::(\d+)(?::(\d+))?|\((\d+)(?:,\s?(\d+))?\))?/g;
const HAS_SEPARATOR = /[\\/]/;
// 带扩展名(以字母开头)的裸文件名,如 `long.ts`;排除 `3.14` / `v1.2` 一类数字。
const HAS_EXTENSION = /\.[A-Za-z][\w-]*$/;

function positiveInt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** 从一行文本识别文件路径候选(纯函数;是否存在由 main 解析确认)。 */
export function parseTerminalFileLinks(text: string): ParsedTerminalLink[] {
  if (text.length > MAX_LINK_LINE_LENGTH) return [];
  const out: ParsedTerminalLink[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index;
    // `https://x/y` 的 `//x/y`、`foo:bar` 的 `bar`:冒号后的片段不是独立路径(URL 交给 WebLinksAddon)。
    if (start > 0 && text[start - 1] === ':') continue;
    const line = positiveInt(m[2] ?? m[4]);
    const column = line === undefined ? undefined : positiveInt(m[3] ?? m[5]);
    let path = m[1]!;
    let end = start + m[0].length;
    if (line === undefined) {
      // 句末标点不属于路径(`see src/a.ts.`);无行号时整段即路径。
      const trimmed = path.replace(/\.+$/, '');
      end -= path.length - trimmed.length;
      path = trimmed;
    }
    if (!HAS_SEPARATOR.test(path) && !HAS_EXTENSION.test(path)) continue;
    out.push({ path, line, column, start, end });
    if (out.length >= MAX_LINKS_PER_LINE) break;
  }
  return out;
}

interface LogicalLine {
  readonly text: string;
  /** 文本每个 UTF-16 下标 → 所在单元格(0 起 x / 缓冲行号)与该格宽度。 */
  readonly xs: number[];
  readonly ys: number[];
  readonly widths: number[];
}

/** 读取包含缓冲行 row(0 起)的逻辑行(含软换行的前后行),建立文本下标 → 单元格映射(宽字符按 1 个下标占 2 格)。 */
function readLogicalLine(term: Terminal, row: number): LogicalLine | null {
  const buffer = term.buffer.active;
  let start = row;
  while (start > 0 && buffer.getLine(start)?.isWrapped) start -= 1;
  const xs: number[] = [];
  const ys: number[] = [];
  const widths: number[] = [];
  let text = '';
  let cell: IBufferCell | undefined;
  for (let y = start; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    if (!line || (y > start && !line.isWrapped)) break;
    for (let x = 0; x < line.length; x += 1) {
      cell = line.getCell(x, cell);
      if (!cell) break;
      const width = cell.getWidth();
      if (width === 0) continue; // 宽字符的后半格
      const chars = cell.getChars() || ' ';
      for (let k = 0; k < chars.length; k += 1) {
        xs.push(x);
        ys.push(y);
        widths.push(width);
      }
      text += chars;
    }
    if (text.length > MAX_LINK_LINE_LENGTH) return null;
  }
  return { text, xs, ys, widths };
}

export interface TerminalFileLinkDeps {
  /** 终端当前 cwd(缓存键:cwd 变了相对路径要重新解析)。 */
  readonly getCwd: () => string | undefined;
  /** main 解析:每个候选 → 存在的普通文件绝对路径或 null;失败 → null(本次不显示链接)。 */
  readonly resolve: (paths: readonly string[]) => Promise<readonly (string | null)[] | null>;
  /** 修饰键单击:在编辑器打开并定位。 */
  readonly open: (absPath: string, line: number | undefined, column: number | undefined, event: MouseEvent) => void;
  readonly hover?: (event: MouseEvent, text: string) => void;
  readonly leave?: (event: MouseEvent, text: string) => void;
  readonly now?: () => number;
}

/** 解析结果缓存:(cwd, 路径) → 在途或已完成的解析(带时间戳,过期重解析)。 */
function createResolveCache(deps: TerminalFileLinkDeps) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { readonly at: number; readonly value: Promise<string | null> }>();
  return (paths: readonly string[]): Promise<(string | null)[]> => {
    const cwd = deps.getCwd() ?? '';
    const t = now();
    const result: Promise<string | null>[] = [];
    const missing: string[] = [];
    const settle: Array<(v: string | null) => void> = [];
    for (const p of paths) {
      const key = `${cwd}\0${p}`;
      const hit = cache.get(key);
      if (hit && t - hit.at < RESOLVE_CACHE_TTL_MS) {
        result.push(hit.value);
        continue;
      }
      const value = new Promise<string | null>((resolve) => settle.push(resolve));
      missing.push(p);
      if (cache.size >= RESOLVE_CACHE_MAX_ENTRIES) cache.clear();
      cache.set(key, { at: t, value });
      result.push(value);
    }
    if (missing.length > 0) {
      void deps.resolve(missing).then(
        (resolved) => {
          missing.forEach((p, i) => {
            const v = resolved?.[i] ?? null;
            // 解析失败(IPC 出错)不缓存,下次悬停重试。
            if (resolved === null) cache.delete(`${cwd}\0${p}`);
            settle[i]!(v);
          });
        },
        () => {
          missing.forEach((p, i) => {
            cache.delete(`${cwd}\0${p}`);
            settle[i]!(null);
          });
        },
      );
    }
    return Promise.all(result);
  };
}

/** xterm link provider:悬停行内存在的文件路径显示为链接(见文件头)。 */
export function createTerminalFileLinkProvider(term: Terminal, deps: TerminalFileLinkDeps): ILinkProvider {
  const resolveCached = createResolveCache(deps);
  return {
    provideLinks(bufferLineNumber, callback) {
      const row = bufferLineNumber - 1;
      const logical = readLogicalLine(term, row);
      const parsed = logical
        ? parseTerminalFileLinks(logical.text).filter(
            (l) => logical.ys[l.start]! <= row && logical.ys[l.end - 1]! >= row,
          )
        : [];
      if (!logical || parsed.length === 0) {
        callback(undefined);
        return;
      }
      void resolveCached(parsed.map((l) => l.path)).then((resolved) => {
        const links: ILink[] = [];
        parsed.forEach((l, i) => {
          const abs = resolved[i];
          if (!abs) return;
          const last = l.end - 1;
          links.push({
            text: logical.text.slice(l.start, l.end),
            range: {
              start: { x: logical.xs[l.start]! + 1, y: logical.ys[l.start]! + 1 },
              end: { x: logical.xs[last]! + logical.widths[last]!, y: logical.ys[last]! + 1 },
            },
            decorations: { pointerCursor: true, underline: true },
            activate: (event) => deps.open(abs, l.line, l.column, event),
            hover: deps.hover,
            leave: deps.leave,
          });
        });
        callback(links.length > 0 ? links : undefined);
      });
    },
  };
}
