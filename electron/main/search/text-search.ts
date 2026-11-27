// 工作区文本搜索引擎(在文件中查找,对齐 VSCode Search):在 worker 线程里运行(text-search.worker.ts),也可直接调用(单测)。
// 枚举复用 fs:list-dir 的 walker 与 Quick Open 同一排除表;逐文件有界读(≤ 1 MiB、只读普通文件、要求合法 UTF-8、含 NUL 视作二进制),
// 逐行匹配(matchSearchText,renderer 搜已打开编辑器的内存内容用同一实现),命中文件按时间窗攒批经 onFiles 推出;
// 因过大跳过的文件计数并报告路径(renderer 显示「已跳过 N 个大文件」);读不了的子目录跳过并计数(根读不了才整体失败),
// 单个文件读失败(EACCES / EISDIR / ELOOP / ENAMETOOLONG 等)静默跳过该文件。BDD: src/__tests__/workspace-search/

import path from 'node:path';
import { scanDir } from '../ipc/fs/list-dir';
import { readFileCappedFd } from '../lib/read-fh-capped';
import { LIST_DIR_MAX_DEPTH, WORKSPACE_SCAN_EXCLUDE } from '../../shared/fs-limits';
import {
  buildSearchRegExp,
  compileSearchPathFilter,
  matchSearchText,
  SEARCH_BATCH_MS,
  SEARCH_MAX_FILE_BYTES,
  SEARCH_MAX_FILES,
  SEARCH_MAX_RESULTS,
  SEARCH_MAX_RESULTS_PER_FILE,
  SEARCH_SKIPPED_LARGE_REPORT_MAX,
  type SearchFileResult,
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
  /** 因超过 SEARCH_MAX_FILE_BYTES 跳过的文件数(含未列入 skippedLargePaths 的)。 */
  readonly skippedLargeCount: number;
  /** 被跳过的大文件绝对路径(至多 SEARCH_SKIPPED_LARGE_REPORT_MAX 个;renderer 扣除已在内存搜索的打开文件)。 */
  readonly skippedLargePaths: readonly string[];
  /** 枚举时因无法读取(无权限 / 路径超长 / I/O 错误)整棵跳过的子目录数(renderer 显示「已跳过 N 个无法读取的目录」)。 */
  readonly skippedUnreadableDirs: number;
}

/** 同时读取的文件数(块内并发、块间按序,结果顺序稳定)。 */
const READ_CHUNK = 16;

export async function runTextSearch(opts: TextSearchOptions): Promise<TextSearchSummary> {
  const { root, query, onFiles } = opts;
  const now = opts.now ?? Date.now;
  const maxFiles = opts.maxFiles ?? SEARCH_MAX_FILES;
  const regex = buildSearchRegExp(query); // 非法正则在此抛出
  const filter = compileSearchPathFilter(query.include, query.exclude);

  const { entries, skippedDirs: skippedUnreadableDirs } = await scanDir(root, {
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
    // 显示 / 过滤 / 与已打开编辑器结果对齐用 NFC(见 searchRelPath);读文件仍用磁盘原样的 e.path。
    const rel = path.relative(root, e.path).split(path.sep).join('/').normalize('NFC');
    if (filter === null || filter(rel)) files.push({ abs: e.path, rel });
  }
  const filesLimitHit = enumerated >= maxFiles;

  let total = 0;
  let limitHit = false;
  let skippedLargeCount = 0;
  const skippedLargePaths: string[] = [];
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
      const f = chunk[j]!;
      if (text === TOO_LARGE) {
        skippedLargeCount += 1;
        if (skippedLargePaths.length < SEARCH_SKIPPED_LARGE_REPORT_MAX) skippedLargePaths.push(f.abs);
        continue;
      }
      if (text === null || text === undefined) continue;
      const budget = Math.min(SEARCH_MAX_RESULTS_PER_FILE, SEARCH_MAX_RESULTS - total);
      const found = matchSearchText(text, regex, budget);
      if (found.matches.length > 0) {
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
  return { limitHit, filesLimitHit, skippedLargeCount, skippedLargePaths, skippedUnreadableDirs };
}

/** readSearchableText 的「过大而跳过」标记(与其它跳过原因区分,用于「已跳过 N 个大文件」提示)。 */
const TOO_LARGE: unique symbol = Symbol('too-large');

/** 可搜索的文本;过大 → TOO_LARGE;其它跳过(符号链接被换入 / 非普通文件 / 非 UTF-8 / 含 NUL / 读失败)→ null。 */
async function readSearchableText(abs: string): Promise<string | typeof TOO_LARGE | null> {
  try {
    const r = await readFileCappedFd(abs, SEARCH_MAX_FILE_BYTES, { requireUtf8: true });
    if (r.tooLarge) return TOO_LARGE;
    if (r.text === null || r.text.includes('\0')) return null;
    return r.text;
  } catch {
    return null;
  }
}
