import { app, BrowserWindow, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { safeHandle, safeHandleWithCtx, senderWindowOrThrow, trustedSenderWindow } from '../safe-handle';
import {
  FS_CHANNELS,
  type FsDirChangedPayload,
  type FsFileStat,
  type FsReadFileData,
  type FsReadImageData,
  type FsUndoBackup,
} from '../../shared/fs-channels';
import { FS_PATH_MAX, MAX_UNDO_FILE_BYTES, MAX_WRITE_BYTES } from '../../shared/fs-limits';
import { utf8BytesExceed } from '../../shared/utf8-byte-length';
import { ERROR_CODES } from '../../shared/error-codes';
import { listDir, scanDir } from './fs/list-dir';
import type { FsScanFilesData } from '../../shared/fs-entry';
import { FS_IPC_NAME_MAX, ListDirOptionsSchema } from '../../shared/fs-list-dir-schema';
import { fsError, mapNodeErrnoCode } from './fs/path-utils';
import { readFile } from './fs/read-file';
import { encodeTextFile } from '../lib/text-codec';
import { TEXT_ENCODING_IDS, type TextEncodingId } from '../../shared/text-encoding';
import { readImage } from './fs/read-image';
import { guardPluginOpenedPath } from '../services/plugin-fs.service';
import { getWorkspaceRoot, isAnyWorkspaceRoot, setWorkspaceRootListener } from '../services/window-workspace-roots.service';
import { isSameOrInsidePath } from '../lib/path-inside';
import { isEditorDocument, recordEditorDocument } from '../services/window-editor-documents.service';
import {
  atomicReplaceFileNoFollow,
  atomicWriteFile,
  resolveSymlinkTarget,
  setSaveRecoveryDir,
  type AtomicWriteFileOptions,
} from './fs/atomic-write';
import { getMainT } from '../i18n';
import { renameEntry } from './fs/rename';
import { createDir, createFile } from './fs/create';
import { copyEntry, moveEntry } from './fs/move-copy';
import { selectTrashItem } from './fs/e2e-trash';
import { deletePermanently } from './fs/delete-permanently';
import {
  createRootPresenceTracker,
  createSameTickPathCoalescer,
  createWatcherPool,
  type WatcherCreator,
} from './fs/watch';
import { broadcastToWindows, sendToWindow } from '../lib/broadcast';
import { makeWcGoneHook } from '../lib/wc-gone-hook';
import { showOpenDialogRemembering } from '../lib/open-dialog';
import { menuCommandTargetWindow } from '../lib/menu-command';
import { makeShowSaveDialogHandler, showSaveDialogInputSchema } from './fs/save-dialog';
import { saveDocumentImage } from './fs/save-document-image';
import { MAX_DOCUMENT_IMAGE_BYTES } from '../../shared/document-image';

// ────────────────────────────────────────────────────────────
// schemas — 全部 .strict() 拒绝未知字段(防 IPC 注入)
// ────────────────────────────────────────────────────────────

// 边界(E21,E13 同族):fs IPC 此前只 cap 了 content,path/newName/name/dir/src/dest 及 listDir
// exclude 无长度/数量上限。畸形 renderer/preload 调用可传超长路径或巨大 exclude 列表,在 IPC/zod/
// exclude 扫描路径消耗内存+CPU(listDir 还对每个目录项 O(N) exclude.includes)。统一加 PATH/NAME
// 上限 + exclude 数组上限;listDir 内把 exclude 转 Set 避免大目录线性放大(见 fs/list-dir.ts)。
// FS_PATH_MAX 取 shared 单一来源(preload / plugin-fs 同值)。下面这个是 IPC schema 对「名字类字符串」
// (新建名 / exclude 项)的宽松长度闸,不是文件系统组件名上限(那是 shared/leaf-name 的 FS_NAME_MAX=255)。
const fsPath = (): z.ZodString => z.string().min(1).max(FS_PATH_MAX);
const fsName = (): z.ZodString => z.string().min(1).max(FS_IPC_NAME_MAX);


export const listDirInputSchema = z
  .object({
    path: fsPath(),
    options: ListDirOptionsSchema.optional(),
  })
  .strict();

/** 编辑器文本编码(见 shared/text-encoding);缺省 = 读取时自动识别(BOM / UTF-8)、写入时 UTF-8 无 BOM(改动前的行为)。 */
const textEncoding = () => z.enum(TEXT_ENCODING_IDS as [TextEncodingId, ...TextEncodingId[]]).optional();

export const readFileInputSchema = z.object({ path: fsPath(), encoding: textEncoding() }).strict();

export const statInputSchema = z.object({ path: fsPath() }).strict();

// workspaceOnly:Markdown 文档里引用的图片(来源不受信)只允许发送窗口的工作区内;图片 tab 自身(用户主动打开)不限。
// documentPath:引用图片的 Markdown 文档;它确是本窗口经 fs:read-file 打开过的文档时,其所在目录也是允许根(见 imageRootsFor)。
export const readImageInputSchema = z
  .object({ path: fsPath(), workspaceOnly: z.boolean().optional(), documentPath: fsPath().optional() })
  .strict();

// 边界(E13):fs:writeFile / fs:writeBinary 的 content 此前无大小上限。IPC payload 会先完整进入
// 主进程,再由 atomicWriteFile 写临时文件 + fsync。畸形/误操作的超大字符串/Uint8Array 会造成主
// 进程内存峰值、IPC 卡顿、超大临时文件(比 terminal.write 已有的 2MB cap 更不受控)。上限取
// 64 MiB —— 这是**滥用/误操作 backstop**(32× terminal.write),远超任何现实编辑文件/拖放资产
// (CodeMirror/Milkdown 编辑数 MB 已退化,不会到此),不破坏合法保存;真·大文件写入应另走流式/
// 分块接口(follow-up)。超限 → safeHandle 的 zod 校验失败 → BAD_INPUT。
// E44:MAX_WRITE_BYTES 移到 shared/fs-limits(顶部 import),plugin-fs(E29)+ renderer scoped-app
// (E44)复用同值防漂移。

export const writeFileInputSchema = z
  .object({
    path: fsPath(),
    // 边界(E125):按真实 UTF-8 字节校验(非 .max()=UTF-16 code unit 数)。含 CJK/emoji 的字符串
    // 在 content.length ≤ 64MiB 时真实字节可达数倍,绕过写盘 backstop → 超大临时文件/fsync 放大。
    content: z.string().refine((c) => !utf8BytesExceed(c, MAX_WRITE_BYTES), {
      message: `content 超过上限 ${MAX_WRITE_BYTES} 字节`,
    }),
    // 用户已确认覆盖写保护文件(FS_READONLY 后的「覆盖」):去掉写保护再写,见 atomicWriteFile。
    overwriteReadonly: z.boolean().optional(),
    // 按此编码(含其 BOM)写回;表示不了的字符 → FS_UNENCODABLE,不写。
    encoding: textEncoding(),
  })
  .strict();

export const writeBinaryInputSchema = z
  .object({
    path: fsPath(),
    content: z
      .instanceof(Uint8Array)
      .refine((u) => u.length <= MAX_WRITE_BYTES, {
        message: `content 超过上限 ${MAX_WRITE_BYTES} 字节`,
      }),
  })
  .strict();

// fs:save-document-image:Markdown 文档里粘贴 / 拖入的图片。fileName 只是「想要的名字」(main 取末段并清洗,见 save-document-image)。
export const saveDocumentImageInputSchema = z
  .object({
    documentPath: fsPath(),
    fileName: z.string().max(FS_IPC_NAME_MAX),
    data: z
      .instanceof(Uint8Array)
      .refine((u) => u.length > 0 && u.length <= MAX_DOCUMENT_IMAGE_BYTES, {
        message: `data 须为 1..${MAX_DOCUMENT_IMAGE_BYTES} 字节`,
      }),
  })
  .strict();

export const renameInputSchema = z
  .object({ path: fsPath(), newName: fsName() })
  .strict();


export const createFileInputSchema = z
  .object({ dir: fsPath(), name: fsName() })
  .strict();

export const createDirInputSchema = z
  .object({ parent: fsPath(), name: fsName() })
  .strict();

export const trashInputSchema = z.object({ path: fsPath() }).strict();
export const deletePermanentlyInputSchema = z.object({ path: fsPath() }).strict();

const revealInputSchema = z.object({ path: fsPath() }).strict();

export const moveInputSchema = z
  .object({ src: fsPath(), dest: fsPath() })
  .strict();

const copyInputSchema = z
  .object({ src: fsPath(), dest: fsPath() })
  .strict();

// select-directory 显式严格:接受 undefined,拒绝 {} 与其它值
export const selectDirectoryInputSchema = z.undefined();

const watchInputSchema = z.object({ path: fsPath() }).strict();
const unwatchInputSchema = z.object({ path: fsPath() }).strict();

// handler 入参类型(本文件内用;preload / renderer 的类型在 fs-channels.ts / fs-list-dir-schema.ts)
export type ListDirInput = z.infer<typeof listDirInputSchema>;
export type ReadFileInput = z.infer<typeof readFileInputSchema>;
export type StatInput = z.infer<typeof statInputSchema>;
export type ReadImageInput = z.infer<typeof readImageInputSchema>;
export type WriteFileInput = z.infer<typeof writeFileInputSchema>;
export type WriteBinaryInput = z.infer<typeof writeBinaryInputSchema>;
export type RenameInput = z.infer<typeof renameInputSchema>;
export type CreateFileInput = z.infer<typeof createFileInputSchema>;
export type CreateDirInput = z.infer<typeof createDirInputSchema>;
export type TrashInput = z.infer<typeof trashInputSchema>;
export type MoveInput = z.infer<typeof moveInputSchema>;
export type CopyInput = z.infer<typeof copyInputSchema>;

// ────────────────────────────────────────────────────────────
// handlers — 浅函数,把 schema parse 后的对象映射给 fs 函数
// ────────────────────────────────────────────────────────────

export const listDirHandler = (input: ListDirInput) => listDir(input.path, input.options);
// fs:scan-files(Quick Open):同一 schema / walker;子目录读不了跳过并计数(根读不了照旧失败)。
export const scanFilesHandler = async (input: ListDirInput): Promise<FsScanFilesData> =>
  scanDir(input.path, input.options);
// fs:read-file 是编辑器打开 / 外部同步 / 会话恢复 / 保存前比对的文本读取入口 → requireUtf8:非法 UTF-8
// 拒绝(FS_NOT_UTF8),防 U+FFFD 替换后保存写回损坏原文件(独立审计)。插件 fs readFile 不经此处。
// leaf 为 symlink 时随结果带 realPath(见 FsReadFileData):与保存写穿复用 resolveSymlinkTarget;解析失败 /
// 断链(返回原路径)/ 超长 → 不带,不影响读取结果。
// encoding:按编码解码(BOM / UTF-16 / 用户指定,见 read-file);结果的 encoding 只在不是 utf8 时带(旧形态不变)。
export const readFileHandler = async (input: ReadFileInput): Promise<FsReadFileData> => {
  const { content, encoding } = await readFile(input.path, input.encoding);
  const target = await resolveSymlinkTarget(input.path).catch(() => input.path);
  const enc = encoding === 'utf8' ? null : { encoding };
  return target !== input.path && target.length <= FS_PATH_MAX
    ? { content, realPath: target, ...enc }
    : { content, ...enc };
};
/**
 * Markdown 图片的允许根(对齐 VSCode markdown 预览的 localResourceRoots):发送窗口的工作区根;documentPath 是**本窗口
 * 经 fs:read-file 打开过的 Markdown 文档**(main 记账,见 window-editor-documents.service)时再加其所在目录 —— 工作区外的
 * 文档也能显示同目录 / 子目录图片。renderer 自报、但本窗口没打开过的 documentPath 不加任何根。
 */
function imageRootsFor(senderWindowId: number, documentPath: string | undefined): string[] {
  const roots: string[] = [];
  const workspaceRoot = getWorkspaceRoot(senderWindowId);
  if (workspaceRoot !== null) roots.push(workspaceRoot);
  if (documentPath !== undefined && isEditorDocument(senderWindowId, documentPath)) {
    roots.push(path.dirname(documentPath));
  }
  return roots;
}

// fs:read-image:workspaceOnly 时允许根取自 IPC 发送方窗口(main 推断,renderer 不自报;见 imageRootsFor);插件经
// editor.openFile 打开过的路径同 read-file 先在 plugin-fs 锁内确认未被换入链接。BDD: src/__tests__/editor-image-preview/
export const guardedReadImageHandler = (
  input: ReadImageInput,
  senderWindowId: number,
): Promise<FsReadImageData> =>
  guardPluginOpenedPath(input.path, () =>
    input.workspaceOnly === true
      ? readImage(input.path, imageRootsFor(senderWindowId, input.documentPath))
      : readImage(input.path),
  );
// 性能:返回写入内容的 { mtimeMs, size, ino }(无法确认 → undefined),编辑器据此识别自己保存的 dir-changed 回声,
// 免一次整文件 readFile(见 FsFileStat / useExternalFileSync)。
// encoding(utf8 以外):先整段编码成字节(含 BOM),表示不了的字符 → FS_UNENCODABLE,文件不动;再走同一原地写路径。
export const writeFileHandler = async (input: WriteFileInput): Promise<FsFileStat | undefined> => {
  const opts = { overwriteReadonly: input.overwriteReadonly === true };
  if (input.encoding === undefined || input.encoding === 'utf8') return saveEditorFile(input.path, input.content, opts);
  const encoded = encodeTextFile(input.content, input.encoding);
  if (!encoded.ok) {
    throw fsError(
      ERROR_CODES.FS_UNENCODABLE,
      `content has characters not representable in ${input.encoding} (U+${(encoded.unencodable.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}): ${input.path}`,
    );
  }
  if (encoded.bytes.length > MAX_WRITE_BYTES) {
    throw fsError(ERROR_CODES.FS_FILE_TOO_LARGE, `content 超过上限 ${MAX_WRITE_BYTES} 字节: ${input.path}`);
  }
  return saveEditorFile(input.path, encoded.bytes, opts);
};

/**
 * 编辑器保存写盘。原地写失败且没能还原原文件(FS_SAVE_ORIGINAL_DAMAGED)时把提示换成当前语言的完整说明(含恢复副本路径):
 * catalog 的 errors.FS_SAVE_ORIGINAL_DAMAGED 装不下路径,renderer 对这个 code 有 message 就原样显示(见 localizeErrorByCode)。
 * BDD: src/__tests__/save-in-place/save-in-place-cow-no-space.spec.ts
 */
async function saveEditorFile(
  filePath: string,
  content: string | Uint8Array,
  opts: AtomicWriteFileOptions,
): Promise<FsFileStat | undefined> {
  try {
    return await atomicWriteFile(filePath, content, opts);
  } catch (err) {
    if ((err as { code?: unknown }).code === ERROR_CODES.FS_SAVE_ORIGINAL_DAMAGED) {
      const recoveryPath = (err as { details?: { recoveryPath?: unknown } }).details?.recoveryPath;
      const t = getMainT();
      (err as Error).message =
        typeof recoveryPath === 'string'
          ? t('fs.save_original_damaged_copy', { path: recoveryPath })
          : t('fs.save_original_damaged_no_copy');
    }
    throw err;
  }
}
// 安全:注册到 fs:read-file / fs:write-file 的是这两个包装 —— 路径是插件经 editor.openFile 打开过的标签时,
// 读 / 写前在 plugin-fs 锁内确认路径没有被换入链接(见 guardPluginOpenedPath);其它路径原样直通。
export const guardedReadFileHandler = (input: ReadFileInput): Promise<FsReadFileData> =>
  guardPluginOpenedPath(input.path, () => readFileHandler(input));
// fs:read-file 注册的入口:读取成功后把 Markdown 文档登记为发送窗口打开过的文档(供 fs:read-image 放行其目录内图片)。
// 发送方无窗口(null)不登记。
export const recordingReadFileHandler = async (
  input: ReadFileInput,
  senderWindowId: number | null,
): Promise<FsReadFileData> => {
  const data = await guardedReadFileHandler(input);
  if (senderWindowId !== null) recordEditorDocument(senderWindowId, input.path);
  return data;
};
export const guardedWriteFileHandler = (input: WriteFileInput): Promise<FsFileStat | undefined> =>
  guardPluginOpenedPath(input.path, () => writeFileHandler(input));
// writeBinary 契约仍为 void(Dropzone 不需要回声识别),不把 stat 带过 IPC。
// 安全:调用方是外部文件拖入 Explorer(新建 / 放入语义,同名静默覆盖)与撤销删除的原位重建(调用方先确认位置空闲)。不复用编辑器保存的
// atomicWriteFile —— 它对 leaf 符号链接写穿到目标:恶意仓库放 `README.md -> ~/.ssh/authorized_keys`,
// 用户拖入同名文件即无确认覆盖 workspace 外文件。改为不跟随:目标是链接时替换链接本身,链接目标不受影响;
// 同名普通文件照旧原子覆盖。
export const writeBinaryHandler = async (input: WriteBinaryInput): Promise<void> => {
  await atomicReplaceFileNoFollow(input.path, input.content);
};
// fs:stat:跟随 symlink(与 readFile / 保存写穿同口径)取 { mtimeMs, size, ino };errno 同其它 fs 通道映射。
export const statHandler = async (input: StatInput): Promise<FsFileStat> => {
  try {
    const st = await fs.promises.stat(input.path);
    return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino };
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `stat failed: ${input.path}`);
  }
};
// fs:read-for-undo:资源管理器删除前为撤销读回该项(VSCode DeleteOperation:删除前 readFile,超过 maxSize 的不重建;文件夹只记
// 「是文件夹」,撤销重建空文件夹)。lstat 不跟随符号链接:链接不读成目标内容(撤销会把它重建成普通文件)。
export const readForUndoHandler = async (input: StatInput): Promise<FsUndoBackup> => {
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(input.path);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `lstat failed: ${input.path}`);
  }
  if (st.isDirectory()) return { kind: 'dir' };
  if (st.isSymbolicLink()) return { kind: 'symlink' };
  if (!st.isFile()) return { kind: 'unsupported' };
  if (st.size > MAX_UNDO_FILE_BYTES) return { kind: 'tooLarge' };
  let buf: Buffer;
  try {
    buf = await fs.promises.readFile(input.path);
  } catch (err) {
    throw fsError(mapNodeErrnoCode(err), `read failed: ${input.path}`);
  }
  // lstat 之后文件又变大(并发写入):同样按超限处理
  if (buf.length > MAX_UNDO_FILE_BYTES) return { kind: 'tooLarge' };
  return { kind: 'file', content: new Uint8Array(buf.buffer, buf.byteOffset, buf.length) };
};
export const renameHandler = (input: RenameInput) => renameEntry(input.path, input.newName);
export const createFileHandler = (input: CreateFileInput) => createFile(input.dir, input.name);
export const createDirHandler = (input: CreateDirInput) => createDir(input.parent, input.name);
const moveHandler = (input: MoveInput) => moveEntry(input.src, input.dest);
const copyHandler = (input: CopyInput) => copyEntry(input.src, input.dest);

