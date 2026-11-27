// 工作区文本搜索(在文件中查找 ⇧⌘F,对齐 VSCode Search 视图)的跨进程契约:通道、上限、结果形态、查询 → 正则、
// 包含 / 排除 glob。纯函数,无 node / zod 依赖:main(worker 引擎 / IPC)、preload(推送守卫)、renderer 共用。
// BDD: src/__tests__/workspace-search/

export const SEARCH_CHANNELS = {
  /** renderer → main(invoke):发起搜索;同一 webContents 的在途搜索被取消。 */
  START: 'search:start',
  /** renderer → main(invoke):取消该 searchId(已结束 / 不是当前搜索 → no-op)。 */
  CANCEL: 'search:cancel',
  /** main → renderer:分批结果 / 结束 / 失败(带 searchId)。 */
  EVENT: 'search:event',
} as const;

/** 总结果上限(超出停止搜索并标记 limitHit;VSCode search.maxResults 同类)。 */
export const SEARCH_MAX_RESULTS = 10_000;
/** 单文件结果上限(超出该文件标记 truncated,继续搜下一个文件)。 */
export const SEARCH_MAX_RESULTS_PER_FILE = 1_000;
/** 只搜不超过该大小的文件(超大文件多为生成物 / 日志)。 */
export const SEARCH_MAX_FILE_BYTES = 1024 * 1024;
/** 枚举的文件数上限(超出只搜前这么多个,标记 filesLimitHit)。 */
export const SEARCH_MAX_FILES = 50_000;
/** 预览行最长字符数。 */
export const SEARCH_PREVIEW_MAX = 250;
/** 命中前至少保留的上下文字符数(VSCode Match.preview 的 `lcut(before, 26, '…')`:更前的按词边界截掉并加「…」)。 */
export const SEARCH_PREVIEW_LEAD = 26;
/** 按词边界截后命中前文仍超过该长度(长串无词边界,如整行 CJK / base64)→ 按码点硬截到末 SEARCH_PREVIEW_LEAD 个字符。 */
export const SEARCH_PREVIEW_BEFORE_MAX = 125;
/** 结果分批推送的时间窗(ms)。 */
export const SEARCH_BATCH_MS = 50;
/** done 事件里报告的「因过大跳过」文件路径数上限(总数另报 skippedLargeCount)。 */
export const SEARCH_SKIPPED_LARGE_REPORT_MAX = 1_000;
/** 查询串长度上限(= renderer 查询框截断上限 MAX_SEARCH_QUERY_LEN,IPC schema 用)。 */
export const SEARCH_PATTERN_MAX = 1024;
/** searchId / glob 输入的长度上限(IPC schema 与 renderer 共用)。 */
export const SEARCH_ID_MAX = 64;
export const SEARCH_GLOB_MAX = 1024;

export interface SearchQuery {
  readonly pattern: string;
  readonly isRegex: boolean;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  /** 包含的文件(逗号分隔 glob,空 = 全部)。 */
  readonly include: string;
  /** 排除的文件(逗号分隔 glob)。 */
  readonly exclude: string;
}

export interface SearchMatch {
  /** 行号(1 起)。 */
  readonly line: number;
  /** 列号(1 起,UTF-16 code unit,与编辑器定位一致)。 */
  readonly column: number;
  /** 命中长度(UTF-16)。 */
  readonly length: number;
  /** 预览文本(去行首空白,过长截断)。 */
  readonly preview: string;
  /** 命中在 preview 中的起点与长度(高亮用)。 */
  readonly previewStart: number;
  readonly previewLength: number;
}

export interface SearchFileResult {
  readonly path: string;
  /** 相对工作区根,分隔符 `/`。 */
  readonly relPath: string;
  readonly matches: readonly SearchMatch[];
  /** 该文件结果超过 SEARCH_MAX_RESULTS_PER_FILE 被截断。 */
  readonly truncated?: true;
}

