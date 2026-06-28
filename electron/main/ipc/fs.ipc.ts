import { BrowserWindow, dialog, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  defaultIsTrustedFrame,
  safeHandle,
  safeHandleWithCtx,
} from '../safe-handle';
import { FS_CHANNELS } from '../../shared/fs-channels';
import { MAX_WRITE_BYTES } from '../../shared/fs-limits';
import { utf8BytesExceed } from '../../shared/utf8-byte-length';
import { listDir, MAX_TOTAL_ENTRIES } from './fs/list-dir';
import { readFile } from './fs/read-file';
import { atomicWriteFile } from './fs/atomic-write';
import { renameEntry } from './fs/rename';
import { removeEntry } from './fs/remove';
import { createDir, createFile } from './fs/create';
import { copyEntry, moveEntry } from './fs/move-copy';
import { createWatcherPool } from './fs/watch';

// ────────────────────────────────────────────────────────────
// schemas — 全部 .strict() 拒绝未知字段(防 IPC 注入)
// ────────────────────────────────────────────────────────────

// 边界(E21,E13 同族):fs IPC 此前只 cap 了 content,path/newName/name/dir/src/dest 及 listDir
// exclude 无长度/数量上限。畸形 renderer/preload 调用可传超长路径或巨大 exclude 列表,在 IPC/zod/
// exclude 扫描路径消耗内存+CPU(listDir 还对每个目录项 O(N) exclude.includes)。统一加 PATH/NAME
// 上限 + exclude 数组上限;listDir 内把 exclude 转 Set 避免大目录线性放大(见 fs/list-dir.ts)。
const FS_PATH_MAX = 8192;
const FS_NAME_MAX = 1024;
const FS_EXCLUDE_MAX = 1000;
const fsPath = (): z.ZodString => z.string().min(1).max(FS_PATH_MAX);
const fsName = (): z.ZodString => z.string().min(1).max(FS_NAME_MAX);

const ListDirOptionsSchema = z
  .object({
    maxDepth: z.number().int().positive().optional(),
    exclude: z.array(z.string().max(FS_NAME_MAX)).max(FS_EXCLUDE_MAX).optional(), // 边界(E21)
    followSymlinks: z.boolean().optional(),
    // perf P2:文件数上限(深递归早停)。见 fs/list-dir.ts ListDirOptions.maxFiles。
    // 边界(E275):上界对齐到 MAX_TOTAL_ENTRIES 硬上限 + 安全整数 —— 此前只 positive int,畸形 IPC 可传
    // 1e308(仍过 z.int())绕过调用方早停,迫使主进程遍历/排序/回传近 10 万条放大。超上限直接 BAD_INPUT。
    maxFiles: z.number().int().positive().max(MAX_TOTAL_ENTRIES).optional(),
  })
  .strict();

export const listDirInputSchema = z
  .object({
    path: fsPath(),
    options: ListDirOptionsSchema.optional(),
  })
  .strict();

export const readFileInputSchema = z.object({ path: fsPath() }).strict();

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

export const renameInputSchema = z
  .object({ path: fsPath(), newName: fsName() })
  .strict();

export const removeInputSchema = z.object({ path: fsPath() }).strict();

export const createFileInputSchema = z
  .object({ dir: fsPath(), name: fsName() })
  .strict();

export const createDirInputSchema = z
  .object({ parent: fsPath(), name: fsName() })
  .strict();

export const trashInputSchema = z.object({ path: fsPath() }).strict();

export const revealInputSchema = z.object({ path: fsPath() }).strict();

export const moveInputSchema = z
  .object({ src: fsPath(), dest: fsPath() })
  .strict();

export const copyInputSchema = z
  .object({ src: fsPath(), dest: fsPath() })
  .strict();

// select-directory 显式严格:接受 undefined,拒绝 {} 与其它值
export const selectDirectoryInputSchema = z.undefined();

export const watchInputSchema = z.object({ path: fsPath() }).strict();
export const unwatchInputSchema = z.object({ path: fsPath() }).strict();

