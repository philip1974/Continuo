// 资源管理器文件操作撤销 / 重做(对齐 VSCode explorer 经 IUndoRedoService 的文件操作撤销):
// 改名 / 移动 → move,新建 / 粘贴复制 / 外部拖入的新文件 → create,删除(移到废纸篓 / 永久删除)→ delete。每个工作区根一份栈
//(renderer 即窗口)。执行前校验全部目标处于预期状态,不满足则不动磁盘;撤销 create = 移到废纸篓,一律先确认(VSCode
// explorer.confirmUndo 默认 "default":新建 / 复制的撤销是破坏性的,confirmBeforeUndo)。
// 删除照 VSCode bulkFileEdits DeleteOperation:删除前读回每个文件的内容(≤ MAX_UNDO_FILE_BYTES,fileActions MAX_UNDO_FILE_SIZE),
// 撤销 = 在原位置重建(位置被占 → 失败,不覆盖);文件夹只记「是文件夹」,撤销重建空文件夹;过大 / 读不了的文件不重建。
// 废纸篓里那份不动(VSCode 同:撤销从内存里的内容重建,不碰废纸篓)。撤销删除不确认(不是破坏性操作);重做删除 = 重新读回再删。
// BDD: src/__tests__/explorer-file-undo/

import type { FsApi } from '@/lib/fs/api';
import type { FsFileStat } from '@shared/fs-channels';
import { ERROR_CODES } from '@shared/error-codes';
import { isSameOrInsidePath, pathEquals } from '@/lib/path-cross';
import { basenamePreserveTrailing, dirname } from './path-utils';

export const FILE_UNDO_LIMIT = 50;

export interface MovePair {
  readonly from: string;
  readonly to: string;
}

/**
 * 重做 create 的方式;null = 无法重做(外部拖入,内容未保留)。
 * file / dir 的 rest:一次输入嵌套路径(`a/b/c.ts`)新建时,path 是本次新建的最上层目录,rest 是其下余下的段(`b/c.ts`,
 * `/` 分隔);重做时按「最上层名/rest」重新逐级创建。
 */
export type RedoCreate =
  | { readonly type: 'file' | 'dir'; readonly rest?: string }
  | { readonly type: 'copy'; readonly src: string }
  | null;

export interface CreatedEntry {
  /** 本次新建的最上层项(撤销删它即覆盖整条链)。 */
  readonly path: string;
  readonly redo: RedoCreate;
}

/**
 * 删除前读回的一项:file = 内容(撤销时原样写回);dir = 文件夹(撤销重建空文件夹,其下内容不重建,VSCode 同);
 * skipped = 过大(> MAX_UNDO_FILE_BYTES)/ 符号链接(symlink: true)/ 其它类型 / 读不了 —— 撤销不重建,提示可从废纸篓找回
 *(符号链接单独说明原因)。
 */
export type DeletedEntry =
  | { readonly path: string; readonly type: 'file'; readonly content: Uint8Array }
  | { readonly path: string; readonly type: 'dir' }
  | { readonly path: string; readonly type: 'skipped'; readonly symlink?: true };

/** 一次删除读回内容的总量上限:超出的文件按过大处理(撤销栈常驻内存;VSCode 不限总量,这里给栈的内存兜底)。 */
export const MAX_UNDO_DELETE_TOTAL_BYTES = 50 * 1024 * 1024;

export type FileUndoOp =
  | { readonly kind: 'move'; readonly pairs: readonly MovePair[] }
  | { readonly kind: 'create'; readonly entries: readonly CreatedEntry[] }
  | { readonly kind: 'delete'; readonly entries: readonly DeletedEntry[] };

export type FileUndoOutcome =
  | { status: 'empty' | 'busy' | 'cancelled' }
  /**
   * reveal:要在树里定位的项(null = 不定位)。撤销删除时另带 notRestored(未重建的项:过大 / 读不了)、notRestoredLinks
   *(未重建的符号链接)与 emptyFolders(重建成空文件夹的项),调用方据此提示「可从废纸篓找回」。
   */
  | {
      status: 'done';
      reveal: string | null;
      notRestored?: readonly string[];
      notRestoredLinks?: readonly string[];
      emptyFolders?: readonly string[];
    }
  /** path:本次撤销 / 重做的项;existing:目标位置已被它占用(FS_EEXIST,提示写「此位置已存在「…」」)。 */
  | { status: 'failed'; path: string; code: string; message: string; existing?: string };

type UndoFs = Pick<FsApi, 'stat' | 'move' | 'rename' | 'createFile' | 'createDir' | 'copy' | 'readForUndo' | 'writeBinary'>;

