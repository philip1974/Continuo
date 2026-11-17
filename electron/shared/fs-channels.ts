// 全部 fs.* IPC 通道字符串集中地。main / preload 两侧 import 同一份,
// 防字符串散漂改名错位。layout / popout 通道下个里程碑(P1.D2)统一处理。

import type { IpcFail, IpcOk, IpcResult } from './ipc-result';

export const FS_CHANNELS = {
  LIST_DIR: 'fs:list-dir',
  READ_FILE: 'fs:read-file',
  WRITE_FILE: 'fs:write-file',
  WRITE_BINARY: 'fs:write-binary',
  RENAME: 'fs:rename',
  REMOVE: 'fs:remove',
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
} as const;

export type FsChannel = (typeof FS_CHANNELS)[keyof typeof FS_CHANNELS];

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
}

/** DIR_CHANGED 单条 payload 携带文件名的数量上限;超限则不带集合,退化为目录级. */
export const DIR_CHANGED_FILES_MAX = 64;

/** fs:dir-changed payload 的 runtime 形态 + 长度守卫(空字符串是合法根/相对路径,故只限上限不限非空). */
export function isFsDirChangedPayload(
  v: unknown,
  maxPathLen: number,
): v is FsDirChangedPayload {
  if (v === null || typeof v !== 'object') return false;
  const p = (v as { path?: unknown }).path;
  return typeof p === 'string' && p.length <= maxPathLen;
}

/**
 * 取 payload 的可选 files:合规(数组、数量 ≤ maxCount、每项为长度 ≤ maxNameLen 的字符串)→ 原数组;
 * 缺省 / 畸形 / 超限 → undefined(退化为目录级,不丢整条事件,目录刷新照常)。
 */
export function readFsDirChangedFiles(
  v: FsDirChangedPayload,
  maxCount: number,
  maxNameLen: number,
): readonly string[] | undefined {
  const files: unknown = v.files;
  if (!Array.isArray(files) || files.length > maxCount) return undefined;
  for (const f of files) {
    if (typeof f !== 'string' || f.length > maxNameLen) return undefined;
  }
  return files as readonly string[];
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
