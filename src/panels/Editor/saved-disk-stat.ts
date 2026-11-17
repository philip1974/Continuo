// 编辑器保存回声识别(性能):保存成功后记录「本次写入内容」的 { mtimeMs, size }(main 写完在 fd 上取、
// rename 后复核,见 atomicWriteFile)。原子写的 tmp + rename 会让 watcher 上报被保存文件本身,
// useExternalFileSync 命中后先发廉价 fs:stat 与此记录比对:相同 = 磁盘仍是自己刚写的内容 → 跳过整文件
// readFile;不同 / stat 失败 / 无记录 → 照旧读。不凭「刚保存过」跳过 —— 同时发生的外部写入会改变 stat。
//
// 记录按 tab 打开路径(filePath,外部同步正是按它 stat / 读)存,并带写入的内容:只有 tab 当前基线
// (originalContent)仍是这份内容时记录才适用(其后被外部 reload 换过内容即不匹配,照旧读)。

import type { FsFileStat } from '../../../electron/shared/fs-channels';

export interface SavedDiskStat extends FsFileStat {
  /** 本次写盘的内容(与 tab.originalContent 比对,确认记录仍对应 tab 当前基线). */
  readonly content: string;
}

/** 记录条数上限(按最近保存保留;只影响能否省掉一次读,不影响正确性). */
const MAX_RECORDS = 256;

const records = new Map<string, SavedDiskStat>();

/** 保存成功后记录;stat 未知(main 无法确认)→ 删除旧记录,外部同步照旧读。 */
export function recordSavedDiskStat(
  path: string,
  stat: FsFileStat | undefined,
  content: string,
): void {
  records.delete(path); // 重新插入到末尾 = 最近使用
  if (!stat) return;
  records.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, content });
  if (records.size > MAX_RECORDS) {
    const oldest = records.keys().next().value;
    if (oldest !== undefined) records.delete(oldest);
  }
}

export function getSavedDiskStat(path: string): SavedDiskStat | undefined {
  return records.get(path);
}

/** 磁盘当前 stat 是否就是该记录写入时的 stat. */
export function isSameDiskStat(a: FsFileStat, b: FsFileStat): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/** 仅供测试:清空记录. */
export function _resetSavedDiskStatsForTest(): void {
  records.clear();
}
