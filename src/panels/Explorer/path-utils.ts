// Explorer 路径 helper。跨平台基础判定(dirname / basename / 绝对路径 / 包含关系)的单一来源在 src/lib/path-cross,
// 这里转出 dirname / basename 供 Explorer 既有调用方,并放 Explorer 专用的批量路径处理。

import {
  basename,
  containmentFold,
  containmentKey,
  isSameOrInsidePath,
  someContainmentCandidate,
  stripRootPrefix,
} from '@/lib/path-cross';
import { basenameForChrome } from '@/lib/path-label';
import { t } from '@/i18n';
import { leafNameRejectReason } from '../../../electron/shared/leaf-name';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';

// dirname 与 basename 同在 renderer 跨平台路径单一来源 src/lib/path-cross(Editor 等其它模块直接从那里引)。
export { dirname } from '@/lib/path-cross';

/**
 * 同一目录内名字判重键:大小写折叠 + NFC(macOS 默认 / Windows 盘大小写不敏感,Finder 给的名字常是 NFD)。
 * 唯一名 picker(makeNamePicker)、外部 drop 同名检测与同目标串行共用,三处口径一致。
 */
export function sameNameKey(name: string): string {
  return lowerIfNeeded(name.normalize('NFC'));
}

/**
 * 目标目录 destDir 是否就是 src 本身或在其子树内(把 src 移动 / 复制进去会自我嵌套)。拖动的 canDrop 与
 * 批量传输漏斗 transferEntriesInto 共用此判定,粘贴不再漏掉。分隔符无关 + 平台感知大小写(isSameOrInsidePath)。
 */
export function isDestInsideSource(src: string, destDir: string): boolean {
  return isSameOrInsidePath(src, destDir);
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
 * Recent root 的显示 helper:name 即 basenameForChrome(旧 `p.match(/[^/\\]+$/)` 语义),parent 是最后一个
 * 分隔符之前的部分。尾部是分隔符 / 无分隔符时 name=原路径,parent=''。
 */
export function recentRootLabelParts(p: string): { name: string; parent: string } {
  const name = basenameForChrome(p);
  return { name, parent: name === p ? '' : p.slice(0, p.length - name.length - 1) };
}

/**
 * 最近目录项的可访问名称:以可见名称开头再接父路径(WCAG 2.5.3 Label in Name;对齐 VSCode 最近列表「名称, 路径」),
 * 同名目录仍可凭父路径区分;无父路径时就是名称。资源管理器「打开最近」菜单与空态最近列表共用。
 */
export function recentRootAccessibleName(p: string): string {
  const { name, parent } = recentRootLabelParts(p);
  return parent ? t('panels.explorer.menu.open_recent_item_aria', { name, parent }) : name;
}

/**
 * 新建输入框「在: …」的目录标签:相对工作区根的路径;根目录本身显示工作区名;不在根内则原样(绝对路径)。
 */
export function createDirLabel(root: string, dir: string): string {
  if (!isSameOrInsidePath(root, dir)) return dir;
  return stripRootPrefix(root, dir) || basenameForChrome(root);
}

/**
 * F2 重命名时预选的范围终点(起点恒为 0),VSCode Explorer 同款:文件选到最后一个点之前(只留扩展名不选);
 * 目录、无扩展名或点只在开头(.env)的文件全选。
 */
export function renameStemEnd(name: string, isDirectory: boolean): number {
  if (isDirectory) return name.length;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? dot : name.length;
}

/** 用户输入的文件 / 目录名:去首尾空白;空值 → null(视为取消)。新建与重命名共用。 */
export function normalizeLeafNameInput(raw: string): string | null {
  const name = raw.trim();
  return name === '' ? null : name;
}

/**
 * 重命名的目标名:规范化后为空、或与原名相同 → null(不发 IPC)。headless-tree 在提交时无条件以输入框值调 onRename
 *(初值即原名),不拦则「改名到自身」成功后剪贴板 prune 掉该路径、剪切标记凭空消失。仅大小写不同仍是改名。
 */
export function renameTarget(oldPath: string, raw: string): string | null {
  const current = basename(oldPath);
  // 先比原始输入:原名本身可带前导空格(合法),trim 后再比会把「未改名」误判为改名而静默改掉文件名。
  if (raw === current) return null;
  const name = normalizeLeafNameInput(raw);
  return name === null || name === current ? null : name;
}


/** 重命名输入的校验错误(VSCode validateFileName 同序:空名 → 重名 → 非法名)。 */
export type RenameInputError =
  | { readonly kind: 'empty' }
  | { readonly kind: 'exists'; readonly name: string }
  | { readonly kind: 'invalid'; readonly name: string };

/**
 * 重命名输入时的实时校验(VSCode Explorer validateFileName):未改名 → null;规范化后为空 → empty;与同目录其它项同名
 * → exists(排除自身:大小写不敏感盘上 a.ts → A.ts 是改名不是重名);不合法(与 main 端 assertValidBasename 同一规则)
 * → invalid。ignoreCase:重名比较是否忽略大小写(VSCode:macOS / Windows 忽略,Linux 区分)。
 */
export function renameInputError(
  raw: string,
  currentName: string,
  siblingNames: readonly string[],
  ignoreCase: boolean,
): RenameInputError | null {
  if (raw === currentName) return null;
  const name = normalizeLeafNameInput(raw);
  if (name === null) return { kind: 'empty' };
  if (name === currentName) return null;
  const fold = (s: string): string => {
    const nfc = s.normalize('NFC');
    return ignoreCase ? nfc.toLowerCase() : nfc;
  };
  const wanted = fold(name);
  for (const sibling of siblingNames) {
    if (sibling !== currentName && fold(sibling) === wanted) return { kind: 'exists', name };
  }
  if (leafNameRejectReason(name) !== null) return { kind: 'invalid', name };
  return null;
}

/**
 * 新建输入时的实时重名校验(VSCode validateFileName 的「已存在」:`parent.getChild(name)`,平台感知大小写):规范化后的名字
 * 与父目录已加载子项同名 → 返回该名字,否则 null。空名不报(Enter / 失焦按放弃处理);带路径分隔符的嵌套名(`a/b.ts`)
 * 不在这里判(中间目录可以已存在,提交时由 main 逐级创建判定)。父目录未加载的子项看不到,提交后 main 端兜底。
 */
export function createNameConflict(
  raw: string,
  siblingNames: readonly string[],
  ignoreCase: boolean,
): string | null {
  const name = normalizeLeafNameInput(raw);
  if (name === null || /[\\/]/.test(name)) return null;
  return renameInputError(name, '', siblingNames, ignoreCase)?.kind === 'exists' ? name : null;
}

/** 当前 renderer 所在系统的文件系统是否按惯例大小写敏感(VSCode 同:仅 Linux)。 */
export function isCaseSensitiveFsRuntime(): boolean {
  return typeof navigator !== 'undefined' && /^linux/i.test(navigator.platform ?? '');
}