export type SearchEvent =
  | { readonly searchId: string; readonly kind: 'files'; readonly files: readonly SearchFileResult[] }
  | {
      readonly searchId: string;
      readonly kind: 'done';
      /** 总结果达上限,停止搜索。 */
      readonly limitHit: boolean;
      /** 文件数达上限,只搜了一部分文件。 */
      readonly filesLimitHit: boolean;
      /** 因超过 SEARCH_MAX_FILE_BYTES 跳过的文件数(缺省 0)。 */
      readonly skippedLargeCount?: number;
      /** 被跳过的大文件绝对路径(至多 SEARCH_SKIPPED_LARGE_REPORT_MAX 个)。 */
      readonly skippedLargePaths?: readonly string[];
      /** 枚举时因无法读取而跳过的子目录数(缺省 0)。 */
      readonly skippedUnreadableDirs?: number;
    }
  | { readonly searchId: string; readonly kind: 'error'; readonly code: string; readonly message: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isNonNegInt = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;

function isSearchMatch(v: unknown): boolean {
  return (
    isObj(v) &&
    isNonNegInt(v.line) &&
    isNonNegInt(v.column) &&
    isNonNegInt(v.length) &&
    typeof v.preview === 'string' &&
    v.preview.length <= SEARCH_PREVIEW_MAX + 1 &&
    isNonNegInt(v.previewStart) &&
    isNonNegInt(v.previewLength)
  );
}

function isSearchFileResult(v: unknown): boolean {
  return (
    isObj(v) &&
    typeof v.path === 'string' &&
    typeof v.relPath === 'string' &&
    Array.isArray(v.matches) &&
    v.matches.length <= SEARCH_MAX_RESULTS_PER_FILE &&
    v.matches.every(isSearchMatch) &&
    (v.truncated === undefined || v.truncated === true)
  );
}

/** main → renderer 推送的形态守卫(preload 据此丢弃畸形事件)。 */
export function isSearchEvent(v: unknown): v is SearchEvent {
  if (!isObj(v) || typeof v.searchId !== 'string' || v.searchId.length > SEARCH_ID_MAX) return false;
  switch (v.kind) {
    case 'files':
      return Array.isArray(v.files) && v.files.every(isSearchFileResult);
    case 'done':
      return (
        typeof v.limitHit === 'boolean' &&
        typeof v.filesLimitHit === 'boolean' &&
        (v.skippedLargeCount === undefined || isNonNegInt(v.skippedLargeCount)) &&
        (v.skippedUnreadableDirs === undefined || isNonNegInt(v.skippedUnreadableDirs)) &&
        (v.skippedLargePaths === undefined ||
          (Array.isArray(v.skippedLargePaths) &&
            v.skippedLargePaths.length <= SEARCH_SKIPPED_LARGE_REPORT_MAX &&
            v.skippedLargePaths.every((p) => typeof p === 'string')))
      );
    case 'error':
      return typeof v.code === 'string' && typeof v.message === 'string';
    default:
      return false;
  }
}

/**
 * 逐行匹配(`\r\n` / `\n`),至多 budget 条;more = 还有更多命中(被截断)。列 / 长度为 UTF-16;零长度命中跳过。
 * main worker(磁盘文件)与 renderer(已打开编辑器的内存内容,含未保存修改)共用,两边结果口径一致。
 */
export function matchSearchText(text: string, regex: RegExp, budget: number): { matches: SearchMatch[]; more: boolean } {
  const matches: SearchMatch[] = [];
  // 整篇预检:无命中的文件(绝大多数)不逐行拆分。
  regex.lastIndex = 0;
  if (!regex.test(text)) return { matches, more: false };
  let lineNo = 0;
  let start = 0;
  while (start <= text.length) {
    let end = text.indexOf('\n', start);
    if (end < 0) end = text.length;
    lineNo += 1;
    const line = text.charCodeAt(end - 1) === 13 ? text.slice(start, end - 1) : text.slice(start, end);
    regex.lastIndex = 0;
    for (let m = regex.exec(line); m !== null; m = regex.exec(line)) {
      if (m[0].length === 0) {
        regex.lastIndex += 1; // 零长度命中跳过
        continue;
      }
      if (matches.length >= budget) return { matches, more: true };
      matches.push(makeMatch(line, lineNo, m.index, m[0].length));
    }
    start = end + 1;
  }
  return { matches, more: false };
}

/**
 * VSCode strings.lcut(原样照抄语义):去前导空白;不足 n 个字符原样返回;否则在「保留至少 n 个字符」的最后一个词边界(`\b`)处
 * 截掉前文、加 prefix 并再去前导空白;找不到可截的词边界 → 原样返回。`\b` 两侧必有 ASCII 单词字符,截点不会落在代理对中间。
 */
export function lcut(text: string, n: number, prefix = ''): string {
  const trimmed = text.trimStart();
  if (trimmed.length < n) return trimmed;
  const re = /\b/g;
  let i = 0;
  while (re.test(trimmed)) {
    if (trimmed.length - re.lastIndex < n) break;
    i = re.lastIndex;
    re.lastIndex += 1;
  }
  if (i === 0) return trimmed;
  return prefix + trimmed.substring(i).trimStart();
}

const isLowSurrogate = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;

/** 命中前文(VSCode Match.preview):lcut 按词边界截到约 SEARCH_PREVIEW_LEAD 字符;仍过长(无词边界)按码点硬截。 */
function previewBefore(fullBefore: string): string {
  const before = lcut(fullBefore, SEARCH_PREVIEW_LEAD, '…');
  if (before.length <= SEARCH_PREVIEW_BEFORE_MAX) return before;
  let from = before.length - SEARCH_PREVIEW_LEAD;
  if (isLowSurrogate(before.charCodeAt(from))) from -= 1; // 不拆代理对(emoji / 扩展区汉字)
  return '…' + before.slice(from);
}

function makeMatch(line: string, lineNo: number, index: number, length: number): SearchMatch {
  // 预览 = 前文(去前导空白、按词边界截掉过长部分并加「…」)+ 命中 + 后文,总长封顶 SEARCH_PREVIEW_MAX(VSCode MAX_PREVIEW_CHARS)。
  const before = previewBefore(line.slice(0, index));
  let preview = before + line.slice(index, index + SEARCH_PREVIEW_MAX - before.length);
  if (isHighSurrogate(preview.charCodeAt(preview.length - 1))) preview = preview.slice(0, -1); // 封顶处不留半个代理对
  const previewStart = before.length;
  return {
    line: lineNo,
    column: index + 1,
    length,
    preview,
    previewStart,
    previewLength: Math.max(0, Math.min(length, preview.length - previewStart)),
  };
}

const REGEX_SPECIALS = /[\\^$.*+?()[\]{}|/-]/g;

/** 正则 flags:全局逐个命中;不区分大小写加 i(不加 u —— 与终端 / 编辑器查找框的正则校验同口径)。 */
export function searchRegExpFlags(matchCase: boolean): string {
  return matchCase ? 'g' : 'gi';
}

/**
 * 查询 → 正则源(VSCode strings.createRegExp):字面量转义元字符;全词在首 / 尾是单词字符时加 `\b`。
 * 非法正则由调用方 `new RegExp` 时抛出(renderer 先用 regexSyntaxError 拦下)。
 */
export function searchRegExpSource(q: Pick<SearchQuery, 'pattern' | 'isRegex' | 'wholeWord'>): string {
  let source = q.isRegex ? q.pattern : q.pattern.replace(REGEX_SPECIALS, '\\$&');
  if (q.wholeWord) {
    if (!/\B/.test(source.charAt(0))) source = `\\b${source}`;
    if (!/\B/.test(source.charAt(source.length - 1))) source = `${source}\\b`;
  }
  return source;
}

export function buildSearchRegExp(q: Pick<SearchQuery, 'pattern' | 'isRegex' | 'wholeWord' | 'matchCase'>): RegExp {
  return new RegExp(searchRegExpSource(q), searchRegExpFlags(q.matchCase));
}

/** 单个 glob → 正则源(`*` 不跨目录、`**` 跨目录、`?`、`{a,b}`、`[...]`)。 */
function globSource(glob: string): string {
  let out = '';
  let inBraces = false;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          out += '(?:.*/)?'; // `**/`:零或多级目录
        } else {
          out += '.*';
        }
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{' && !inBraces) {
      inBraces = true;
      out += '(?:';
    } else if (c === '}' && inBraces) {
      inBraces = false;
      out += ')';
    } else if (c === ',' && inBraces) {
      out += '|';
    } else if (c === '[') {
      const end = glob.indexOf(']', i + 2);
      if (end < 0) {
        out += '\\[';
      } else {
        // 紧跟 `[` 的 `]` 是字面字符(`[]]` 匹配 `]`,VSCode escapeGlobPattern 即这样转义);在正则字符类里须写成 `\]`。
        let body = glob.slice(i + 1, end).replace(/\\/g, '\\\\').replace(/]/g, '\\]');
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        out += `[${body}]`;
        i = end;
      }
    } else {
      out += c.replace(REGEX_SPECIALS, '\\$&');
    }
  }
  if (inBraces) out += ')';
  return out;
}

