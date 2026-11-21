// Drop 上传纯逻辑(M-Explorer Step 5d)。
// 把 DataTransferItemList / FileList 解析成可写入的 (path, bytes) 列表,
// 调 fs.writeBinary 写入,聚合成 DropResult 给 UI 提示。
//
// UI 层(FolderTree)只负责 dnd 事件接入与 hover 高亮,业务全在这里。

import type { IpcResult } from '@/lib/fs/types';
import { errorMessage } from '../../../electron/shared/error-message';
import { dirname } from './path-utils';
import { joinPath } from '@/lib/path-cross';
import { isValidLeafName, FS_NAME_MAX } from '../../../electron/shared/leaf-name';
import { MAX_DROP_FILES } from '@/lib/window-drop';
import { allSettledWithConcurrency } from '@/lib/map-with-concurrency';
import { lowerIfNeeded } from '../../../electron/shared/lower-if-needed';

export interface DropTargetEntry {
  path: string;
  isDirectory: boolean;
}

export interface DropFsApi {
  writeBinary: (path: string, content: Uint8Array) => Promise<IpcResult<void>>;
}

export interface DropResult {
  ok: boolean;
  written: string[];
  failed: { name: string; code: string; message: string }[];
}

/**
 * 落点判定:
 *  - target=null   → root(空白拖入)
 *  - target=folder → folder.path(进文件夹)
 *  - target=file   → dirname(file.path)(进文件父目录)
 */
export function resolveDropTarget(
  target: DropTargetEntry | null,
  rootPath: string,
): string {
  if (!target) return rootPath;
  if (target.isDirectory) return target.path;
  return dirname(target.path);
}

// 边界(E41 / E115):drop 数量/大小上限。E41 在 performDrop(写入侧)限单文件/累计字节/数量;
// E115 把数量上限**提前到 partition 阶段**,防超大 DataTransferItemList 在读文件前就大量
// webkitGetAsEntry/getAsFile 物化 File 数组(cap 此前只在 performDrop 太晚)。与 Terminal
// MAX_TERMINAL_DROP_FILES / window-drop MAX_DROP_FILES(均 1000)对齐。
const MAX_DROP_FILE_BYTES = 64 * 1024 * 1024; // 对齐主 fs.writeBinary 的 MAX_WRITE_BYTES(E13)
const MAX_DROP_TOTAL_BYTES = 512 * 1024 * 1024; // 单次 drop 累计字节上限
export const MAX_DROP_FILE_COUNT = MAX_DROP_FILES; // 单次 drop 文件数量上限(限 arrayBuffer/IPC 次数)
// 边界(E115):partition 总扫描上限(覆盖 file/dir/string 各 kind 项),防超大 items 列表
// 在 partition 循环里大量 webkitGetAsEntry / skippedDirs 膨胀;远大于 file 上限,正常拖放不受影响。
const MAX_DROP_SCAN_ITEMS = 4000;
// perf:performDrop 读写有界并发度。每个 worker 同一时刻至多持有一个 arrayBuffer,故在途读入内存
// ≤ DROP_IO_CONCURRENCY × MAX_DROP_FILE_BYTES(且仍受 MAX_DROP_TOTAL_BYTES 总量约束)。
const DROP_IO_CONCURRENCY = 4;

export interface PartitionResult {
  files: File[];
  skippedDirs: string[];
}

const EMPTY_DROP_FILES: File[] = [];
const EMPTY_SKIPPED_DIRS: string[] = [];

/**
 * 把 DataTransferItemList 拆成 file / 目录(skip)。
 * 文件夹拖入复杂(需 webkitGetAsEntry 递归),MVP 不支持;
 * 检测到目录就 skip,UI 层显示提示。
 */
