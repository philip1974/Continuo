// 「本进程刚原子替换了已有文件」登记表(性能:编辑器保存不触发 Explorer 整目录刷新)。
//
// 原子保存 = 写 `.<name>.continuo.tmp` 再 rename 覆盖 `<name>`。macOS 实测同 tick 内 fs.watch 只给
// ['rename', tmp]、['rename', name]×2,没有 'change' → 合并器 changeOnly 恒为 false,每次保存都让 Explorer
// 对所在目录整目录 listDir + 整树 rebuild(多窗口成倍)。但覆盖**已有**文件的原子保存不改变目录列表
// (tmp 在同一保存内出现又消失;name 前后都存在)。atomicWriteFile 在写 tmp 之前登记这两个名字,
// 合并器 flush 时若某目录本 tick 的文件名全部是登记过的名字,则按 changeOnly 处理。
//
// 宁多刷新不漏刷新:
// - 键按 dirname/basename **逐字**比较,不做大小写 / NFC 折叠:字面不一致(非 canonical 路径、
//   大小写不敏感卷上的不同写法)只会判为非 changeOnly(多刷新一次),不会把外部的同名变化误吞。
// - 一次 flush 命中目标名即消费该登记(连同其 tmp):之后同名事件(如保存后紧接的外部删除)按原语义刷新。
// - TTL 兜底:事件迟迟未到(目录未被 watch 等)的登记过期作废;条目数有上限。
// - 新建文件 / tmp 撞上 crash 残留(其删除对显示隐藏文件的 Explorer 可见)/ 写失败 → 不登记或撤销登记。

export const RECENT_ATOMIC_REPLACE_TTL_MS = 2000;
export const RECENT_ATOMIC_REPLACE_MAX = 256;

/** 原子写在 filePath 同目录使用的 tmp 文件名。 */
export function atomicWriteTmpName(name: string): string {
  return `.${name}.continuo.tmp`;
}

// key = dir + '\0' + name;target = 该条目所属目标文件的 key(目标条目自身 target === key)。
const entries = new Map<string, { expiresAt: number; target: string }>();

const keyOf = (dir: string, name: string): string => `${dir}\0${name}`;

function sweep(now: number): void {
  // 插入顺序 ≈ 过期顺序(TTL 固定,重新登记先删后插):遇到未过期即止。
  for (const [k, e] of entries) {
    if (e.expiresAt > now) break;
    entries.delete(k);
  }
  while (entries.size > RECENT_ATOMIC_REPLACE_MAX) {
    const oldest = entries.keys().next().value as string;
    entries.delete(oldest);
  }
}

function put(key: string, target: string, expiresAt: number): void {
  entries.delete(key); // 移到末尾,保持插入顺序 ≈ 过期顺序
  entries.set(key, { expiresAt, target });
}

/** 登记(或续期)「即将原子替换已有文件 dir/name」:目标名与其 tmp 名。须在写 tmp 之前调用。 */
export function markAtomicReplace(dir: string, name: string): void {
  const now = Date.now();
  const target = keyOf(dir, name);
  const expiresAt = now + RECENT_ATOMIC_REPLACE_TTL_MS;
  put(keyOf(dir, atomicWriteTmpName(name)), target, expiresAt);
  put(target, target, expiresAt);
  sweep(now);
}

/** 撤销登记(写失败 / tmp 撞上 crash 残留:本次事件可能改变目录列表)。 */
export function unmarkAtomicReplace(dir: string, name: string): void {
  entries.delete(keyOf(dir, name));
  entries.delete(keyOf(dir, atomicWriteTmpName(name)));
}

/**
 * 合并器 flush 用:dir 本 tick 的变更文件名是否**全部**属于未过期的原子替换登记。是 → 消费其中命中的
 * 目标(连同其 tmp)并返回 true;否 → 不消费,返回 false。空集合 → false。
 */
export function claimAtomicReplaceNames(dir: string, names: readonly string[]): boolean {
  if (names.length === 0 || entries.size === 0) return false;
  sweep(Date.now());
  const hit: string[] = [];
  for (const n of names) {
    const e = entries.get(keyOf(dir, n));
    if (!e) return false;
    hit.push(e.target);
  }
  for (const t of hit) {
    if (!names.some((n) => keyOf(dir, n) === t)) continue; // 只见 tmp(目标事件未到)→ 不消费
    const sep = t.indexOf('\0');
    unmarkAtomicReplace(t.slice(0, sep), t.slice(sep + 1));
  }
  return true;
}

/** 仅供测试:清空登记表。 */
export function resetAtomicReplaceMarksForTest(): void {
  entries.clear();
}
