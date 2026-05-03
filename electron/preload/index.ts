import { contextBridge, ipcRenderer } from 'electron';

const api = {
  ping: () => 'pong' as const,
  layout: {
    read: (): Promise<unknown | null> => ipcRenderer.invoke('layout:read'),
    write: (json: unknown): Promise<boolean> => ipcRenderer.invoke('layout:write', json),
  },
  popout: {
    open: (panelId: string): Promise<{ ok: boolean }> =>
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
