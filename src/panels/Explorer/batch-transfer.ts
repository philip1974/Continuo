// Explorer 批量移动/复制 + 外部文件 drop 的单一实现(重构)。
//
// FolderTree 有三个「把一批路径移动/复制进同一目录」的入口:拖到具体 row(onDropItems)、拖到空白
// (root-drop)、粘贴(onPaste,cut=move / copy)。此前三处各自内联同一段循环 + try/catch/finally,
// 每个修复都要逐处传播且反复漏一处:P2-BB(部分成功刷新漏 root-drop)、R7(剪贴板 prune 漏 onPaste)、
// A134/A135/A136(IPC reject 无反馈逐个补)。收口后契约只有一处:
//   - 只处理最外层路径(outermostPaths:父目录与其子项同批时剔除子项,否则重复复制子树 / 移动拆散
//     层级或中途 FS_NOT_FOUND)。
//   - 目标名整批只探测一次;逐项顺序执行,某项失败即中止其余项。
//   - 某项失败也刷新目标目录(move 另刷新其源父目录):失败可能已部分写入(跨盘 move 已复制但源
//     未删净、递归 cp 中途失败),不刷新则已落盘的内容在树上不可见。
//   - 无论中途失败 / 抛异常,已成功项涉及的目录都刷新 —— 否则已移走的文件在树上凭空消失
//     (源没刷=还显示,目标没刷=不显示)而其 editor tab 路径已改 → 树/tab/磁盘三者不一致。
//   - move 已移走的源旧路径回报给调用方(剪贴板 prune:避免幻影 cut 灰显 + 失效 Paste)。
//   - 目标名探测 / fs 调用 reject 走 onException(调用点是 fire-and-forget async,无 catch 即
//     unhandled rejection 且无 toast/live region 反馈)。
//
// BDD: src/__tests__/explorer-batch-transfer/

import type { FsApi } from '@/lib/fs/api';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { basenamePreserveTrailing, dirname, outermostPaths } from './path-utils';
import {
  partitionDropItems,
  performDrop,
  type DropFsApi,
} from './drop-handlers';
import { notifyThrownError } from '@/notifications/notify-thrown-error';

// 批量 drop 失败明细:每行 `  name: [code] 本地化消息`(notify 多行正文)。
interface DropFailureLine {
  readonly name: string;
  readonly code: string;
  readonly message: string;
}

export function formatDropFailureLines(failed: readonly DropFailureLine[]): string {
  let out = '';
  for (let i = 0; i < failed.length; i += 1) {
    const f = failed[i]!;
    if (i > 0) out += '\n';
    // 原因与 code 相同(未收录 code 且无原文)时不再重复显示「[X] X」。
    const reason = localizeErrorByCode(f.code, f.message);
    out += reason === f.code ? `  ${f.name}: [${f.code}]` : `  ${f.name}: [${f.code}] ${reason}`;
  }
  return out;
}

export type BatchTransferKind = 'move' | 'copy';

export interface BatchTransferDeps {
  fs: Pick<FsApi, 'move' | 'copy'>;
  /** listDir 一次目标目录后返回本批次的唯一名 picker(见 FolderTree.makeUniqueDestPicker)。 */
  makeUniqueDestPicker: (destDir: string) => Promise<(name: string) => string>;
  /** 刷新某目录的树节点(invalidateChildrenIds)。 */
  refreshDir: (dir: string) => void;
  /** move 成功一项:同步 editor tab 路径(目录则前缀 rewrite 其下全部 tab)。 */
  onMoved: (src: string, dest: string) => void;
  /** move 批次结束:已移走的源旧路径(非空才调)。 */
  onSourcesGone: (srcs: string[]) => void;
  /** 某项 fs 返回 ok:false(其后各项不再尝试)。 */
  onItemFailed: (src: string, code: string, message: string) => void;
  /** 目标名探测 / fs 调用抛出。 */
  onException: (err: unknown) => void;
}

export interface BatchTransferOptions {
  /** 跳过已在目标目录的源(拖到原父目录是 no-op)。 */
  readonly skipSameParent?: boolean;
}

export async function transferEntriesInto(
  kind: BatchTransferKind,
  srcs: readonly string[],
  destDir: string,
  deps: BatchTransferDeps,
  opts: BatchTransferOptions = {},
): Promise<void> {
  const touchedSrcParents = new Set<string>();
  const movedSrcs: string[] = [];
  let refreshDest = false;
  try {
    const pickDest = await deps.makeUniqueDestPicker(destDir);
    // 先剔后代再判同父跳过:祖先因已在目标目录被跳过时,其后代也不该被单独移出来。
    for (const src of outermostPaths(srcs)) {
      if (opts.skipSameParent && dirname(src) === destDir) continue;
      // dest = destDir + src basename;已存在则自动加 ` copy` 后缀(picker 负责)。
      const dest = pickDest(basenamePreserveTrailing(src));
      const r = kind === 'move' ? await deps.fs.move(src, dest) : await deps.fs.copy(src, dest);
      if (!r.ok) {
        // 失败项可能已部分落盘 → 照样刷新目标 / 源父目录,但不算移走(不 onMoved / onSourcesGone)。
        refreshDest = true;
        if (kind === 'move') touchedSrcParents.add(dirname(src));
        deps.onItemFailed(src, r.code, r.message);
        return;
      }
      if (kind === 'move') {
        deps.onMoved(src, dest);
        touchedSrcParents.add(dirname(src));
        movedSrcs.push(src);
      }
      refreshDest = true;
    }
  } catch (err) {
    deps.onException(err);
  } finally {
    // move 的源旧路径已失效 → 回报(部分成功也只报已移走的,未移项留给调用方重试)。
    if (movedSrcs.length > 0) deps.onSourcesGone(movedSrcs);
    if (refreshDest) deps.refreshDir(destDir);
    for (const sp of touchedSrcParents) {
      if (sp !== destDir) deps.refreshDir(sp);
    }
  }
}

/**
 * 外部 OS 文件 drop 进 destDir(row 级与空白/root 级共用)。调用点是 fire-and-forget async:
 * performDrop 恒返 DropResult(A137),但 partitionDropItems / refreshDir 仍可能抛 → 统一 catch
 * 后 notify(A150/A151),不产生 unhandled rejection。仅在有问题时提示;成功由 fs.watch 自动刷新树。
 */
export async function dropForeignFilesInto(
  items: DataTransferItemList,
  destDir: string,
  fs: DropFsApi,
  refreshDir: (dir: string) => void,
): Promise<void> {
  try {
    const { files, skippedDirs } = partitionDropItems(items);
    if (files.length === 0 && skippedDirs.length === 0) return;
    const r = await performDrop(files, destDir, fs);
    refreshDir(destDir);
    if (skippedDirs.length > 0) {
      notify.error(t('errors.folder.skipped_dirs', { count: skippedDirs.length }));
    }
    if (!r.ok) {
      notify.error(
        t('errors.folder.batch_failed', { count: r.failed.length }) +
          '\n' +
          formatDropFailureLines(r.failed),
      );
    }
  } catch (err) {
    notifyThrownError(err);
  }
}