// trash / selectDirectory:工厂注入 deps,真 Electron API 留 E2E

export interface TrashDeps {
  trashItem: (path: string) => Promise<void>;
}
export const makeTrashHandler =
  (deps: TrashDeps) => async (input: TrashInput): Promise<void> => {
    try {
      await deps.trashItem(input.path);
    } catch (err) {
      // shell.trashItem 对已不存在的路径只给平台文案、无 errno code:探测一次,不存在则报业务码 FS_NOT_FOUND
      //(renderer 据此按「已删除」做清理,不弹错误 —— 如删除确认框打开期间文件被外部删掉)。
      const gone = await fs.promises.lstat(input.path).then(
        () => false,
        (e: unknown) => (e as { code?: string }).code === 'ENOENT',
      );
      if (gone) throw fsError(ERROR_CODES.FS_NOT_FOUND, `not found: ${input.path}`);
      // 其余失败映射成业务码(renderer 按码本地化,不显示 `EACCES: permission denied, rename '…' -> '…'` 原始串)。
      throw fsError(await classifyTrashFailure(input.path, err), `trash failed: ${input.path}`);
    }
  };

/**
 * 移到废纸篓失败的业务码:权限 / 只读卷 → FS_DENIED / FS_READONLY_FS(永久删除同样会失败,只给原因);其它(卷不支持废纸篓、
 * 废纸篓不可用等)→ FS_TRASH_FAILED,renderer 据此询问是否永久删除(VSCode trashFailed)。shell.trashItem 的失败只有平台
 * 文案、没有 errno,故再探测父目录可写性(删除 = 改父目录)区分权限类失败。
 */
