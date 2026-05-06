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
  SELECT_DIRECTORY: 'fs:select-directory',
  WATCH: 'fs:watch',
  UNWATCH: 'fs:unwatch',
  /** main → renderer event(非 invoke),webContents.send(path) 通知目录变更 */
  DIR_CHANGED: 'fs:dir-changed',
} as const;

export type FsChannel = (typeof FS_CHANNELS)[keyof typeof FS_CHANNELS];
