// 拖文件夹到 Continuo 窗口(issue #23 衍生 UX)。
//
// VSCode 同款:用户拖文件夹到当前窗口 → 当前窗口换 workspace。文件 drop
// 暂不处理,后续 Phase 接 editor open。
//
// 纯函数版,接注入的 getPath / isDir,便于单测。生产端 getPath 来自
// coApi.window.getPathForFile(webUtils 包装),isDir 来自 coApi.fs.listDir
// 调用成功判定。

export interface DataTransferLike {
  readonly files: ReadonlyArray<File>;
}

// 边界(E189/E224,E176 同族有界遍历):dragenter/dragover/drop 高频同步事件检查 types 是否含 'Files'。
// 按索引遍历 + 命中即短路,不全量物化 types 列表。drop helpers 共享单一来源 —— Terminal
// (useTerminalDragDrop re-export)、App.tsx 全局 drop 共用,替代各处裸 `types.includes('Files')`
//(E224:App.tsx 是 E189 收口时漏掉的兄弟 dragover 入口)。类型守卫顺带把 dataTransfer 窄化为非 null。
// 注:返回**普通 boolean**(非 `is DataTransfer` 类型守卫)—— React.DragEvent.dataTransfer 类型为非空
// DataTransfer,对其用 `is DataTransfer` 守卫会让否定分支 narrow 成 never(Explorer 拖放 handler 的内部
// drag 分支仍要访问 e.dataTransfer)。调用方若需非空(原生 DragEvent.dataTransfer 可空)自行 null 检查。
export function hasFiles(dataTransfer: DataTransfer | null): boolean {
  if (dataTransfer === null) return false;
  const types = dataTransfer.types;
  for (let i = 0; i < types.length; i++) {
    if (types[i] === 'Files') return true;
  }
  return false;
}

// 边界(E114,Terminal/Explorer drop 数量上限的 window-drop 对偶):pickDroppedDirectory 此前对
// dataTransfer.files 全量逐个 getPath + isDir(IPC listDir)探测,无文件数/路径长度上限。畸形/超大
// 拖放(成千上万个文件,且无目录或目录在末尾)会让 renderer 发起成百上千次 IPC 探测 → UI 卡顿。
// 与 Terminal MAX_TERMINAL_DROP_FILES / Explorer MAX_DROP_FILE_COUNT(均 1000)对齐:最多探测
// MAX_DROP_FILES 个;超长路径(> MAX_DROP_PATH_LEN)不发起 isDir IPC,直接跳过。
export const MAX_DROP_FILES = 1000;
const MAX_DROP_PATH_LEN = 4096; // 典型文件系统 PATH_MAX 量级

/**
 * 边界(E118,E114 残留 + E116 同款):从 DataTransfer.files(FileList)**同步按索引**最多捕获
 * max 个 File,不全量 `Array.from` 物化超大 FileList。DataTransfer 仅事件期有效须同步捕获;
 * 调用点直接 Array.from(dt.files) 会在进入上限逻辑前就分配/遍历全部文件,绕过 MAX_DROP_FILES。
 */
export function captureBoundedFiles(
  files: ArrayLike<File>,
  max: number,
): File[] {
  const limit = Math.min(files.length, max);
  const out = new Array<File>(limit);
  let count = 0;
  for (let i = 0; i < files.length && count < max; i++) {
    const f = files[i];
    if (f) out[count++] = f;
  }
  out.length = count;
  return out;
}

/** webkitGetAsEntry 形态(DataTransferItem 上的非标准方法). */
interface EntryItem {
  webkitGetAsEntry?: () => { isDirectory: boolean } | null;
}