export interface FileUndoDeps {
  fs: UndoFs;
  /** 移到废纸篓 + 清理(同资源管理器删除流程;撤销新建、重做删除用);failure = 第一个失败项。 */
  trash: (paths: string[]) => Promise<{ removed: string[]; failure?: { path: string; code: string; message: string } }>;
  /** 路径已移走(editor tab / 展开集合 / 剪贴板跟随)。 */
  onMoved: (from: string, to: string) => void;
  refreshDir: (dir: string) => void;
  /** 撤销新建前确认(撤销新建 = 移到废纸篓,一律确认);unsaved = 其下未保存的编辑器数(确认框同删除确认给出警告);true = 继续。 */
  confirmUndoCreate: (paths: string[], unsaved: number) => Promise<boolean>;
  /** 这些路径下未保存的编辑器数。 */
  countUnsavedUnder: (paths: readonly string[]) => number;
}

interface Stacks {
  undo: FileUndoOp[];
  redo: FileUndoOp[];
  busy: boolean;
}
const stacksByRoot = new Map<string, Stacks>();

function stacksFor(root: string): Stacks {
  let s = stacksByRoot.get(root);
  if (!s) {
    s = { undo: [], redo: [], busy: false };
    stacksByRoot.set(root, s);
  }
  return s;
}

function pushLimited(stack: FileUndoOp[], op: FileUndoOp): void {
  stack.push(op);
  if (stack.length > FILE_UNDO_LIMIT) stack.splice(0, stack.length - FILE_UNDO_LIMIT);
}

/** 记录一次已完成的文件操作:入撤销栈并清空重做栈。空操作忽略。 */
export function recordFileOp(root: string, op: FileUndoOp): void {
  if (op.kind === 'move' && op.pairs.length === 0) return;
  if (op.kind !== 'move' && op.entries.length === 0) return;
  const s = stacksFor(root);
  s.redo.length = 0;
  pushLimited(s.undo, op);
}

/**
 * 删除前为撤销读回这些项(须在删除前、暂停自动保存之后调用)。嵌套在另一项之下的路径并入上级(删上级即删它)。
 * 读失败 / 过大 / 符号链接等 → skipped(删除照常进行,只是撤销不重建它);总量超 MAX_UNDO_DELETE_TOTAL_BYTES 的同样 skipped。
 */
export async function captureForUndo(fs: Pick<FsApi, 'readForUndo'>, paths: readonly string[]): Promise<DeletedEntry[]> {
  const top: string[] = [];
  for (const p of paths) {
    const nested = paths.some((q) => !pathEquals(q, p) && isSameOrInsidePath(q, p));
    if (!nested && !top.some((t) => pathEquals(t, p))) top.push(p);
  }
  let total = 0;
  const out: DeletedEntry[] = [];
  for (const path of top) {
    let entry: DeletedEntry = { path, type: 'skipped' };
    try {
      const r = await fs.readForUndo(path);
      if (r.ok && r.data.kind === 'dir') entry = { path, type: 'dir' };
      else if (r.ok && r.data.kind === 'symlink') entry = { path, type: 'skipped', symlink: true };
      else if (r.ok && r.data.kind === 'file' && total + r.data.content.length <= MAX_UNDO_DELETE_TOTAL_BYTES) {
        total += r.data.content.length;
        entry = { path, type: 'file', content: r.data.content };
      }
    } catch {
      /* 读不了:撤销不重建它 */
    }
    out.push(entry);
  }
  return out;
}

/** 删除完成后要入栈的 delete 操作:只含实际删掉的项(removed 里的,或其下的路径)。 */
export function deleteOpFor(
  entries: readonly DeletedEntry[],
  removed: readonly string[],
): Extract<FileUndoOp, { kind: 'delete' }> {
  return { kind: 'delete', entries: entries.filter((e) => removed.some((r) => pathEquals(r, e.path))) };
}

type Failure = Extract<FileUndoOutcome, { status: 'failed' }>;
const failure = (path: string, code: string, message = code): Failure => ({ status: 'failed', path, code, message });

/** stat:存在 → 'exists'(带 stat);不存在 → 'missing';其它错误 → Failure(无法确认状态,不动磁盘)。 */
async function probe(fs: UndoFs, path: string): Promise<{ st: FsFileStat } | 'missing' | Failure> {
  try {
    const r = await fs.stat(path);
    if (r.ok) return { st: r.data };
    return r.code === ERROR_CODES.FS_NOT_FOUND ? 'missing' : failure(path, r.code, r.message);
  } catch (err) {
    return failure(path, 'EXCEPTION', err instanceof Error ? err.message : String(err));
  }
}

