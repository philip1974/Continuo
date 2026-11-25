// 工作区文本搜索引擎(在文件中查找,对齐 VSCode Search):在 worker 线程里运行(text-search.worker.ts),也可直接调用(单测)。
// 枚举复用 fs:list-dir 的 walker 与 Quick Open 同一排除表;逐文件有界读(≤ 1 MiB、只读普通文件、要求合法 UTF-8、含 NUL 视作二进制),
// 逐行匹配,命中文件按时间窗攒批经 onFiles 推出。BDD: src/__tests__/workspace-search/

import path from 'node:path';
import { listDir } from '../ipc/fs/list-dir';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { LIST_DIR_MAX_DEPTH, WORKSPACE_SCAN_EXCLUDE } from '../../shared/fs-limits';
import {
  buildSearchRegExp,
  compileSearchPathFilter,
  SEARCH_BATCH_MS,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_FILES,
  SEARCH_MAX_RESULTS,
  SEARCH_MAX_RESULTS_PER_FILE,
  SEARCH_PREVIEW_LEAD,
  SEARCH_PREVIEW_MAX,
  type SearchFileResult,
  type SearchMatch,
  type SearchQuery,
} from '../../shared/workspace-search';

export interface TextSearchOptions {
  readonly root: string;
  readonly query: SearchQuery;
  /** 一批命中文件(非空)。 */
  readonly onFiles: (files: readonly SearchFileResult[]) => void;
  /** 文件数上限(缺省 SEARCH_MAX_FILES;测试调小)。 */
  readonly maxFiles?: number;
  /** 时钟(攒批用;测试注入)。 */
  readonly now?: () => number;
}

export interface TextSearchSummary {
  readonly limitHit: boolean;
  readonly filesLimitHit: boolean;
}

/** 同时读取的文件数(块内并发、块间按序,结果顺序稳定)。 */
const READ_CHUNK = 16;

export async function runTextSearch(opts: TextSearchOptions): Promise<TextSearchSummary> {
  const { root, query, onFiles } = opts;
  const now = opts.now ?? Date.now;
  const maxFiles = opts.maxFiles ?? SEARCH_MAX_FILES;
  const regex = buildSearchRegExp(query); // 非法正则在此抛出
  const filter = compileSearchPathFilter(query.include, query.exclude);

  const entries = await listDir(root, {
    maxDepth: LIST_DIR_MAX_DEPTH,
    exclude: WORKSPACE_SCAN_EXCLUDE,
    maxFiles,
    withStats: false,
  });
  const files: { abs: string; rel: string }[] = [];
  let enumerated = 0;
  for (const e of entries) {
    if (e.isDirectory || e.isSymlink) continue; // 不跟随链接(同 Quick Open 递归扫描)
    enumerated += 1;
    const rel = path.relative(root, e.path).split(path.sep).join('/');
    if (filter === null || filter(rel)) files.push({ abs: e.path, rel });
  }
  const filesLimitHit = enumerated >= maxFiles;

  let total = 0;
  let limitHit = false;
  let pending: SearchFileResult[] = [];
  let lastFlush = now();
  const flush = (): void => {
    if (pending.length === 0) return;
    onFiles(pending);
    pending = [];
  };

  for (let i = 0; i < files.length && !limitHit; i += READ_CHUNK) {
    const chunk = files.slice(i, i + READ_CHUNK);
    const texts = await Promise.all(chunk.map((f) => readSearchableText(f.abs)));
    for (let j = 0; j < chunk.length; j += 1) {
      const text = texts[j];
      if (text === null || text === undefined) continue;
      const budget = Math.min(SEARCH_MAX_RESULTS_PER_FILE, SEARCH_MAX_RESULTS - total);
      const found = matchText(text, regex, budget);
      if (found.matches.length > 0) {
        const f = chunk[j]!;
        pending.push({
          path: f.abs,
          relPath: f.rel,
          matches: found.matches,
          ...(found.more && budget === SEARCH_MAX_RESULTS_PER_FILE ? { truncated: true as const } : {}),
        });
        total += found.matches.length;
      }
      if (found.more && total >= SEARCH_MAX_RESULTS) {
        limitHit = true;
        break;
      }
      const t = now();
      if (t - lastFlush >= SEARCH_BATCH_MS) {
        flush();
        lastFlush = t;
      }
    }
  }
  flush();
  return { limitHit, filesLimitHit };
}

/** 可搜索的文本;跳过(符号链接被换入 / 非普通文件 / 过大 / 非 UTF-8 / 含 NUL / 读失败)→ null。 */
async function readSearchableText(abs: string): Promise<string | null> {
  try {
    const r = await readFileCappedFd(abs, SEARCH_MAX_FILE_BYTES, { requireUtf8: true });
    if (r.text === null || r.text.includes('\0')) return null;
    return r.text;
  } catch {
    return null;
  }
}

/** 逐行匹配,至多 budget 条;more = 还有更多命中(被截断)。 */
function matchText(text: string, regex: RegExp, budget: number): { matches: SearchMatch[]; more: boolean } {
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

function makeMatch(line: string, lineNo: number, index: number, length: number): SearchMatch {
  // 预览:去行首空白;命中前超过 SEARCH_PREVIEW_LEAD 个字符 → 从命中前 LEAD 处截起并加「…」;最长 SEARCH_PREVIEW_MAX。
  let from = 0;
  while (from < index && (line.charCodeAt(from) === 32 || line.charCodeAt(from) === 9)) from += 1;
  let prefix = '';
  if (index - from > SEARCH_PREVIEW_LEAD) {
    from = index - SEARCH_PREVIEW_LEAD;
    prefix = '…';
  }
  const preview = prefix + line.slice(from, from + SEARCH_PREVIEW_MAX);
  const previewStart = prefix.length + index - from;
  return {
    line: lineNo,
    column: index + 1,
    length,
    preview,
    previewStart,
    previewLength: Math.max(0, Math.min(length, preview.length - previewStart)),
  };
}
