import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult } from '../shared/ipc-result';
import type { FileEntry } from '../shared/fs-entry';
import { FS_CHANNELS } from '../shared/fs-channels';

// 给 fs 入参用的轻量 ListDirOptions —— 与 main 端 zod schema 对齐字段
interface PreloadListDirOptions {
  readonly maxDepth?: number;
  readonly exclude?: ReadonlyArray<string>;
  readonly followSymlinks?: boolean;
}

// 所有跨 IPC 的方法都返回 IpcResult<T>(详见 ADR-010),
// renderer 拿到后按 ok 分流,不再 throw。
const api = {
  ping: () => 'pong' as const,
  layout: {
    read: (): Promise<IpcResult<unknown | null>> =>
      ipcRenderer.invoke('layout:read'),
    write: (json: unknown): Promise<IpcResult<void>> =>
      ipcRenderer.invoke('layout:write', json),
  },
  popout: {
    open: (panelId: string): Promise<IpcResult<unknown>> =>
      ipcRenderer.invoke('popout:open', { panelId }),
    onClosed: (cb: (panelId: string) => void): (() => void) => {
      const listener = (_: unknown, panelId: string) => cb(panelId);
      ipcRenderer.on('popout:closed', listener);
      return () => ipcRenderer.off('popout:closed', listener);
    },
  },
  fs: {
    listDir: (
      path: string,
      options?: PreloadListDirOptions,
    ): Promise<IpcResult<ReadonlyArray<FileEntry>>> =>
      ipcRenderer.invoke(FS_CHANNELS.LIST_DIR, { path, options }),
    readFile: (path: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(FS_CHANNELS.READ_FILE, { path }),
    writeFile: (path: string, content: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.WRITE_FILE, { path, content }),
    rename: (path: string, newName: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(FS_CHANNELS.RENAME, { path, newName }),
    remove: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.REMOVE, { path }),
    createFile: (dir: string, name: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(FS_CHANNELS.CREATE_FILE, { dir, name }),
    createDir: (parent: string, name: string): Promise<IpcResult<string>> =>
      ipcRenderer.invoke(FS_CHANNELS.CREATE_DIR, { parent, name }),
    trash: (path: string): Promise<IpcResult<void>> =>
      ipcRenderer.invoke(FS_CHANNELS.TRASH, { path }),
    selectDirectory: (): Promise<IpcResult<string | null>> =>
      ipcRenderer.invoke(FS_CHANNELS.SELECT_DIRECTORY),
  },
} as const;

export type LayoutMotionApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