async function expectExists(fs: UndoFs, path: string): Promise<Failure | FsFileStat> {
  const p = await probe(fs, path);
  if (p === 'missing') return failure(path, ERROR_CODES.FS_NOT_FOUND);
  return 'status' in p ? p : p.st;
}

/** 目标位置空闲且父目录存在;sameAs:同目录只差大小写的改名,目标 stat 到的是源自身(同 inode)也算空闲。 */
async function expectFree(fs: UndoFs, path: string, sameAs?: FsFileStat): Promise<Failure | null> {
  const p = await probe(fs, path);
  if (p !== 'missing') {
    if ('status' in p) return p;
    if (!(sameAs && sameAs.ino === p.st.ino)) return { ...failure(path, ERROR_CODES.FS_EEXIST), existing: path };
  }
  const parent = await expectExists(fs, dirname(path));
  return 'status' in parent ? parent : null;
}

const isFailure = (v: unknown): v is Failure => typeof v === 'object' && v !== null && 'status' in v;

async function runMoves(pairs: readonly MovePair[], forward: boolean, deps: FileUndoDeps): Promise<FileUndoOutcome> {
  const steps = forward ? pairs.map((p) => ({ src: p.from, dst: p.to })) : [...pairs].reverse().map((p) => ({ src: p.to, dst: p.from }));
  for (const { src, dst } of steps) {
    const st = await expectExists(deps.fs, src);
    if (isFailure(st)) return st;
    const sameDir = pathEquals(dirname(src), dirname(dst));
    const busy = await expectFree(deps.fs, dst, sameDir ? st : undefined);
    // 目标被占:失败归到本次撤销 / 重做的项(src),占位的路径放 existing。
    if (busy) return busy.existing !== undefined ? { ...busy, path: src } : busy;
  }
  try {
    for (const { src, dst } of steps) {
      const sameDir = pathEquals(dirname(src), dirname(dst));
      const r = sameDir
        ? await deps.fs.rename(src, basenamePreserveTrailing(dst))
        : await deps.fs.move(src, dst);
      deps.refreshDir(dirname(src));
      if (!sameDir) deps.refreshDir(dirname(dst));
      if (!r.ok) return failure(src, r.code, r.message);
      deps.onMoved(src, dst);
    }
  } catch (err) {
    return failure(steps[0]!.src, 'EXCEPTION', err instanceof Error ? err.message : String(err));
  }
  return { status: 'done', reveal: forward ? pairs[0]!.to : pairs[0]!.from };
}

async function undoCreate(root: string, op: Extract<FileUndoOp, { kind: 'create' }>, deps: FileUndoDeps): Promise<FileUndoOutcome> {
  const paths = op.entries.map((e) => e.path);
  for (const e of op.entries) {
    const st = await expectExists(deps.fs, e.path);
    if (isFailure(st)) return st;
  }
  // 撤销新建会把文件移进废纸篓:一律先确认(VSCode confirmBeforeUndo),不因「看起来没改过」就静默删除。
  if (!(await deps.confirmUndoCreate(paths, deps.countUnsavedUnder(paths)))) return { status: 'cancelled' };
  const r = await deps.trash(paths);
  if (r.failure) return failure(r.failure.path, r.failure.code, r.failure.message);
  const parent = dirname(paths[0]!);
  return { status: 'done', reveal: pathEquals(parent, root) ? null : parent };
}

async function redoCreate(op: Extract<FileUndoOp, { kind: 'create' }>, deps: FileUndoDeps): Promise<FileUndoOutcome> {
  for (const e of op.entries) {
    const busy = await expectFree(deps.fs, e.path);
    if (busy) return busy;
    if (e.redo?.type === 'copy') {
      const src = await expectExists(deps.fs, e.redo.src);
      if (isFailure(src)) return src;
    }
  }
  try {
    for (const e of op.entries) {
      const dir = dirname(e.path);
      const top = basenamePreserveTrailing(e.path);
      const name = e.redo?.type !== 'copy' && e.redo?.rest ? `${top}/${e.redo.rest}` : top;
      const r =
        e.redo?.type === 'copy'
          ? await deps.fs.copy(e.redo.src, e.path)
          : e.redo?.type === 'dir'
            ? await deps.fs.createDir(dir, name)
            : await deps.fs.createFile(dir, name);
      deps.refreshDir(dir);
      if (!r.ok) return failure(e.path, r.code, r.message);
    }
  } catch (err) {
    return failure(op.entries[0]!.path, 'EXCEPTION', err instanceof Error ? err.message : String(err));
  }
  return { status: 'done', reveal: op.entries[0]!.path };
}