/**
 * 边界(E176,E114/E118 同族 captureBoundedFiles 兄弟):**按索引有界**检查前 max 个 DataTransferItem
 * 是否含目录(webkitGetAsEntry().isDirectory)。调用点 `Array.from(dt.items).slice(0,max).some(...)`
 * 会在 slice 前**全量物化** DataTransferItemList → 超大/畸形拖放在同步 drop 回调里分配/遍历全部 item,
 * 绕过 max 上限造成 UI 卡顿。本函数不用 Array.from,按索引循环且 i<max 提前停;命中目录即短路返回。
 * webkitGetAsEntry 须在事件回调同步读(进入 async 后 items 失效)。
 */
export function hasDirectoryInFirstItems(
  items: ArrayLike<unknown> | null | undefined,
  max: number,
): boolean {
  if (!items) return false;
  for (let i = 0; i < items.length && i < max; i++) {
    const it = items[i] as EntryItem | undefined;
    const entry = it?.webkitGetAsEntry?.();
    if (entry?.isDirectory === true) return true;
  }
  return false;
}

/**
 * 从拖入的 dataTransfer.files 中挑出**第一个目录**绝对路径。
 *  - 单个目录 → 返路径
 *  - 文件 + 目录混合 → 取第一个目录
 *  - 全是文件 / 空 → null
 *  - getPath 返空字符串 / isDir 抛错 → 视为非目录跳过
 */
export async function pickDroppedDirectory(
  data: DataTransferLike,
  getPath: (file: File) => string,
  isDir: (path: string) => Promise<boolean>,
): Promise<string | null> {
  if (!data.files || data.files.length === 0) return null;
  let examined = 0;
  for (const file of data.files) {
    // 边界(E114):限探测总数(getPath + isDir IPC),超出直接停止(返 null/已 ignore)。
    if (examined >= MAX_DROP_FILES) break;
    examined++;
    const p = getPath(file);
    // 边界(E114):空路径跳过;超长路径不发起 isDir IPC。
    if (!p || p.length > MAX_DROP_PATH_LEN) continue;
    let ok = false;
    try {
      ok = await isDir(p);
    } catch {
      ok = false;
    }
    if (ok) return p;
  }
  return null;
}

export interface ListDirResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly message?: string;
}

export type DroppedWorkspaceResult =
  | { readonly kind: 'open'; readonly path: string }
  | { readonly kind: 'error'; readonly code: string; readonly message: string }
  | { readonly kind: 'ignore' };

/**
 * a11y(A149):在 pickDroppedDirectory 之上区分三态,让 UI 能精准反馈 —— 拖入目录可打开
 * → open;**拖入了目录但 listDir 失败/reject** → error(带 code,UI notify);只拖文件 /
 * 空 → ignore(静默,文件 drop 暂不处理)。hadDirectory 由调用方在事件回调里同步用
 * webkitGetAsEntry 探测(进入 async 后 DataTransferItem 失效),据此区分「坏目录」与「文件」。
 */
export async function resolveDroppedWorkspace(
  data: DataTransferLike,
  hadDirectory: boolean,
  getPath: (file: File) => string,
  listDir: (path: string) => Promise<ListDirResult>,
): Promise<DroppedWorkspaceResult> {
  // 用对象 box 而非裸 let:lastDirError 仅在下面闭包里赋值,TS 控制流不追踪闭包赋值,裸 let
  // 会在 if 处被窄化成 null→never;对象属性 errBox.value 保留声明的联合类型,可正常真值窄化。
  const errBox: { value: { code: string; message: string } | null } = { value: null };
  const path = await pickDroppedDirectory(data, getPath, async (p) => {
    try {
      const r = await listDir(p);
      if (!r.ok) {
        errBox.value = { code: r.code ?? 'EXCEPTION', message: r.message ?? '' };
        return false;
      }
      return true;
    } catch (err) {
      errBox.value = {
        code: (err as { code?: string })?.code ?? 'EXCEPTION',
        message: (err as Error)?.message ?? '',
      };
      return false;
    }
  });
  if (path) return { kind: 'open', path };
  if (hadDirectory && errBox.value) {
    return { kind: 'error', code: errBox.value.code, message: errBox.value.message };
  }
  return { kind: 'ignore' };
}