async function classifyTrashFailure(target: string, err: unknown): Promise<string> {
  const errnoCode = (err as { code?: unknown } | null)?.code;
  if (typeof errnoCode === 'string' && /^E[A-Z]+$/.test(errnoCode)) {
    const mapped = mapNodeErrnoCode(err);
    if (mapped === ERROR_CODES.FS_DENIED || mapped === ERROR_CODES.FS_READONLY_FS) return mapped;
  }
  const probe = await fs.promises.access(path.dirname(target), fs.constants.W_OK).then(
    () => null,
    (e: unknown) => mapNodeErrnoCode(e),
  );
  if (probe === ERROR_CODES.FS_DENIED || probe === ERROR_CODES.FS_READONLY_FS) return probe;
  return ERROR_CODES.FS_TRASH_FAILED;
}

export interface SelectDirectoryDeps {
  showOpenDialog: (opts: {
    properties: ReadonlyArray<string>;
  }) => Promise<{ canceled: boolean; filePaths: ReadonlyArray<string> }>;
}
export const makeSelectDirectoryHandler =
  (deps: SelectDirectoryDeps) => async (): Promise<string | null> => {
    const r = await deps.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || r.filePaths.length === 0) return null;
    return r.filePaths[0] ?? null;
  };

// ────────────────────────────────────────────────────────────
// registerFsIpc — 拼装全部 fs:* 通道,真接 Electron API
// ────────────────────────────────────────────────────────────

