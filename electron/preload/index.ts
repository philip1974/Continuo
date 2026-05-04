import { contextBridge, ipcRenderer } from 'electron';
import type { IpcResult } from '../shared/ipc-result';

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
} as const;

export type LayoutMotionApi = typeof api;

contextBridge.exposeInMainWorld('api', api);
