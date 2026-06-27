// 全部 fs.* IPC 通道字符串集中地。main / preload 两侧 import 同一份,
// 防字符串散漂改名错位。layout / popout 通道下个里程碑(P1.D2)统一处理。

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
} as const;

export type FsChannel = (typeof FS_CHANNELS)[keyof typeof FS_CHANNELS];

// 边界(E173,E168-E172 同族 IPC ingress 纵深防御):fs:dir-changed push payload 形态守卫。preload
// onDirChanged 此前直接 cb(payload.path),畸形 payload(null/非对象/path 非字符串/超长)→ listener
// 抛(null.path)或把非法 key 送进 Explorer watcher / external-file-sync。单一来源,preload 复用 + 单测。
export interface FsDirChangedPayload {
  readonly path: string;
}

/** fs:dir-changed payload 的 runtime 形态 + 长度守卫(空字符串是合法根/相对路径,故只限上限不限非空). */
export function isFsDirChangedPayload(
  v: unknown,
  maxPathLen: number,
): v is FsDirChangedPayload {
  if (v === null || typeof v !== 'object') return false;
  const p = (v as { path?: unknown }).path;
  return typeof p === 'string' && p.length <= maxPathLen;
}
