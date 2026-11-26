// 资源管理器文件操作撤销 / 重做(对齐 VSCode explorer 经 IUndoRedoService 的文件操作撤销):
// 改名 / 移动 → move,新建 / 粘贴复制 / 外部拖入的新文件 → create;删除不入栈。每个工作区根一份栈(renderer 即窗口)。
// 执行前校验全部目标处于预期状态,不满足则不动磁盘;撤销 create = 移到废纸篓(被改过先确认)。
// BDD: src/__tests__/explorer-file-undo/

import type { FsApi } from '@/lib/fs/api';
import type { FsFileStat } from '@shared/fs-channels';
import { ERROR_CODES } from '@shared/error-codes';
import { pathEquals } from '@/lib/path-cross';
import { basenamePreserveTrailing, dirname } from './path-utils';

export const FILE_UNDO_LIMIT = 50;

export interface MovePair {
  readonly from: string;
  readonly to: string;
}

/** 重做 create 的方式;null = 无法重做(外部拖入,内容未保留)。 */
export type RedoCreate = { readonly type: 'file' | 'dir' } | { readonly type: 'copy'; readonly src: string } | null;

export interface CreatedEntry {
  readonly path: string;
  readonly redo: RedoCreate;
  /** 新建完成时的 stat(异步补上;缺失 = 未知 → 撤销前确认)。 */
  baseline?: FsFileStat | null;
}

export type FileUndoOp =
  | { readonly kind: 'move'; readonly pairs: readonly MovePair[] }
  | { readonly kind: 'create'; readonly entries: readonly CreatedEntry[] };

export type FileUndoOutcome =
  | { status: 'empty' | 'busy' | 'cancelled' }
  /** reveal:要在树里定位的项(null = 不定位)。 */
  | { status: 'done'; reveal: string | null }
  /** path:本次撤销 / 重做的项;existing:目标位置已被它占用(FS_EEXIST,提示写「此位置已存在「…」」)。 */
  | { status: 'failed'; path: string; code: string; message: string; existing?: string };

type UndoFs = Pick<FsApi, 'stat' | 'move' | 'rename' | 'createFile' | 'createDir' | 'copy'>;

export interface FileUndoDeps {
  fs: UndoFs;
  /** 移到废纸篓 + 清理(同资源管理器删除流程);failure = 第一个失败项。 */
  trash: (paths: string[]) => Promise<{ removed: string[]; failure?: { path: string; code: string; message: string } }>;
  /** 路径已移走(editor tab / 展开集合 / 剪贴板跟随)。 */
  onMoved: (from: string, to: string) => void;
  refreshDir: (dir: string) => void;
  /** 撤销新建前确认(新建项被改过);unsaved = 其下未保存的编辑器数(确认框同删除确认给出警告);true = 继续。 */
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

/** create 的基线 stat(新建完成时);失败记 null。 */
function fillBaselines(op: FileUndoOp, fs: Pick<FsApi, 'stat'>): Promise<void> {
  if (op.kind !== 'create') return Promise.resolve();
  return Promise.all(
    op.entries.map(async (e) => {
      try {
        const r = await fs.stat(e.path);
        e.baseline = r.ok ? r.data : null;
      } catch {
        e.baseline = null;
      }
    }),
  ).then(() => undefined);
}

/** 记录一次已完成的文件操作:入撤销栈并清空重做栈。空操作忽略。 */
export function recordFileOp(root: string, op: FileUndoOp, fs: Pick<FsApi, 'stat'>): void {
  if ((op.kind === 'move' ? op.pairs.length : op.entries.length) === 0) return;
  const s = stacksFor(root);
  pushLimited(s.undo, op);
  s.redo.length = 0;
  void fillBaselines(op, fs);
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
  const unsaved = deps.countUnsavedUnder(paths);
  let modified = unsaved > 0;
  for (const e of op.entries) {
    const st = await expectExists(deps.fs, e.path);
    if (isFailure(st)) return st;
    if (!e.baseline || e.baseline.mtimeMs !== st.mtimeMs || e.baseline.size !== st.size) modified = true;
  }
  if (modified && !(await deps.confirmUndoCreate(paths, unsaved))) return { status: 'cancelled' };
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
      const name = basenamePreserveTrailing(e.path);
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
  await fillBaselines(op, deps.fs);
  return { status: 'done', reveal: op.entries[0]!.path };
}

async function step(root: string, deps: FileUndoDeps, isUndo: boolean): Promise<FileUndoOutcome> {
  const s = stacksFor(root);
  if (s.busy) return { status: 'busy' };
  const from = isUndo ? s.undo : s.redo;
  const op = from.at(-1);
  if (!op) return { status: 'empty' };
  s.busy = true;
  try {
    const outcome =
      op.kind === 'move'
        ? await runMoves(op.pairs, !isUndo, deps)
        : isUndo
          ? await undoCreate(root, op, deps)
          : await redoCreate(op, deps);
    if (outcome.status === 'cancelled') return outcome;
    // 成功或失败都出栈:失败的操作前置状态已不成立(或已部分执行),留着会挡住更早的操作。
    from.splice(from.lastIndexOf(op), 1);
    if (outcome.status !== 'done') return outcome;
    if (isUndo) {
      if (op.kind === 'create' && op.entries.some((e) => e.redo === null)) s.redo.length = 0;
      else pushLimited(s.redo, op);
    } else {
      pushLimited(s.undo, op);
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
