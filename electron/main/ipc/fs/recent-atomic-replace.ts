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
// - 一次 flush 中出现目标名即消费该登记(连同其 tmp),不论该批是否判为 changeOnly:之后同名事件(如保存后
//   紧接的外部删除)按原语义刷新。该目录本批文件名未知 / 该目录新装 watcher → 清掉该目录全部登记。
// - 按登记判为 changeOnly 的批,合并器异步复查被消费目标仍是普通文件(同批混入的外部删除),否则补发刷新。
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
 * 合并器 flush 用:**先判定、再无条件消费**。返回值:dir 本 tick 的变更文件名**全部**属于未过期登记 →
 * 本次消费的目标名数组(只见 tmp、目标事件未到 → 空数组);否则(含空集合)null。
 * 不论返回什么,names 中出现的已登记**目标名**都被消费(连同其 tmp):混入外部文件名的批虽按非 changeOnly
 * 刷新,登记也不能残留到之后把同名外部删除 / 改名误判为原子保存。
 */
export function claimAtomicReplace(dir: string, names: readonly string[]): string[] | null {
  if (names.length === 0 || entries.size === 0) return null;
  sweep(Date.now());
  let all = true;
  const targets: string[] = [];
  for (const n of names) {
    const key = keyOf(dir, n);
    const e = entries.get(key);
    if (!e) all = false;
    else if (e.target === key) targets.push(n); // tmp 名不在此消费:只见 tmp(目标事件未到)→ 保留目标
  }
  for (const n of targets) unmarkAtomicReplace(dir, n);
  return all ? targets : null;
}

/** claimAtomicReplace 的布尔形式(消费语义相同)。 */
export function claimAtomicReplaceNames(dir: string, names: readonly string[]): boolean {
  return claimAtomicReplace(dir, names) !== null;
}

/**
 * 清掉 dir(仅该目录,不含子目录)下的全部登记:合并器该目录本批文件名未知(超上限 / 缺 filename)时
 * 无从按名消费;dir 新装 watcher 时,此前未被 watch 而闲置的登记不得吞掉之后的外部变化。
 */
export function clearAtomicReplaceMarksInDir(dir: string): void {
  const prefix = keyOf(dir, '');
  for (const k of entries.keys()) if (k.startsWith(prefix)) entries.delete(k);
}

/** 仅供测试:清空登记表。 */
export function resetAtomicReplaceMarksForTest(): void {
  entries.clear();
}