// Watcher pool 全局单例(进程级)。每个 path 一个 fs.watcher,onChange 广播给所有窗口。
//
// recursive 行为(issue #20):
//   - macOS / Win 走 native recursive(FSEvents / ReadDirectoryChangesW),
//     Agent 在深层子目录创建文件也能触发(用户不必精确展开每一层)
//   - Linux 不支持 fs.watch recursive,fallback non-recursive,行为同旧
//   - callback 收到 filename 时拼出真实变更子目录,creator 上抛精确路径,
//     上层 broadcast 给 renderer 后能 invalidate 实际变化的节点
const RECURSIVE_SUPPORTED =
  process.platform === 'darwin' || process.platform === 'win32';

/**
 * 由 watcher 回调的 (rootPath, filename) 算出实际变更的目录绝对路径。
 * filename 是相对 rootPath 的('a.ts' → 根;'sub/dir/a.ts' → sub/dir)。
 * 用 `pathMod.join` 拼接(平台原生分隔符):此前用 `${rootPath}/${subdir}` 在
 * Windows 上产出混合分隔符 `C:\proj/sub`,与 renderer 原生 `C:\proj\sub` tree id
 * 精确比较不相等 → 树刷新 / 外部文件同步漏触发(跨平台审计 P1)。
 * pathMod 可注入(测试用 path.win32 验 Windows 行为)。
 */