export function partitionDropItems(
  items: DataTransferItemList | null,
): PartitionResult {
  if (!items) {
    return { files: EMPTY_DROP_FILES, skippedDirs: EMPTY_SKIPPED_DIRS };
  }

  let files: File[] | null = null;
  let fileCount = 0;
  let skippedDirs: string[] | null = null;
  let skippedDirCount = 0;

  // 边界(E115):总扫描上限 i < MAX_DROP_SCAN_ITEMS;另多收 1 个 File(> MAX_DROP_FILE_COUNT)
  // 即停 —— 让下游 performDrop 的 MAX_DROP_FILE_COUNT 检测仍能反馈 "too many",无需新增返回字段。
  for (let i = 0; i < items.length && i < MAX_DROP_SCAN_ITEMS; i++) {
    if (fileCount > MAX_DROP_FILE_COUNT) break;
    const item = items[i];
    if (!item || item.kind !== 'file') continue;

    const entry = (item as DataTransferItem & {
      webkitGetAsEntry?: () => { isDirectory: boolean; name: string } | null;
    }).webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      if (!skippedDirs) {
        skippedDirs = new Array<string>(
          Math.min(items.length, MAX_DROP_SCAN_ITEMS),
        );
      }
      skippedDirs[skippedDirCount++] = entry.name;
      continue;
    }

    const f = item.getAsFile();
    if (f) {
      if (!files) {
        files = new Array<File>(
          Math.min(items.length, MAX_DROP_FILE_COUNT + 1),
        );
      }
      files[fileCount++] = f;
    }
  }

  if (files) {
    files.length = fileCount;
  }
  if (skippedDirs) {
    skippedDirs.length = skippedDirCount;
  }
  return {
    files: files ?? EMPTY_DROP_FILES,
    skippedDirs: skippedDirs ?? EMPTY_SKIPPED_DIRS,
  };
}

// 边界(E41,E13 读侧对偶):performDrop 此前直接 `await file.arrayBuffer()` 把整个拖入文件读进
// renderer 内存,再交 fs.writeBinary;主进程虽有 64MiB 写入上限(E13),但 renderer 已先 OOM。
// 拖入超大文件或海量文件 → IPC 校验前 renderer 高内存峰值/卡死/崩溃。读前用 file.size 预检:
// 单文件超 MAX_DROP_FILE_BYTES(对齐写入上限)、累计超 MAX_DROP_TOTAL_BYTES、数量超
// MAX_DROP_FILE_COUNT 的项直接归 failed,绝不调 arrayBuffer()。常量统一声明于文件上方(E115)。

/**
 * 写入文件到 targetDir。同名文件由 fs.writeBinary 内部 atomic 覆盖,不弹确认;同名项是符号链接时替换链接
 * 本身、不写穿到链接目标(防恶意仓库 `README.md -> ~/.ssh/authorized_keys` 诱导拖放覆盖 workspace 外文件)。
 *
 * perf:读写有界并发(DROP_IO_CONCURRENCY)—— 此前逐个串行 arrayBuffer + IPC + fsync,
 * 拖入数百小文件时总耗时 ≈ 各项延迟之和。预检(数量/名字/大小/累计字节)仍按输入顺序串行
 * 先跑完,语义与原先一致;只把通过预检的读写放进 worker 池。
 * 同目标路径(大小写 + NFC 折叠后同键,覆盖大小写不敏感盘上 A.txt / a.txt 同一文件)按输入
 * 顺序串行:后项在前项写完后才读写 → 「后项覆盖前项」不变。主进程 atomicWriteFile 的写锁按
 * 真实路径字符串区分,不折叠大小写,故折叠串行须在这里做。
 * written / failed 按输入顺序汇总(每项结果落到下标槽位,最后顺序收集)。
 */
