// Explorer 路径 helper。跨平台基础判定(dirname / basename / 绝对路径 / 包含关系)的单一来源在 src/lib/path-cross,
// 这里转出 dirname / basename 供 Explorer 既有调用方,并放 Explorer 专用的批量路径处理。

import {
  containmentFold,
  containmentKey,
  someContainmentCandidate,
} from '@/lib/path-cross';
import { basenameForChrome } from '@/lib/path-label';

// dirname 与 basename 同在 renderer 跨平台路径单一来源 src/lib/path-cross(Editor 等其它模块直接从那里引)。
export { dirname } from '@/lib/path-cross';

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
 * Recent root 的显示 helper:name 即 basenameForChrome(旧 `p.match(/[^/\\]+$/)` 语义),parent 是最后一个
 * 分隔符之前的部分。尾部是分隔符 / 无分隔符时 name=原路径,parent=''。
 */
export function recentRootLabelParts(p: string): { name: string; parent: string } {
  const name = basenameForChrome(p);
  return { name, parent: name === p ? '' : p.slice(0, p.length - name.length - 1) };
}
