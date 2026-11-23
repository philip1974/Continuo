import { BrowserWindow, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  safeHandle,
  safeHandleWithCtx,
} from '../safe-handle';
import {
  FS_CHANNELS,
  type FsDirChangedPayload,
  type FsFileStat,
  type FsReadFileData,
} from '../../shared/fs-channels';
import { FS_PATH_MAX, MAX_WRITE_BYTES } from '../../shared/fs-limits';
import { utf8BytesExceed } from '../../shared/utf8-byte-length';
import { listDir, MAX_TOTAL_ENTRIES } from './fs/list-dir';
import { fsError, mapNodeErrnoCode } from './fs/path-utils';
import { readFile } from './fs/read-file';
import { guardPluginOpenedPath } from '../services/plugin-fs.service';
import { atomicReplaceFileNoFollow, atomicWriteFile, resolveSymlinkTarget } from './fs/atomic-write';
import { renameEntry } from './fs/rename';
import { createDir, createFile } from './fs/create';
import { copyEntry, moveEntry } from './fs/move-copy';
import { createSameTickPathCoalescer, createWatcherPool, type WatcherCreator } from './fs/watch';
import { broadcastToWindows } from '../lib/broadcast';
import { makeWcGoneHook } from '../lib/wc-gone-hook';
import { showOpenDialogRemembering } from '../lib/open-dialog';

// ────────────────────────────────────────────────────────────
// schemas — 全部 .strict() 拒绝未知字段(防 IPC 注入)
// ────────────────────────────────────────────────────────────

// 边界(E21,E13 同族):fs IPC 此前只 cap 了 content,path/newName/name/dir/src/dest 及 listDir
// exclude 无长度/数量上限。畸形 renderer/preload 调用可传超长路径或巨大 exclude 列表,在 IPC/zod/
// exclude 扫描路径消耗内存+CPU(listDir 还对每个目录项 O(N) exclude.includes)。统一加 PATH/NAME
// 上限 + exclude 数组上限;listDir 内把 exclude 转 Set 避免大目录线性放大(见 fs/list-dir.ts)。
// FS_PATH_MAX 取 shared 单一来源(preload / plugin-fs 同值)。下面这个是 IPC schema 对「名字类字符串」
// (新建名 / exclude 项)的宽松长度闸,不是文件系统组件名上限(那是 shared/leaf-name 的 FS_NAME_MAX=255)。
const FS_IPC_NAME_MAX = 1024;
const FS_EXCLUDE_MAX = 1000;
const fsPath = (): z.ZodString => z.string().min(1).max(FS_PATH_MAX);
const fsName = (): z.ZodString => z.string().min(1).max(FS_IPC_NAME_MAX);

const ListDirOptionsSchema = z
  .object({
    maxDepth: z.number().int().positive().optional(),
    exclude: z.array(z.string().max(FS_IPC_NAME_MAX)).max(FS_EXCLUDE_MAX).optional(), // 边界(E21)
    // perf P2:文件数上限(深递归早停)。见 fs/list-dir.ts ListDirOptions.maxFiles。
    // 边界(E275):上界对齐到 MAX_TOTAL_ENTRIES 硬上限 + 安全整数 —— 此前只 positive int,畸形 IPC 可传
    // 1e308(仍过 z.int())绕过调用方早停,迫使主进程遍历/排序/回传近 10 万条放大。超上限直接 BAD_INPUT。
    maxFiles: z.number().int().positive().max(MAX_TOTAL_ENTRIES).optional(),
    // 性能:false 时不 lstat、不回传 size/mtime/ctime(Quick Open 用)。见 ListDirOptions.withStats。
    withStats: z.boolean().optional(),
  })
  .strict();

export const listDirInputSchema = z
  .object({
    path: fsPath(),
    options: ListDirOptionsSchema.optional(),
  })
  .strict();

export const readFileInputSchema = z.object({ path: fsPath() }).strict();

