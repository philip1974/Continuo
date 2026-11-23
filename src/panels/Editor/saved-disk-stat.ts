// 编辑器保存回声识别(性能):保存成功后记录「本次写入内容」的 { mtimeMs, size, ino }(main 写完在 fd 上取、
// rename 后复核,见 atomicWriteFile)。原子写的 tmp + rename 会让 watcher 上报被保存文件本身,
// useExternalFileSync 命中后先发廉价 fs:stat 与此记录比对:相同 = 磁盘仍是自己刚写的内容 → 跳过整文件
// readFile;不同 / stat 失败 / 无记录 → 照旧读。不凭「刚保存过」跳过 —— 同时发生的外部写入会改变 stat。
//
// 记录按 tab 打开路径(filePath,外部同步正是按它 stat / 读)存,并带一个进程内单调的保存代际 gen;
// saveFile 把同一 gen 经 markSaved 写到 tab.savedGen。只有 tab.savedGen === 记录 gen(tab 当前基线仍是
// 那次写盘内容)时记录才适用:其后被外部 reload 换过内容(清 savedGen)、关闭重开(新 tab 无 savedGen)
// 都自然不匹配,照旧读。记录不持有写入内容(大文件内容不常驻 renderer,也免全文比较)。
// 清理:编辑器 chrome 变化(开关 / 删除 / 改名 tab、保存使脏标翻转等,chromeVersion 递增)时,丢弃不再被
// 任何打开 tab 以同 gen 引用的记录 → 只为打开的 tab 保留记录(写盘期间已关闭的 tab 留下的记录在下一次
// chrome 变化时清掉)。

import type { FsFileStat } from '../../../electron/shared/fs-channels';
import type { IpcResult } from '@/lib/fs/types';
import { useEditorStore, type EditorTab } from '@/stores/editor.store';

export interface SavedDiskStat extends FsFileStat {
  /** 保存代际(与 tab.savedGen 比对,确认记录仍对应 tab 当前基线). */
  readonly gen: number;
}

/** 记录条数上限(按最近保存保留;只影响能否省掉一次读,不影响正确性). */
const MAX_RECORDS = 256;

const records = new Map<string, SavedDiskStat>();
let genCounter = 0;
let unsubscribe: (() => void) | null = null;

/** 丢弃不再被任何打开 tab 以同 gen 引用的记录. */
function prune(tabs: readonly EditorTab[]): void {
  if (records.size === 0) return;
  const live = new Map<string, number | undefined>();
  for (const t of tabs) if (t.filePath !== null) live.set(t.filePath, t.savedGen);
  for (const [path, rec] of records) {
    if (live.get(path) !== rec.gen) records.delete(path);
  }
}

function ensurePruneSubscription(): void {
  if (unsubscribe) return;
  unsubscribe = useEditorStore.subscribe((s, prev) => {
    if (s.chromeVersion !== prev.chromeVersion) prune(s.tabs);
  });
}

/**
 * 保存成功后记录,返回本次保存代际(调用方经 markSaved 写到 tab.savedGen);
 * stat 未知(main 无法确认)→ 删除旧记录、返回 undefined,外部同步照旧读。
 */
export function recordSavedDiskStat(path: string, stat: FsFileStat | undefined): number | undefined {
  ensurePruneSubscription();
  records.delete(path); // 重新插入到末尾 = 最近使用
  if (!stat) return undefined;
  const gen = ++genCounter;
  records.set(path, { ...stat, gen });
  if (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (oldest !== undefined) records.delete(oldest);
  }
  return gen;
}

export function getSavedDiskStat(path: string): SavedDiskStat | undefined {
  return records.get(path);
}

/** 磁盘当前 stat 是否就是该记录写入时的 stat. */
export function isSameDiskStat(a: FsFileStat, b: FsFileStat): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

/**
 * 磁盘上的 path 是否仍是该 tab 最近一次保存写入的内容(tab.savedGen 对上记录、当前 stat 与记录一致)。
 * 无适用记录 → null(调用方照旧整读),不发 stat;stat 失败 / 抛错 → false。外部同步的保存回声识别与
 * 保存前冲突检测共用这一判断。
 */
export function ownSaveStatCheck(
  path: string,
  savedGen: number | undefined,
  stat: (path: string) => Promise<IpcResult<FsFileStat>>,
): Promise<boolean> | null {
  const rec = records.get(path);
  if (!rec || savedGen !== rec.gen) return null;
  return (async () => {
    try {
      const st = await stat(path);
      return st.ok && isSameDiskStat(st.data, rec);
    } catch {
      return false;
    }
  })();
}

/** 仅供测试:清空记录. */
export function _resetSavedDiskStatsForTest(): void {
  records.clear();
}