/** 逗号分隔(花括号内的逗号不算)。 */
function splitGlobList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of text) {
    if (c === '{') depth += 1;
    else if (c === '}' && depth > 0) depth -= 1;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += c;
    }
  }
  parts.push(cur);
  return parts;
}

/**
 * 「包含 / 排除的文件」输入 → 相对路径匹配器;空输入 → null(不过滤)。语义同 VSCode:`./` 开头相对工作区根,否则任意
 * 层级(前面补「任意多级目录」);匹配到目录时其下所有文件都算(后面补「目录下任意路径」)。分隔符统一 `/`,大小写不敏感。
 */
export function compileGlobList(text: string): ((relPath: string) => boolean) | null {
  const sources: string[] = [];
  // 模式与路径两侧都按 NFC 比(VSCode macOS 上文件名读出即 normalizeNFC):磁盘上 NFD 的韩文 / 带重音名与键入的 NFC 模式对得上。
  for (const raw of splitGlobList(text.normalize('NFC'))) {
    let g = raw.trim().replace(/\\/g, '/');
    if (g === '') continue;
    if (g.startsWith('./')) g = g.slice(2);
    else if (g.startsWith('/')) g = g.slice(1);
    else if (!g.startsWith('**/')) g = `**/${g}`;
    g = g.replace(/\/+$/, '');
    if (g === '' || g === '**') return () => true;
    sources.push(globSource(g));
  }
  if (sources.length === 0) return null;
  const re = new RegExp(`^(?:${sources.join('|')})(?:/.*)?$`, 'i');
  return (relPath) => re.test(relPath.normalize('NFC'));
}

/** 包含 + 排除 → 文件过滤器(排除优先;都空 → null)。 */
export function compileSearchPathFilter(include: string, exclude: string): ((relPath: string) => boolean) | null {
  const inc = compileGlobList(include);
  const exc = compileGlobList(exclude);
  if (!inc && !exc) return null;
  return (relPath) => (inc === null || inc(relPath)) && (exc === null || !exc(relPath));
}