export function resolveWatchChangedPath(
  rootPath: string,
  filename: string,
  pathMod: Pick<typeof path, 'join'> = path,
): string {
  const rel = filename;
  const slashIdx = lastRelativePathSeparatorIndex(rel);
  const subdir = slashIdx >= 0 ? normalizeRelativeSubdir(rel, slashIdx) : '';
  return subdir ? pathMod.join(rootPath, subdir) : rootPath;
}

/**
 * watcher 回调 filename 的末段名(变更项在 changedPath 目录内的名字,分隔符 `/` `\` 都认)。
 * 末段为空 → undefined(视为未知文件,下游退化为目录级)。
 */
export function resolveWatchChangedFileName(filename: string): string | undefined {
  const rel = filename;
  const name = rel.slice(lastRelativePathSeparatorIndex(rel) + 1);
  return name === '' ? undefined : name;
}

function lastRelativePathSeparatorIndex(value: string): number {
  for (let i = value.length - 1; i >= 0; i -= 1) {
    const code = value.charCodeAt(i);
    if (code === 47 || code === 92) return i;
  }
  return -1;
}

function normalizeRelativeSubdir(value: string, endExclusive: number): string {
  let firstBackslash = -1;
  for (let i = 0; i < endExclusive; i += 1) {
    if (value.charCodeAt(i) === 92) {
      firstBackslash = i;
      break;
    }
  }
  if (firstBackslash < 0) return value.slice(0, endExclusive);

  let out = value.slice(0, firstBackslash);
  for (let i = firstBackslash; i < endExclusive; i += 1) {
    out += value.charCodeAt(i) === 92 ? '/' : value[i]!;
  }
  return out;
}