export const statInputSchema = z.object({ path: fsPath() }).strict();

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


export const createFileInputSchema = z
  .object({ dir: fsPath(), name: fsName() })
  .strict();

export const createDirInputSchema = z
  .object({ parent: fsPath(), name: fsName() })
  .strict();

export const trashInputSchema = z.object({ path: fsPath() }).strict();

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

// 类型导出(给 preload / renderer 用)
export type ListDirInput = z.infer<typeof listDirInputSchema>;
export type ReadFileInput = z.infer<typeof readFileInputSchema>;
export type StatInput = z.infer<typeof statInputSchema>;
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
// fs:read-file 是编辑器打开 / 外部同步 / 会话恢复 / 保存前比对的文本读取入口 → requireUtf8:非法 UTF-8
// 拒绝(FS_NOT_UTF8),防 U+FFFD 替换后保存写回损坏原文件(独立审计)。插件 fs readFile 不经此处。
// leaf 为 symlink 时随结果带 realPath(见 FsReadFileData):与保存写穿复用 resolveSymlinkTarget;解析失败 /
// 断链(返回原路径)/ 超长 → 不带,不影响读取结果。
export const readFileHandler = async (input: ReadFileInput): Promise<FsReadFileData> => {
  const content = await readFile(input.path, { requireUtf8: true });
  const target = await resolveSymlinkTarget(input.path).catch(() => input.path);
  return target !== input.path && target.length <= FS_PATH_MAX
    ? { content, realPath: target }
    : { content };
};
// 性能:返回写入内容的 { mtimeMs, size, ino }(无法确认 → undefined),编辑器据此识别自己保存的 dir-changed 回声,
// 免一次整文件 readFile(见 FsFileStat / useExternalFileSync)。
export const writeFileHandler = (input: WriteFileInput): Promise<FsFileStat | undefined> =>
  atomicWriteFile(input.path, input.content);
// 安全:注册到 fs:read-file / fs:write-file 的是这两个包装 —— 路径是插件经 editor.openFile 打开过的标签时,
// 读 / 写前在 plugin-fs 锁内确认路径没有被换入链接(见 guardPluginOpenedPath);其它路径原样直通。
export const guardedReadFileHandler = (input: ReadFileInput): Promise<FsReadFileData> =>
  guardPluginOpenedPath(input.path, () => readFileHandler(input));
export const guardedWriteFileHandler = (input: WriteFileInput): Promise<FsFileStat | undefined> =>
  guardPluginOpenedPath(input.path, () => writeFileHandler(input));
// writeBinary 契约仍为 void(Dropzone 不需要回声识别),不把 stat 带过 IPC。
// 安全:唯一调用方是外部文件拖入 Explorer(新建 / 放入语义,同名静默覆盖)。不复用编辑器保存的
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
    await deps.trashItem(input.path);
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
  const rel = String(filename);
  const slashIdx = lastRelativePathSeparatorIndex(rel);
  const subdir = slashIdx >= 0 ? normalizeRelativeSubdir(rel, slashIdx) : '';
  return subdir ? pathMod.join(rootPath, subdir) : rootPath;
}

/**
 * watcher 回调 filename 的末段名(变更项在 changedPath 目录内的名字,分隔符 `/` `\` 都认)。
 * 末段为空 → undefined(视为未知文件,下游退化为目录级)。
 */
export function resolveWatchChangedFileName(filename: string): string | undefined {
  const rel = String(filename);
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
        // 不带文件名 → 下游按目录级处理
        onChange(rootPath);
        return;
      }
      // 带上变更项名字(rename 的旧名/新名各回调一次),renderer 外部同步只重读命中的 clean tab
      const rel = String(filename);
      // eventType 一并上抛,合并器据此判定「仅内容变化」(changeOnly,见 FsDirChangedPayload)
      onChange(resolveWatchChangedPath(rootPath, rel), resolveWatchChangedFileName(rel), eventType);
    },
  );
  watcher.on('error', (err) => {
    console.warn('[fs] watcher error, closing:', rootPath, err);
    onError(err);
  });
  return { close: () => watcher.close() };
};

