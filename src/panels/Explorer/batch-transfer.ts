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
//   - 目标与源的相对位置判定在这里,不靠调用方传参(此前只有拖动有 canDrop + skipSameParent,粘贴两道都漏):
//     move 源已在目标目录 → 跳过(no-op,不改名成 ` copy`);move 目标是源本身或在其子树内 → 整批不动,
//     报 FS_MOVE_INTO_SELF;copy 目标是源本身或在其子树内 → 改投源的父目录(生成 `A copy`,VSCode 同款)。
//
// BDD: src/__tests__/explorer-batch-transfer/

import type { FsApi } from '@/lib/fs/api';
import { notify } from '@/notifications/notify';
import { t } from '@/i18n';
import { localizeErrorByCode } from '@/lib/localize-error';
import { pathEquals } from '@/lib/path-cross';
import { ERROR_CODES } from '@shared/error-codes';
import {
  basenamePreserveTrailing,
  dirname,
  isDestInsideSource,
  outermostPaths,
} from './path-utils';
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
  /** move 成功一项:调用方做「路径已移走」清理(editor tab / 展开集合 / 剪贴板,见 path-gone-cleanup)。 */
  onMoved: (src: string, dest: string) => void;
  /** 某项 fs 返回 ok:false(其后各项不再尝试)。 */
  onItemFailed: (src: string, code: string, message: string) => void;
  /** 目标名探测 / fs 调用抛出。 */
  onException: (err: unknown) => void;
  /** 当前工作区根:源就是根时不改投其父目录(那在工作区之外,副本会静默落到树外)。 */
  root?: string;
}

export async function transferEntriesInto(
  kind: BatchTransferKind,
  srcs: readonly string[],
  destDir: string,
  deps: BatchTransferDeps,
): Promise<void> {
  // 结束时要刷新的目录:实际写入的目标目录(粘贴到源自身时改投其父目录)+ move 的源父目录。
  const toRefresh = new Set<string>();
  try {
    // 对齐 VSCode(explorer paste):目标就是源本身 → 改投源的父目录(copy 生成 `A copy`;move 于是落回原父目录 → no-op)。
    // 先剔后代再判同父跳过:祖先因已在目标目录被跳过时,其后代也不该被单独移出来。
    // move 已在(实际)目标目录 → no-op(拖到原父目录 / 剪切后粘贴回原目录;不跳过则 picker 见同名改成 ` copy`)。
    // 源就是工作区根(切换 root 后剪贴板仍持有旧 root 下的该目录):父目录在工作区外 → 不改投,按「粘贴到自身」报错
    //(VSCode 中 root 元素无 parent,同样失败而不写到外面)。
    const redirectable = (src: string): boolean =>
      pathEquals(src, destDir) && !(deps.root !== undefined && pathEquals(src, deps.root));
    const items = outermostPaths(srcs)
      .map((src) => ({ src, dir: redirectable(src) ? dirname(src) : destDir }))
      .filter(({ src, dir }) => !(kind === 'move' && pathEquals(dirname(src), dir)));
    // 目标严格在源内部(粘贴到自身的子文件夹):VSCode 报「要粘贴的文件是目标文件夹的上级」。move 底层 rename 报 EINVAL、
    // copy 的 fs.cp 报 ERR_FS_CP_EINVAL,都会被映射成误导的「文件 I/O 错误」。整批先判,不做半截。
    const bad = items.find(({ src, dir }) => isDestInsideSource(src, dir));
    if (bad !== undefined) {
      deps.onItemFailed(bad.src, ERROR_CODES.FS_MOVE_INTO_SELF, t('errors.FS_MOVE_INTO_SELF'));
      return;
    }
    // 目标名每个目标目录只探测一次(listDir 快照)。
    const pickers = new Map<string, (name: string) => string>();
    const pickerFor = async (dir: string): Promise<(name: string) => string> => {
      let pick = pickers.get(dir);
      if (!pick) {
        pick = await deps.makeUniqueDestPicker(dir);
        pickers.set(dir, pick);
      }
      return pick;
    };
    for (const { src, dir } of items) {
      // dest = dir + src basename;已存在则自动加 ` copy` 后缀(picker 负责)。
      const dest = (await pickerFor(dir))(basenamePreserveTrailing(src));
      const r = kind === 'move' ? await deps.fs.move(src, dest) : await deps.fs.copy(src, dest);
      // 失败项可能已部分落盘 → 照样刷新目标 / 源父目录,但不算移走(不 onMoved)。
      toRefresh.add(dir);
      if (kind === 'move') toRefresh.add(dirname(src));
      if (!r.ok) {
        deps.onItemFailed(src, r.code, r.message);
        return;
      }
      if (kind === 'move') deps.onMoved(src, dest);
    }
  } catch (err) {
    deps.onException(err);
  } finally {
    for (const d of toRefresh) deps.refreshDir(d);
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