// 工作区根自身消失 / 重新出现 / 换成了另一个目录(见 createRootPresenceTracker):广播给所有窗口,不带文件名。
// 身份 = dev:ino(bigint,不丢精度):固定挂载点上的卷卸载 / 挂回时根路径一直存在,只有身份变。
// 换了目录 → 重建该根下的全部 watcher(旧 watcher 盯的可能是已卸载卷,挂回后不再有事件)。
// BDD: src/__tests__/explorer-root-unavailable/root-identity-change.spec.ts
const checkRootPresence = createRootPresenceTracker({
  isRoot: (p) => isAnyWorkspaceRoot(p),
  exists: (p) =>
    fs.promises.stat(p, { bigint: true }).then(
      (st) => `${st.dev}:${st.ino}`,
      (e: unknown) => {
        const code = (e as { code?: string }).code;
        return code === 'ENOENT' || code === 'ENOTDIR' ? false : null;
      },
    ),
  onReplaced: (root) => watcherPool.recreate((p) => isSameOrInsidePath(root, p)),
  onChange: (p) =>
    broadcastToWindows(FS_CHANNELS.ROOT_PRESENCE_CHANGED, () => ({ path: p }), '[fs] ROOT_PRESENCE_CHANGED'),
});
// 窗口设定工作区根时就记下根的身份作基线(资源管理器 watch 根可能早于 / 晚于设定根,不能只靠 watch 时那一次)。
setWorkspaceRootListener((root) => checkRootPresence.prime(root));

// 生产 creator(导出仅供回归测试)。健壮性(独立审计):FSWatcher 在网络盘 / 可移动卷断开、目录失效时
// 异步 emit('error'),EventEmitter 无 error 监听即抛 → 主进程未捕获异常崩溃。注册监听:warn + 上报池
// 关闭并移出该 watcher(WatcherPool evictDead)。
export const createFsWatcher: WatcherCreator = (rootPath, onChange, onError) => {
  const watcher = fs.watch(
    rootPath,
    { persistent: false, recursive: RECURSIVE_SUPPORTED },
    (eventType, filename) => {
      if (!filename) {
        // 罕见:某些 macOS 旧版 / 平台不传 filename(含 Windows 缓冲溢出),退回根目录广播,
        // 不带文件名 → 下游按目录级处理。根级事件可能就是根自身消失 / 卷卸载 → 同样复查根是否还在。
        checkRootPresence(rootPath);
        onChange(rootPath);
        return;
      }
      // 带上变更项名字(rename 的旧名/新名各回调一次),renderer 外部同步只重读命中的 clean tab
      const rel = filename;
      // filename = 根自身的 basename:可能是根被改名 / 删除 / 恢复(也可能只是根下同名子项,由 stat 区分)
      if (rel === path.basename(rootPath)) checkRootPresence(rootPath);
      // eventType 一并上抛,合并器据此判定「仅内容变化」(changeOnly,见 FsDirChangedPayload)
      onChange(resolveWatchChangedPath(rootPath, rel), resolveWatchChangedFileName(rel), eventType);
    },
  );
  watcher.on('error', (err) => {
    console.warn('[fs] watcher error, closing:', rootPath, err);
    onError(err);
    checkRootPresence(rootPath); // Windows 删除被 watch 的根 → EPERM error(不回调 basename)
  });
  return { close: () => watcher.close() };
};

// 导出仅供回归测试。watcher 失效被驱逐后持有者 renderer 仍以为已安装 → 推 WATCH_LOST 让其重装;
// 单窗口 send 抛错不中断其余窗口(同 broadcastToWindows)。
export function notifyWatchLost(path: string, ownerIds: readonly number[]): void {
  for (const id of ownerIds) {
    sendToWindow(BrowserWindow.fromId(id), FS_CHANNELS.WATCH_LOST, { path }, '[fs] WATCH_LOST');
  }
}