export async function performDrop(
  files: ReadonlyArray<File>,
  targetDir: string,
  fs: DropFsApi,
): Promise<DropResult> {
  type Failure = { name: string; code: string; message: string };
  type Outcome = { written: string } | { failed: Failure };
  const outcomes = new Array<Outcome | undefined>(files.length);
  const acceptedIdx = new Array<number>(Math.min(files.length, MAX_DROP_FILE_COUNT));
  let totalBytes = 0;
  let accepted = 0;
  const recordFailure = (index: number, failure: Failure) => {
    outcomes[index] = { failed: failure };
  };

  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    // 边界(E41):数量上限 —— 超出的项不读不写,归 failed(message 兜底展示)。
    if (accepted >= MAX_DROP_FILE_COUNT) {
      recordFailure(index, {
        name: file.name,
        code: 'DROP_TOO_MANY_FILES',
        message: `too many files in one drop (> ${MAX_DROP_FILE_COUNT})`,
      });
      continue;
    }
    // 边界(E268):外部 File.name 不可信 —— 含 / \ .. / 控制字符 / 超长会让 joinPath(targetDir, name) 产生
    // 穿越(写入子/父路径而非目标目录)或超长路径跨 IPC 放大。读 arrayBuffer / 拼 targetPath 前校验 leaf;
    // 非法直接归 failed(name 截断到 FS_NAME_MAX 防 failed 列表放大),与 main assertValidBasename 同源。
    if (!isValidLeafName(file.name)) {
      recordFailure(index, {
        name:
          typeof file.name === 'string'
            ? file.name.slice(0, FS_NAME_MAX)
            : 'invalid',
        code: 'FS_BAD_NAME',
        message: 'invalid file name (path separator, .., control char, or too long)',
      });
      continue;
    }
    // 边界(E41):单文件大小预检(读前 file.size,超限不 arrayBuffer)。FS_FILE_TOO_LARGE 已 i18n。
    if (file.size > MAX_DROP_FILE_BYTES) {
      recordFailure(index, {
        name: file.name,
        code: 'FS_FILE_TOO_LARGE',
        message: `file too large (${file.size} > ${MAX_DROP_FILE_BYTES})`,
      });
      continue;
    }
    // 边界(E41):累计总字节上限 —— 防海量中等文件求和成巨大 renderer 内存。
    if (totalBytes + file.size > MAX_DROP_TOTAL_BYTES) {
      recordFailure(index, {
        name: file.name,
        code: 'DROP_TOTAL_TOO_LARGE',
        message: `drop total size exceeds limit (${MAX_DROP_TOTAL_BYTES} bytes)`,
      });
      continue;
    }
    acceptedIdx[accepted++] = index;
    totalBytes += file.size;
  }
  acceptedIdx.length = accepted;

  const readAndWrite = async (index: number): Promise<void> => {
    const file = files[index]!;
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      recordFailure(index, {
        name: file.name,
        code: 'READ_ERROR',
        message: errorMessage(err),
      });
      return;
    }
    const targetPath = joinPath(targetDir, file.name);
    // a11y(A137):writeBinary reject(IPC 抛错而非返回 {ok:false})此前未捕获 → performDrop
    // 整体 reject,而调用点(FolderTree.handleDrop 外部文件分支)是 async 事件处理器不被
    // React await → unhandled rejection + 该文件不计入 failed,批量错误 toast 漏报。
    // 与上面 arrayBuffer 的 catch 同款:归类到 failed,让调用点能汇总提示。
    let r: IpcResult<void>;
    try {
      r = await fs.writeBinary(targetPath, bytes);
    } catch (err) {
      recordFailure(index, {
        name: file.name,
        code: 'WRITE_ERROR',
        message: errorMessage(err),
      });
      return;
    }
    if (r.ok) {
      outcomes[index] = { written: targetPath };
    } else {
      recordFailure(index, { name: file.name, code: r.code, message: r.message });
    }
  };

  // 按折叠目标键(大小写/NFC)分组,以组为 worker 任务:组内按输入顺序串行(后项覆盖前项),
  // 组间并发 DROP_IO_CONCURRENCY。此前每项一个任务、同键后项 await 前项链尾,若前 4 项同键,
  // 4 个 worker 全卡在同一条链上,后续异键文件队头阻塞。每个 worker 同一时刻只读/写一项,
  // 在途 arrayBuffer 仍 ≤ DROP_IO_CONCURRENCY;结果按下标记录,汇总顺序不变。readAndWrite 不抛。
  const groupsByKey = new Map<string, number[]>();
  for (const index of acceptedIdx) {
    const key = lowerIfNeeded(files[index]!.name.normalize('NFC'));
    const group = groupsByKey.get(key);
    if (group) group.push(index);
    else groupsByKey.set(key, [index]);
  }
  await allSettledWithConcurrency([...groupsByKey.values()], DROP_IO_CONCURRENCY, async (group) => {
    for (const index of group) await readAndWrite(index);
  });

  const written = new Array<string>(files.length);
  const failed = new Array<Failure>(files.length);
  let writtenCount = 0;
  let failedCount = 0;
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if ('written' in outcome) written[writtenCount++] = outcome.written;
    else failed[failedCount++] = outcome.failed;
  }
  written.length = writtenCount;
  failed.length = failedCount;

  return {
    ok: failedCount === 0,
    written,
    failed,
  };
}
