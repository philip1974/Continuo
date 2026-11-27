// 在文件中查找 · 已打开编辑器的内存内容搜索(VSCode searchService.getLocalResults):工作区根下已打开的文本编辑器按 store 里的
// 当前内容(含未保存修改、不受 SEARCH_MAX_FILE_BYTES 限制)匹配,结果覆盖 main 从磁盘搜到的同一文件。匹配规则与 worker 同一实现
//(matchSearchText:逐行、UTF-16 列号、正则 / 大小写 / 全词、每文件 / 总数上限),包含 / 排除 glob 与工作区排除表同口径。
// 只读 editor.store 的 state,不改它。BDD: src/__tests__/workspace-search/(search-open-editors.spec.ts)

import { containmentFold, isSameOrInsidePath, stripRootPrefix } from '@/lib/path-cross';
import { WORKSPACE_SCAN_EXCLUDE } from '../../../electron/shared/fs-limits';
import { isImagePreviewPath } from '../../../electron/shared/image-preview';
import {
  compileSearchPathFilter,
  matchSearchText,
  SEARCH_MAX_RESULTS,
  SEARCH_MAX_RESULTS_PER_FILE,
  type SearchFileResult,
  type SearchQuery,
} from '../../../electron/shared/workspace-search';

export interface OpenEditorDoc {
  readonly filePath: string;
  readonly content: string;
}

export interface OpenEditorSearch {
  /** 有命中的已打开文件(按 tab 顺序)。 */
  readonly files: readonly SearchFileResult[];
  readonly resultCount: number;
  /** 总结果达 SEARCH_MAX_RESULTS。 */
  readonly limitHit: boolean;
  /** 已在内存里搜过的文件(无论有无命中)的覆盖键:main 返回的同键结果丢弃。 */
  readonly searched: ReadonlySet<string>;
}

const EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set(WORKSPACE_SCAN_EXCLUDE);

/** 覆盖键:相对工作区根的 `/` 路径,按平台大小写策略折叠(与 main 结果的 relPath 对齐)。 */
export function searchOverrideKey(relPath: string, fold: (s: string) => string = containmentFold()): string {
  return fold(relPath);
}

/** 绝对路径 → 相对根的 `/` 路径(NFC,与 main 结果的 relPath 同口径);不在根下 → null。 */
export function searchRelPath(root: string, absPath: string): string | null {
  if (!isSameOrInsidePath(root, absPath)) return null;
  const rel = stripRootPrefix(root, absPath).replace(/\\/g, '/').normalize('NFC');
  return rel === '' ? null : rel;
}

export function searchOpenEditors(
  docs: readonly OpenEditorDoc[],
  root: string,
  query: SearchQuery,
  regex: RegExp,
): OpenEditorSearch {
  const fold = containmentFold();
  const filter = compileSearchPathFilter(query.include, query.exclude);
  const files: SearchFileResult[] = [];
  const searched = new Set<string>();
  let total = 0;
  let limitHit = false;
  for (const doc of docs) {
    if (limitHit) break;
    if (isImagePreviewPath(doc.filePath)) continue; // 图片 tab 的 content 是磁盘指纹,不是文本
    const rel = searchRelPath(root, doc.filePath);
    if (rel === null) continue;
    if (rel.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg))) continue; // 同 main 的工作区排除表
    if (filter !== null && !filter(rel)) continue;
    const key = searchOverrideKey(rel, fold);
    if (searched.has(key)) continue;
    searched.add(key);
    const budget = Math.min(SEARCH_MAX_RESULTS_PER_FILE, SEARCH_MAX_RESULTS - total);
    const found = matchSearchText(doc.content, regex, budget);
    if (found.matches.length > 0) {
      files.push({
        path: doc.filePath,
        relPath: rel,
        matches: found.matches,
        ...(found.more && budget === SEARCH_MAX_RESULTS_PER_FILE ? { truncated: true as const } : {}),
      });
      total += found.matches.length;
    }
    if (found.more && total >= SEARCH_MAX_RESULTS) limitHit = true;
  }
  return { files, resultCount: total, limitHit, searched };
}

/**
 * 合并 main 推来的一批磁盘结果:丢弃已在内存里搜过的文件,并把总数截在 SEARCH_MAX_RESULTS(超出 → limitHit,
 * 末个文件的命中截到剩余额度)。
 */
export function mergeDiskBatch(
  incoming: readonly SearchFileResult[],
  searched: ReadonlySet<string>,
  currentCount: number,
): { readonly files: readonly SearchFileResult[]; readonly added: number; readonly limitHit: boolean } {
  const fold = containmentFold();
  const files: SearchFileResult[] = [];
  let added = 0;
  let limitHit = false;
  for (const f of incoming) {
    if (searched.size > 0 && searched.has(searchOverrideKey(f.relPath, fold))) continue;
    const remaining = SEARCH_MAX_RESULTS - currentCount - added;
    if (remaining <= 0) {
      limitHit = true;
      break;
    }
    if (f.matches.length > remaining) {
      files.push({ ...f, matches: f.matches.slice(0, remaining) });
      added += remaining;
      limitHit = true;
      break;
    }
    files.push(f);
    added += f.matches.length;
  }
  return { files, added, limitHit };
}