// 任一窗口的 workspace root 钉住不被 LRU 驱逐(外部修改同步依赖 root watcher,见 createWatcherPool isPinned)。
const watcherPool = createWatcherPool(createFsWatcher, notifyWatchLost, isAnyWorkspaceRoot);

// watch 引用按 BrowserWindow id 记账,但 renderer reload(webContents 与窗口都不变)时旧文档不会
// unwatch,新文档又重新 watch 已展开目录 → 旧引用永不释放(折叠后 fs.watch 关不掉、持续广播、占 LRU
// 名额)。主框架非同文档导航(及 renderer 崩溃)即释放该窗口全部引用,与关窗 releaseFsWatchersForWindow 同一路径;
// 导航开始在新文档脚本之前,新文档的重新 watch 不受影响。destroyed 时关窗路径已释放,这里幂等。
// dockview popout 的面板经 portal 由主窗 renderer 渲染,watch 的 sender 是主窗 webContents。
const watchOwnerByWc = new Map<number, number>();
const attachWatchWcGoneHook = makeWcGoneHook((wcId) => {
  const ownerId = watchOwnerByWc.get(wcId);
  watchOwnerByWc.delete(wcId); // reload 后新文档的 watch 会重新登记;关窗后不留残项
  if (ownerId !== undefined) watcherPool.unwatchByOwner(ownerId);
});

// 导出仅供 R66 回归测试(验证单窗口 send 抛错不中断广播);生产仍只经 watcherPool onChange 调用。
export function broadcastDirChanged(
  path: string,
  files?: readonly string[],
  changeOnly = false,
): void {
  // race(R66):由 fs.watch 回调触发;单窗口 send 抛错不中断其余窗口、不成未捕获异常。
  // files 未知 / changeOnly 为 false 时不带对应字段(payload 与旧版逐字一致)。
  const base: FsDirChangedPayload = files ? { path, files } : { path };
  const payload: FsDirChangedPayload = changeOnly ? { ...base, changeOnly: true } : base;
  broadcastToWindows(FS_CHANNELS.DIR_CHANGED, () => payload, '[fs] DIR_CHANGED');
}

// 生产 watch 回调入口:同 tick 内同一 changedPath(多个 recursive 祖先 watcher 重复报告)只广播一次
// (性能审计 #1,见 createSameTickPathCoalescer)。导出仅供回归测试。
export const queueDirChangedBroadcast = createSameTickPathCoalescer(broadcastDirChanged);

