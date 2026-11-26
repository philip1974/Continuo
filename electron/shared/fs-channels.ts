// 全部 fs.* IPC 通道字符串集中地。main / preload 两侧 import 同一份,
// 防字符串散漂改名错位。(layout 通道在 persistence-channels.ts。)

import type { z } from 'zod';
import type { ListDirOptionsSchema } from './fs-list-dir-schema';

import { FS_PATH_MAX } from './fs-limits';
import { IPC_ERR, type IpcFail, type IpcOk, type IpcResult } from './ipc-result';

export const FS_CHANNELS = {
  LIST_DIR: 'fs:list-dir',
  READ_FILE: 'fs:read-file',
  /** 只读图片预览 / Markdown 图片:读为 data URL(格式白名单 + 50 MiB 上限;workspaceOnly 时限发送窗口工作区内). */
  READ_IMAGE: 'fs:read-image',
  /** 廉价 stat(跟随 symlink):{ mtimeMs, size, ino }。编辑器外部同步用它识别自己保存的回声. */
  STAT: 'fs:stat',
  WRITE_FILE: 'fs:write-file',
  WRITE_BINARY: 'fs:write-binary',
  RENAME: 'fs:rename',
  CREATE_FILE: 'fs:create-file',
  CREATE_DIR: 'fs:create-dir',
  TRASH: 'fs:trash',
  /** 在系统文件管理器(Finder/资源管理器)中显示并选中. */
  REVEAL: 'fs:reveal',
  /** 移动(rename 跨目录;跨盘 fallback cp+rm). */
  MOVE: 'fs:move',
  /** 递归复制(fs.cp recursive). */
  COPY: 'fs:copy',
  SELECT_DIRECTORY: 'fs:select-directory',
  WATCH: 'fs:watch',
  UNWATCH: 'fs:unwatch',
  /** main → renderer event(非 invoke),webContents.send(path) 通知目录变更 */
  DIR_CHANGED: 'fs:dir-changed',
  /** main → renderer event:watcher 异步失效被驱逐,payload 同 DIR_CHANGED({ path }),只推给持有者窗口 */
  WATCH_LOST: 'fs:watch-lost',
  /**
   * main → renderer event:某窗口的工作区根**自身**被改名 / 删除,或之后重新出现(payload 同 DIR_CHANGED 的
   * { path },不带文件名)。广播给所有窗口;订阅者复查该路径下全部打开的 tab(见 useExternalFileSync)。
   */
  ROOT_PRESENCE_CHANGED: 'fs:root-presence-changed',
} as const;

// 边界(E173,E168-E172 同族 IPC ingress 纵深防御):fs:dir-changed push payload 形态守卫。preload
// onDirChanged 此前直接 cb(payload.path),畸形 payload(null/非对象/path 非字符串/超长)→ listener
// 抛(null.path)或把非法 key 送进 Explorer watcher / external-file-sync。单一来源,preload 复用 + 单测。
export interface FsDirChangedPayload {
  readonly path: string;
  /**
   * 可选:本次该目录内变更项的名字(fs.watch 回调 filename 的末段,含 rename 的旧名/新名)。
   * 缺省 = 未知是哪些文件(平台不给 filename / Windows 缓冲溢出 / 超 DIR_CHANGED_FILES_MAX),
   * 订阅者须按「整个目录都可能变了」处理。仅 DIR_CHANGED 携带,WATCH_LOST 不带。
   */
  readonly files?: readonly string[];
  /**
   * 可选:true = 该目录本 tick 所有 watch 回调的 eventType 都是 'change'(仅内容 / 元数据变化,无新建 /
   * 删除 / 改名 → 目录列表不变)。缺省 = false(含 rename 或信息缺失,按列表可能变化处理)。
   * eventType 可靠性:inotify(IN_MODIFY/IN_ATTRIB)、ReadDirectoryChangesW(FILE_ACTION_MODIFIED)、
   * macOS FSEvents(libuv 仅在无 Created/Removed/Renamed 标志时报 change;标志在流内对同一路径会累积,
   * 只会把 change 误报成 rename,不会反过来)均只对非结构变化报 'change'。
   */
  readonly changeOnly?: boolean;
}

/** DIR_CHANGED 单条 payload 携带文件名的数量上限;超限则不带集合,退化为目录级. */
export const DIR_CHANGED_FILES_MAX = 64;

/** fs:dir-changed payload 的 runtime 形态 + 长度守卫(空字符串是合法根/相对路径,故只限上限不限非空). */
export function isFsDirChangedPayload(v: unknown): v is FsDirChangedPayload {
  if (v === null || typeof v !== 'object') return false;
  const p = (v as { path?: unknown }).path;
  return typeof p === 'string' && p.length <= FS_PATH_MAX;
}

/**
 * 取 payload 的可选 files:合规(数组、数量 ≤ maxCount、每项为长度 ≤ FS_PATH_MAX 的字符串)→ 原数组;
 * 缺省 / 畸形 / 超限 → undefined(退化为目录级,不丢整条事件,目录刷新照常)。
 */
