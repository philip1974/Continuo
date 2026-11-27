// 保存冲突差异视图的纯逻辑(不依赖 CodeMirror / React,可单测)。BDD: src/__tests__/editor-save-conflict-compare/

import { basename, dirname, pathEquals } from '@/lib/path-cross';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';

/**
 * 两侧合计超过这么多字符不计算差异(只显示提示,接受 / 使用磁盘版本照常可用)。差异在渲染进程主线程上算(@codemirror/merge),
 * 另有单次计算超时(CONFLICT_DIFF_TIMEOUT_MS,超时给出较粗的差异);上限挡住几十 MB 的文档在打开 / 每次编辑时卡住界面。
 */
export const CONFLICT_DIFF_MAX_CHARS = 4_000_000;

/** 单次差异计算的时间上限(@codemirror/merge DiffConfig.timeout,毫秒)。 */
export const CONFLICT_DIFF_TIMEOUT_MS = 1000;

export function isConflictDiffTooLarge(diskChars: number, mineChars: number): boolean {
  return diskChars + mineChars > CONFLICT_DIFF_MAX_CHARS;
}

/** 差异块在两侧文档里的范围(@codemirror/merge Chunk 的子集)。 */
export interface DiffChunkRange {
  readonly fromA: number;
  readonly endA: number;
  readonly fromB: number;
  readonly endB: number;
}

/** 光标 pos 所在的差异块序号(0 起;side = 光标所在侧);不在任何块里 → -1。 */
export function chunkIndexAt(chunks: readonly DiffChunkRange[], pos: number, side: 'a' | 'b'): number {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const from = side === 'a' ? c.fromA : c.fromB;
    const end = side === 'a' ? c.endA : c.endB;
    if (pos >= from && pos <= end) return i;
  }
  return -1;
}

/** 文件名比较键(同外部同步:大小写 + Unicode NFC 折叠,宁多读不漏读)。 */
function foldName(name: string): string {
  return lowerIfNeeded(name.normalize('NFC'));
}

/**
 * fs:dir-changed(changedDir + 可选变更文件名集合)是否可能涉及 filePath(或其链接目标 realPath):直接父目录相同,且无集合或
 * 集合含该文件名。差异视图据此重读磁盘版本(误命中只多读一次)。
 */
export function dirChangeTouchesFile(
  changedDir: string,
  files: readonly string[] | undefined | null,
  filePath: string,
  realPath?: string,
): boolean {
  const names = files ? new Set(files.map(foldName)) : null;
  const hit = (p: string): boolean =>
    pathEquals(dirname(p), changedDir) && (names === null || names.has(foldName(basename(p))));
  return hit(filePath) || (realPath !== undefined && hit(realPath));
}