export function registerFsIpc(): void {

  safeHandle(FS_CHANNELS.LIST_DIR, listDirInputSchema, listDirHandler);
  safeHandle(FS_CHANNELS.SCAN_FILES, listDirInputSchema, scanFilesHandler);
  safeHandleWithCtx(FS_CHANNELS.READ_FILE, readFileInputSchema, (input, { event }) =>
    recordingReadFileHandler(input, BrowserWindow.fromWebContents(event.sender)?.id ?? null),
  );
  safeHandle(FS_CHANNELS.STAT, statInputSchema, statHandler);
  safeHandleWithCtx(FS_CHANNELS.READ_IMAGE, readImageInputSchema, (input, { event }) =>
    guardedReadImageHandler(input, senderWindowOrThrow(event, ERROR_CODES.FS_DENIED).id),
  );
  safeHandle(FS_CHANNELS.WRITE_FILE, writeFileInputSchema, guardedWriteFileHandler);
  safeHandle(FS_CHANNELS.WRITE_BINARY, writeBinaryInputSchema, writeBinaryHandler);
  safeHandle(FS_CHANNELS.READ_FOR_UNDO, statInputSchema, readForUndoHandler);
  // 工作区与「打开过的文档」取自 IPC 发送方窗口(main 记账,renderer 不自报)。
  safeHandleWithCtx(FS_CHANNELS.SAVE_DOCUMENT_IMAGE, saveDocumentImageInputSchema, (input, { event }) => {
    const windowId = senderWindowOrThrow(event, ERROR_CODES.FS_DENIED).id;
    return saveDocumentImage(input, {
      workspaceRoot: getWorkspaceRoot(windowId),
      isWindowDocument: (p) => isEditorDocument(windowId, p),
    });
  });
  safeHandle(FS_CHANNELS.RENAME, renameInputSchema, renameHandler);
  safeHandle(FS_CHANNELS.CREATE_FILE, createFileInputSchema, createFileHandler);
  safeHandle(FS_CHANNELS.CREATE_DIR, createDirInputSchema, createDirHandler);

  safeHandle(
    FS_CHANNELS.TRASH,
    trashInputSchema,
    makeTrashHandler({
      // shell.trashItem 在 Electron 38 是 Promise<void>;E2E 模式改挪进 <userData>/e2e-trash,不碰真实废纸篓。
      trashItem: selectTrashItem(process.env, () => app.getPath('userData'), (p) => shell.trashItem(p)),
    }),
  );

  // 永久删除(不可撤销):只在「无法移到废纸篓,是否永久删除?」确认后调用,见 fs/delete-permanently.ts。
  safeHandle(FS_CHANNELS.DELETE_PERMANENTLY, deletePermanentlyInputSchema, (input) =>
    deletePermanently(input.path, { isWorkspaceRoot: isAnyWorkspaceRoot, env: process.env }),
  );

  safeHandle(
    FS_CHANNELS.REVEAL,
    revealInputSchema,
    (input) => {
      // shell.showItemInFolder 是同步 void;path 不存在时静默 noop.
      shell.showItemInFolder(input.path);
    },
  );

  safeHandle(FS_CHANNELS.MOVE, moveInputSchema, moveHandler);
  safeHandle(FS_CHANNELS.COPY, copyInputSchema, copyHandler);

  safeHandle(
    FS_CHANNELS.SELECT_DIRECTORY,
    selectDirectoryInputSchema,
    makeSelectDirectoryHandler({
      showOpenDialog: (opts) =>
        // adapter 抽象用 ReadonlyArray<string>,Electron 真 API 要窄字面量 enum,
        // 真接处补 type assertion。spec 已断言 properties 含 'openDirectory'。
        // 经 showOpenDialogRemembering:Electron 43+ 未给 defaultPath 时固定从「下载」打开,这里记住上次位置。
        showOpenDialogRemembering({
          properties: opts.properties as Electron.OpenDialogOptions['properties'],
        }),
    }),
  );

  // 另存为的保存对话框(只返回路径,写入仍走 fs:write-file;见 fs/save-dialog.ts)。
  safeHandleWithCtx(FS_CHANNELS.SHOW_SAVE_DIALOG, showSaveDialogInputSchema, (input, { event }) =>
    makeShowSaveDialogHandler({
      senderWindow: () => trustedSenderWindow(event),
      parentFor: (owner) => {
        const focused = BrowserWindow.getFocusedWindow();
        return focused && focused !== owner && menuCommandTargetWindow(focused) === owner ? focused : owner;
      },
      // 调用时取 dialog.showSaveDialog(E2E 以桩替换它)
      showSaveDialog: (parent, opts) => dialog.showSaveDialog(parent, opts),
      homeDir: () => app.getPath('home'),
      recordDocument: recordEditorDocument,
    })(input),
  );

  // ── fs.watch 增量更新(Step 6) ──────────────────────────────
  // 记录发起 watch 的窗口 id,供窗口硬关闭时 releaseFsWatchersForWindow 批量释放(React unmount cleanup 在
  // 硬关窗 / 崩溃时不保证执行,审计 P2)。取不到 sender 窗口(销毁过程中到达)→ NO_WINDOW,与 terminal / debug-view
  // 同口径:此前降级为无 owner 的 watch,既不进 owner 记账也不挂 wc-gone 钩子,窗口释放时回收不到,引用常驻。
  safeHandleWithCtx(
    FS_CHANNELS.WATCH,
    watchInputSchema,
    (input, { event }) => {
      const ownerId = senderWindowOrThrow(event, ERROR_CODES.NO_WINDOW).id;
      watchOwnerByWc.set(event.sender.id, ownerId);
      attachWatchWcGoneHook(event.sender);
      // 广播 creator 上抛的真实变更路径(可能 = input.path,也可能是其
      // recursive 子目录,见 issue #20)。
      watcherPool.watch(input.path, queueDirChangedBroadcast, ownerId);
    },
  );

  safeHandleWithCtx(
    FS_CHANNELS.UNWATCH,
    unwatchInputSchema,
    (input, { event }) =>
      watcherPool.unwatch(input.path, senderWindowOrThrow(event, ERROR_CODES.NO_WINDOW).id),
  );
}

/**
 * 窗口获焦时(main index 接 app 'browser-window-focus')比对该窗口工作区根的身份:卷卸载 / 挂回不一定有任何 fs 事件
 *(固定挂载点上 `hdiutil detach` / `attach` 实测一个都没有)。无根 → 不查。
 */
export function checkWindowRootPresence(windowId: number): void {
  const root = getWorkspaceRoot(windowId);
  if (root !== null) checkRootPresence(root);
}

/** 原地保存失败且无法还原原文件时,完整原内容副本写到 `<userData>/save-recovery`(main index 启动时调用)。 */
export function configureSaveRecovery(userDataPath: string): void {
  setSaveRecoveryDir(path.join(userDataPath, 'save-recovery'));
}

/** 窗口关闭时释放该窗口持有的全部 fs watcher 引用(审计 P2 资源泄漏)。 */
export function releaseFsWatchersForWindow(windowId: number): void {
  watcherPool.unwatchByOwner(windowId);
}
