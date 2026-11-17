// Explorer 跨平台路径 helper(可维护性 M4:消除四处复制的 dirname)。
//
// 不引 path-browserify:规则简单且要同时吃 `/` 与 `\`(Windows)。tree-config /
// FolderTree / drop-handlers / mutate-actions 曾各自手写同一段 dirname,路径边界
// 规则一改要同步四处易漂移 → 收敛到此单一来源。

import {
  containmentFold,
  containmentKey,
  isBareWindowsDrive,
  someContainmentCandidate,
  trimTrailingSeparators,
} from '@/lib/path-cross';

/**
 * 跨平台 dirname:吃 `/` 与 `\`。先去尾部分隔符,取最后一个分隔符位置;
 * 无分隔符 → `''`(裸文件名);分隔符在 0 位(POSIX 根下直接项)→ `'/'`;
 * 父段是裸盘符 `X:`(Windows 盘根下直接项)→ `'X:\\'`(盘根)。
 *
 * 例:`/a/b` → `/a`;`/a/b/` → `/a`;`/a` → `/`;`a` → `''`;`C:\\x\\y` → `C:\\x`;
 *     `C:\\foo` → `C:\\`(盘根,**不是** `C:` —— 后者是「该盘当前目录」,会被当成
 *     另一路径 → listDir/invalidateChildrenIds 读错目录、UI 不刷新)。
 */
export function dirname(p: string): string {
  const trimmed = trimTrailingSeparators(p);
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx < 0) return '';
  const head = trimmed.slice(0, idx);
  // Windows 盘根:`C:\foo` 的父是盘根 `C:\`,不是 drive-relative `C:`。与 POSIX `/a → /`
  // 同等(根下直接项的父=根)。codex 跨平台复查 P2。
  if (isBareWindowsDrive(head)) return `${head}\\`;
  return head || '/';
}

/**
 * 批量操作只处理最外层路径:剔除「祖先也在批次里」的后代项,重复路径只留首个,其余保持输入顺序。
 * 多选 A 与 A/B 时,复制会把 B 随 A 复制一次后再单独复制一次;移动先移 A 后 A/B 已不存在而中途
 * 报错(或先移 A/B 拆散层级);删除同理。祖先判断与 isSameOrInsidePath(分隔符无关 + 平台感知
 * 大小写)精确等价,重复判定与 pathEquals 一致。
 *
 * perf:原为两两 isSameOrInsidePath 的 O(N²)(全选数千项时千万级比较)。改为按比较键分桶,每个
 * 路径只查其 O(depth) 个候选祖先键:原判据「存在 j≠i,q_j 覆盖 p_i 且(非 pathEquals 或 j<i)」
 * 在单桶内化为「桶最小下标 < i,或桶内存在与 p_i 不 pathEquals 的项」(pathEquals 是等价关系,
 * 按其键计数)。等价性见 explorer-path-utils/containment-equivalence.spec.ts。
 */
export function outermostPaths(paths: readonly string[]): string[] {
  const fold = containmentFold();
  // pathEquals 的等价键:Windows 运行时大小写折叠,否则原串(不 trim,与 pathEquals 一致)。
  const eqKey = fold;
  type Bucket = { minIndex: number; total: number; byEq: Map<string, number> };
  const buckets = new Map<string, Bucket>();
  for (let j = 0; j < paths.length; j++) {
    const q = paths[j]!;
    const key = containmentKey(q, fold);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { minIndex: j, total: 0, byEq: new Map() };
      buckets.set(key, bucket);
    }
    bucket.total += 1;
    const e = eqKey(q);
    bucket.byEq.set(e, (bucket.byEq.get(e) ?? 0) + 1);
  }
  const out = new Array<string>(paths.length);
  let count = 0;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i]!;
    const e = eqKey(p);
    const coveredBy = (key: string): boolean => {
      const bucket = buckets.get(key);
      if (!bucket) return false;
      if (bucket.minIndex < i) return true;
      return bucket.total - (bucket.byEq.get(e) ?? 0) > 0;
    };
    // 键 '' (纯分隔符根 / 空串)覆盖一切路径
    if (coveredBy('') || someContainmentCandidate(fold(p), coveredBy)) continue;
    out[count++] = p;
  }
  out.length = count;
  return out;
}

// 跨平台 basename(先去尾部分隔符再取最后一段)的实现与 Editor 共用,在 @/lib/path-cross。
export { basename } from '@/lib/path-cross';

/**
 * 跨平台 basename 的**不 trim 尾部分隔符**变体(逐字保留 FolderTree 唯一名 picker 的
 * 既有行为):`/a/b/` → `''`(尾斜杠后空段)。与 basename 语义不同,故单独命名,避免
 * 调用处误用 trim 版而隐式改变批量重名 picker 行为。其输入均为无尾斜杠的 fs 路径,
 * 实际结果与 basename 一致,命名只为显式标差异。
 */
export function basenamePreserveTrailing(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Recent root 的显示 helper:逐字保留旧 `p.match(/[^/\\]+$/)` 语义,但不走正则匹配分配。
 * 尾部是分隔符时旧逻辑匹配不到 → name=原路径,parent=''。
 */
export function recentRootLabelParts(p: string): { name: string; parent: string } {
  let end = p.length - 1;
  if (end < 0 || p.charCodeAt(end) === 47 || p.charCodeAt(end) === 92) {
    return { name: p, parent: '' };
  }

  while (end >= 0) {
    const code = p.charCodeAt(end);
    if (code === 47 || code === 92) break;
    end -= 1;
  }

  const nameStart = end + 1;
  const name = p.slice(nameStart);
  let parentEnd = nameStart;
  if (parentEnd > 0) {
    const code = p.charCodeAt(parentEnd - 1);
    if (code === 47 || code === 92) parentEnd -= 1;
  }
  return { name, parent: p.slice(0, parentEnd) };
}
