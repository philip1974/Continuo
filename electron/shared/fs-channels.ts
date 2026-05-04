// 全部 fs.* IPC 通道字符串集中地。main / preload 两侧 import 同一份,
// 防字符串散漂改名错位。layout / popout 通道下个里程碑(P1.D2)统一处理。

export const FS_CHANNELS = {
  LIST_DIR: 'fs:list-dir',
  READ_FILE: 'fs:read-file',
  WRITE_FILE: 'fs:write-file',
  RENAME: 'fs:rename',
  REMOVE: 'fs:remove',
  CREATE_FILE: 'fs:create-file',
  CREATE_DIR: 'fs:create-dir',
  TRASH: 'fs:trash',
  SELECT_DIRECTORY: 'fs:select-directory',
} as const;

export type FsChannel = (typeof FS_CHANNELS)[keyof typeof FS_CHANNELS];