// 导出仅供回归测试。watcher 失效被驱逐后持有者 renderer 仍以为已安装 → 推 WATCH_LOST 让其重装;
// 单窗口 send 抛错不中断其余窗口(同 broadcastToWindows)。
export function notifyWatchLost(path: string, ownerIds: readonly number[]): void {
  for (const id of ownerIds) {
    const win = BrowserWindow.fromId(id);
    if (!win || win.isDestroyed()) continue;
    try {
      win.webContents.send(FS_CHANNELS.WATCH_LOST, { path });
    } catch (err) {
      console.error('[fs] WATCH_LOST send failed', err);
    }
  }
}

const watcherPool = createWatcherPool(createFsWatcher, notifyWatchLost);

// watch 引用按 BrowserWindow id 记账,但 renderer reload(webContents 与窗口都不变)时旧文档不会
// unwatch,新文档又重新 watch 已展开目录 → 旧引用永不释放(折叠后 fs.watch 关不掉、持续广播、占 LRU
// 名额)。主框架非同文档导航即释放该窗口全部引用,与关窗 releaseFsWatchersForWindow 同一路径;
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
  safeHandle(FS_CHANNELS.READ_FILE, readFileInputSchema, guardedReadFileHandler);
  safeHandle(FS_CHANNELS.STAT, statInputSchema, statHandler);
  safeHandle(FS_CHANNELS.WRITE_FILE, writeFileInputSchema, guardedWriteFileHandler);
  safeHandle(FS_CHANNELS.WRITE_BINARY, writeBinaryInputSchema, writeBinaryHandler);
  safeHandle(FS_CHANNELS.RENAME, renameInputSchema, renameHandler);
  safeHandle(FS_CHANNELS.CREATE_FILE, createFileInputSchema, createFileHandler);
  safeHandle(FS_CHANNELS.CREATE_DIR, createDirInputSchema, createDirHandler);

  safeHandle(
    FS_CHANNELS.TRASH,
    trashInputSchema,
    makeTrashHandler({
      // shell.trashItem 在 Electron 38 是 Promise<void>
      trashItem: (p) => shell.trashItem(p),
    }),
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

  // ── fs.watch 增量更新(Step 6) ──────────────────────────────
  // ctx-aware:记录发起 watch 的窗口 id,供窗口硬关闭时 releaseFsWatchersForWindow
  // 批量释放(React unmount cleanup 在硬关窗/崩溃时不保证执行,审计 P2)。
  safeHandleWithCtx(
    FS_CHANNELS.WATCH,
    watchInputSchema,
    (input, { event }) => {
      const ownerId = BrowserWindow.fromWebContents(event.sender)?.id;
      if (ownerId !== undefined) {
        watchOwnerByWc.set(event.sender.id, ownerId);
        attachWatchWcGoneHook(event.sender);
      }
      // 广播 creator 上抛的真实变更路径(可能 = input.path,也可能是其
      // recursive 子目录,见 issue #20)。
      watcherPool.watch(
        input.path,
        queueDirChangedBroadcast,
        ownerId,
      );
    },
  );

  safeHandleWithCtx(
    FS_CHANNELS.UNWATCH,
    unwatchInputSchema,
    (input, { event }) => {
      const ownerId = BrowserWindow.fromWebContents(event.sender)?.id;
      watcherPool.unwatch(input.path, ownerId);
    },
  );
}

/** 窗口关闭时释放该窗口持有的全部 fs watcher 引用(审计 P2 资源泄漏)。 */
export function releaseFsWatchersForWindow(windowId: number): void {
  watcherPool.unwatchByOwner(windowId);
}