export function readFsDirChangedFiles(
  v: FsDirChangedPayload,
  maxCount: number,
): readonly string[] | undefined {
  const files: unknown = v.files;
  if (!Array.isArray(files) || files.length > maxCount) return undefined;
  for (const f of files) {
    if (typeof f !== 'string' || f.length > FS_PATH_MAX) return undefined;
  }
  return files as readonly string[];
}

/** 取 payload 的可选 changeOnly:仅严格 true 才算(畸形 / 缺省 → false,按目录列表可能变化处理). */
export function readFsDirChangedChangeOnly(v: FsDirChangedPayload): boolean {
  return (v as { changeOnly?: unknown }).changeOnly === true;
}

/**
 * fs:read-file 主进程 handler 的 data。realPath:仅当 leaf 为符号链接时为其真实目标(与保存写穿
 * resolveSymlinkTarget 同一套解析);普通文件 / 断链 / 无法确认 → 缺省。编辑器外部同步据此按目标
 * 目录 / 文件名匹配(FSEvents/inotify 上报的是被实际修改的目录项名,即链接目标名)。
 */
export interface FsReadFileData {
  readonly content: string;
  readonly realPath?: string;
}

/** fs:read-image 的 data:dataUrl = `data:<mime>;base64,…`;size = 文件字节数. */
export interface FsReadImageData {
  readonly dataUrl: string;
  readonly size: number;
}

/** 渲染端 readFile 结果:data 仍为文件内容 string(既有调用方不变),成功时可选附 realPath. */
export type FsReadFileResult = (IpcOk<string> & { readonly realPath?: string }) | IpcFail;

/**
 * preload 把 handler 结果映射为 FsReadFileResult;realPath 非字符串 / 空 / 超 maxPathLen → 丢弃
 *(内容照常返回,外部同步退化为只按打开路径匹配)。
 */
export function toFsReadFileResult(
  r: IpcResult<FsReadFileData>,
  maxPathLen: number,
): FsReadFileResult {
  if (!r.ok) return r;
  const realPath: unknown = r.data.realPath;
  return typeof realPath === 'string' && realPath.length > 0 && realPath.length <= maxPathLen
    ? { ok: true, data: r.data.content, realPath }
    : { ok: true, data: r.data.content };
}

/**
 * 文件内容身份的廉价近似:mtimeMs + size + ino(跟随 symlink,即链接目标)。ino 区分粗粒度 mtime 文件系统上
 * 同大小的外部替换(原子写 / 另存为换了 inode,mtime 秒级可能相同)。fs:write-file 成功时返回写入后
 * 的值(无法确认则缺省),fs:stat 返回当前值;编辑器外部同步比对二者识别「自己保存的回声」,保存前冲突检测
 * 也比对它(仅高精度 mtime),相同才跳过整文件 readFile,不同 / 未知照旧读。粗粒度 mtime 上原地写入同大小内容
 * 区分不了。
 */
export interface FsFileStat {
  readonly mtimeMs: number;
  readonly size: number;
  /** inode 号(Windows 上可能超出安全整数,仅作相等比较). */
  readonly ino: number;
}

/**
 * fs:create-file / fs:create-dir 的结果:path = 新建的文件 / 目录;created = 本次新建的最上层项(名字带中间目录
 * `a/b/c.ts` 且其中有本次新建的目录时为最上层新建目录,否则 = path)。撤销新建删 created 即覆盖整条链,已存在的目录不动。
 */
export interface FsCreated {
  readonly path: string;
  readonly created: string;
}

/** 形态守卫:有限非负 mtimeMs + 非负安全整数 size + 有限非负 ino → 规范化副本(丢弃多余字段);否则 undefined. */
export function toFsFileStat(v: unknown): FsFileStat | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const { mtimeMs, size, ino } = v as { mtimeMs?: unknown; size?: unknown; ino?: unknown };
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) return undefined;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return undefined;
  if (typeof ino !== 'number' || !Number.isFinite(ino) || ino < 0) return undefined;
  return { mtimeMs, size, ino };
}

/** preload 映射 fs:write-file 结果:成功时 data = 合规 FsFileStat,畸形 / 缺省 → undefined(写盘结果不受影响). */
export function toFsWriteFileResult(r: IpcResult<unknown>): IpcResult<FsFileStat | undefined> {
  return r.ok ? { ok: true, data: toFsFileStat(r.data) } : r;
}

/** preload 映射 fs:stat 结果:成功但 data 畸形 → 失败(调用方按「stat 失败」处理,照旧整文件读). */
export function toFsStatResult(r: IpcResult<unknown>): IpcResult<FsFileStat> {
  if (!r.ok) return r;
  const st = toFsFileStat(r.data);
  return st
    ? { ok: true, data: st }
    : { ok: false, code: IPC_ERR.HANDLER_ERROR, message: 'malformed fs:stat result' };
}

/** fs:list-dir 选项:由 main 的 zod schema 推出(单一来源,见 fs-list-dir-schema.ts)。 */
export type FsListDirOptions = z.infer<typeof ListDirOptionsSchema>;