/** 撤销删除:原位置全部空闲(且父目录存在)才动手,按记录重建文件内容 / 空文件夹;过大 / 读不了的不重建。 */
async function undoDelete(op: Extract<FileUndoOp, { kind: 'delete' }>, deps: FileUndoDeps): Promise<FileUndoOutcome> {
  const restorable = op.entries.filter((e) => e.type !== 'skipped');
  for (const e of restorable) {
    const busy = await expectFree(deps.fs, e.path);
    if (busy) return busy;
  }
  try {
    for (const e of restorable) {
      const dir = dirname(e.path);
      const r =
        e.type === 'file'
          ? await deps.fs.writeBinary(e.path, e.content)
          : await deps.fs.createDir(dir, basenamePreserveTrailing(e.path));
      deps.refreshDir(dir);
      if (!r.ok) return failure(e.path, r.code, r.message);
    }
  } catch (err) {
    return failure(restorable[0]!.path, 'EXCEPTION', err instanceof Error ? err.message : String(err));
  }
  const skipped = op.entries.filter((e) => e.type === 'skipped');
  const notRestored = skipped.filter((e) => !e.symlink).map((e) => e.path);
  const notRestoredLinks = skipped.filter((e) => e.symlink).map((e) => e.path);
  const emptyFolders = restorable.filter((e) => e.type === 'dir').map((e) => e.path);
  return {
    status: 'done',
    reveal: restorable[0]?.path ?? null,
    ...(notRestored.length > 0 && { notRestored }),
    ...(notRestoredLinks.length > 0 && { notRestoredLinks }),
    ...(emptyFolders.length > 0 && { emptyFolders }),
  };
}

/** 重做删除:撤销时重建的项须仍在;重新读回(之后又改过也按最新内容)再移到废纸篓。返回要入撤销栈的新 delete 操作。 */
async function redoDelete(
  root: string,
  op: Extract<FileUndoOp, { kind: 'delete' }>,
  deps: FileUndoDeps,
): Promise<{ outcome: FileUndoOutcome; next?: FileUndoOp }> {
  const paths = op.entries.filter((e) => e.type !== 'skipped').map((e) => e.path);
  for (const p of paths) {
    const st = await expectExists(deps.fs, p);
    if (isFailure(st)) return { outcome: st };
  }
  if (paths.length === 0) return { outcome: { status: 'done', reveal: null }, next: op };
  const entries = await captureForUndo(deps.fs, paths);
  const r = await deps.trash(paths);
  if (r.failure) return { outcome: failure(r.failure.path, r.failure.code, r.failure.message) };
  // 上次就没能重建的项(skipped)原样带着:再次撤销时同样提示它们可从废纸篓找回。
  const next: FileUndoOp = {
    kind: 'delete',
    entries: [...deleteOpFor(entries, r.removed).entries, ...op.entries.filter((e) => e.type === 'skipped')],
  };
  const parent = dirname(paths[0]!);
  return { outcome: { status: 'done', reveal: pathEquals(parent, root) ? null : parent }, next };
}

async function step(root: string, deps: FileUndoDeps, isUndo: boolean): Promise<FileUndoOutcome> {
  const s = stacksFor(root);
  if (s.busy) return { status: 'busy' };
  const from = isUndo ? s.undo : s.redo;
  const op = from.at(-1);
  if (!op) return { status: 'empty' };
  s.busy = true;
  try {
    let next: FileUndoOp | undefined = op;
    let outcome: FileUndoOutcome;
    if (op.kind === 'move') outcome = await runMoves(op.pairs, !isUndo, deps);
    else if (op.kind === 'delete') {
      if (isUndo) outcome = await undoDelete(op, deps);
      else ({ outcome, next } = await redoDelete(root, op, deps));
    } else outcome = isUndo ? await undoCreate(root, op, deps) : await redoCreate(op, deps);
    if (outcome.status === 'cancelled') return outcome;
    // 成功或失败都出栈:失败的操作前置状态已不成立(或已部分执行),留着会挡住更早的操作。
    from.splice(from.lastIndexOf(op), 1);
    if (outcome.status !== 'done' || next === undefined) return outcome;
    if (isUndo) {
      if (op.kind === 'create' && op.entries.some((e) => e.redo === null)) s.redo.length = 0;
      else pushLimited(s.redo, next);
    } else {
      pushLimited(s.undo, next);
    }
    return outcome;
  } finally {
    s.busy = false;
  }
}

export function undoFileOp(root: string, deps: FileUndoDeps): Promise<FileUndoOutcome> {
  return step(root, deps, true);
}

export function redoFileOp(root: string, deps: FileUndoDeps): Promise<FileUndoOutcome> {
  return step(root, deps, false);
}

export function __resetFileUndoForTest(): void {
  stacksByRoot.clear();
}