// 类型导出(给 preload / renderer 用)
export type ListDirInput = z.infer<typeof listDirInputSchema>;
export type ReadFileInput = z.infer<typeof readFileInputSchema>;
export type WriteFileInput = z.infer<typeof writeFileInputSchema>;
export type WriteBinaryInput = z.infer<typeof writeBinaryInputSchema>;
export type RenameInput = z.infer<typeof renameInputSchema>;
export type RemoveInput = z.infer<typeof removeInputSchema>;
export type CreateFileInput = z.infer<typeof createFileInputSchema>;
export type CreateDirInput = z.infer<typeof createDirInputSchema>;
export type TrashInput = z.infer<typeof trashInputSchema>;
export type RevealInput = z.infer<typeof revealInputSchema>;
export type MoveInput = z.infer<typeof moveInputSchema>;
export type CopyInput = z.infer<typeof copyInputSchema>;
export type WatchInput = z.infer<typeof watchInputSchema>;
export type UnwatchInput = z.infer<typeof unwatchInputSchema>;

// ────────────────────────────────────────────────────────────
// handlers — 浅函数,把 schema parse 后的对象映射给 fs 函数
// ────────────────────────────────────────────────────────────

export const listDirHandler = (input: ListDirInput) => listDir(input.path, input.options);
export const readFileHandler = (input: ReadFileInput) => readFile(input.path);
export const writeFileHandler = (input: WriteFileInput) => atomicWriteFile(input.path, input.content);
export const writeBinaryHandler = (input: WriteBinaryInput) => atomicWriteFile(input.path, input.content);
export const renameHandler = (input: RenameInput) => renameEntry(input.path, input.newName);
export const removeHandler = (input: RemoveInput) => removeEntry(input.path);
export const createFileHandler = (input: CreateFileInput) => createFile(input.dir, input.name);
export const createDirHandler = (input: CreateDirInput) => createDir(input.parent, input.name);
export const moveHandler = (input: MoveInput) => moveEntry(input.src, input.dest);
export const copyHandler = (input: CopyInput) => copyEntry(input.src, input.dest);

// trash / selectDirectory:工厂注入 deps,真 Electron API 留 E2E

export interface TrashDeps {
  trashItem: (path: string) => Promise<void>;
}
export const makeTrashHandler =
  (deps: TrashDeps) => async (input: TrashInput): Promise<void> => {
    await deps.trashItem(input.path);
  };

export interface RevealDeps {
  /** 真生产注入 Electron shell.showItemInFolder;测试可注入 spy. */
  showItemInFolder: (path: string) => void;
}
export const makeRevealHandler =
  (deps: RevealDeps) =>
  (input: RevealInput): void => {
    // shell.showItemInFolder 是同步 void;path 不存在时静默 noop.
    deps.showItemInFolder(input.path);
  };

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
// registerFsIpc — 拼装 9 条通道,真接 Electron API
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
  const rel = String(filename);
  const slashIdx = lastRelativePathSeparatorIndex(rel);
  const subdir = slashIdx >= 0 ? normalizeRelativeSubdir(rel, slashIdx) : '';
  return subdir ? pathMod.join(rootPath, subdir) : rootPath;
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

const watcherPool = createWatcherPool((rootPath, onChange) => {
  const watcher = fs.watch(
    rootPath,
    { persistent: false, recursive: RECURSIVE_SUPPORTED },
    (_eventType, filename) => {
      if (!filename) {
        // 罕见:某些 macOS 旧版 / 平台不传 filename,退回根目录广播
        onChange(rootPath);
        return;
      }
      onChange(resolveWatchChangedPath(rootPath, String(filename)));
    },
  );
  return { close: () => watcher.close() };
});

// 导出仅供 R66 回归测试(验证单窗口 send 抛错不中断广播);生产仍只经 watcherPool onChange 调用。
export function broadcastDirChanged(path: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.webContents.isDestroyed()) continue;
    // race(R66,R63/R64/R65 同族):isDestroyed() 检查后、send 前窗口可能销毁,send 抛
    // "Object has been destroyed"。本函数由 fs.watch 回调(onChange)触发,裸抛会:(1)中断
    // 循环 → 后续窗口漏收 DIR_CHANGED,Explorer/外部文件同步停在旧树/旧内容;(2)在异步事件
    // 回调里成主进程未捕获异常(噪声/崩溃风险)。每个窗口的 send 独立 try/catch,失败只跳过/
    // 记录并继续广播其它窗口。镜像 i18n(R64)/protocol(R63)/plugin-fs(R65)。
    try {
      w.webContents.send(FS_CHANNELS.DIR_CHANGED, { path });
    } catch (err) {
      console.error('[fs] DIR_CHANGED broadcast failed', err);
    }
  }
}

export function registerFsIpc(): void {
  const trusted = defaultIsTrustedFrame;

  safeHandle(FS_CHANNELS.LIST_DIR, listDirInputSchema, listDirHandler, trusted);
  safeHandle(FS_CHANNELS.READ_FILE, readFileInputSchema, readFileHandler, trusted);
  safeHandle(FS_CHANNELS.WRITE_FILE, writeFileInputSchema, writeFileHandler, trusted);
  safeHandle(FS_CHANNELS.WRITE_BINARY, writeBinaryInputSchema, writeBinaryHandler, trusted);
  safeHandle(FS_CHANNELS.RENAME, renameInputSchema, renameHandler, trusted);
  safeHandle(FS_CHANNELS.REMOVE, removeInputSchema, removeHandler, trusted);
  safeHandle(FS_CHANNELS.CREATE_FILE, createFileInputSchema, createFileHandler, trusted);
  safeHandle(FS_CHANNELS.CREATE_DIR, createDirInputSchema, createDirHandler, trusted);

  safeHandle(
    FS_CHANNELS.TRASH,
    trashInputSchema,
    makeTrashHandler({
      // shell.trashItem 在 Electron 38 是 Promise<void>
      trashItem: (p) => shell.trashItem(p),
    }),
    trusted,
  );

  safeHandle(
    FS_CHANNELS.REVEAL,
    revealInputSchema,
    makeRevealHandler({
      showItemInFolder: (p) => shell.showItemInFolder(p),
    }),
    trusted,
  );

  safeHandle(FS_CHANNELS.MOVE, moveInputSchema, moveHandler, trusted);
  safeHandle(FS_CHANNELS.COPY, copyInputSchema, copyHandler, trusted);

  safeHandle(
    FS_CHANNELS.SELECT_DIRECTORY,
    selectDirectoryInputSchema,
    makeSelectDirectoryHandler({
      showOpenDialog: (opts) =>
        // adapter 抽象用 ReadonlyArray<string>,Electron 真 API 要窄字面量 enum,
        // 真接处补 type assertion。spec 已断言 properties 含 'openDirectory'。
        dialog.showOpenDialog({
          properties: opts.properties as Electron.OpenDialogOptions['properties'],
        }),
    }),
    trusted,
  );

  // ── fs.watch 增量更新(Step 6) ──────────────────────────────
  // ctx-aware:记录发起 watch 的窗口 id,供窗口硬关闭时 releaseFsWatchersForWindow
  // 批量释放(React unmount cleanup 在硬关窗/崩溃时不保证执行,审计 P2)。
  safeHandleWithCtx(
    FS_CHANNELS.WATCH,
    watchInputSchema,
    (input, { event }) => {
      const ownerId = BrowserWindow.fromWebContents(event.sender)?.id;
      // 广播 creator 上抛的真实变更路径(可能 = input.path,也可能是其
      // recursive 子目录,见 issue #20)。
      watcherPool.watch(
        input.path,
        (changedPath) => broadcastDirChanged(changedPath),
        ownerId,
      );
    },
    trusted,
  );

  safeHandleWithCtx(
    FS_CHANNELS.UNWATCH,
    unwatchInputSchema,
    (input, { event }) => {
      const ownerId = BrowserWindow.fromWebContents(event.sender)?.id;
      watcherPool.unwatch(input.path, ownerId);
    },
    trusted,
  );
}

/** 窗口关闭时释放该窗口持有的全部 fs watcher 引用(审计 P2 资源泄漏)。 */
export function releaseFsWatchersForWindow(windowId: number): void {
  watcherPool.unwatchByOwner(windowId);
}
