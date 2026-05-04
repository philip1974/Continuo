// renderer 端 ManagerHost 实现(M-Plugin v4.1)。
// 把 window.api.plugins.* IPC 包成 PluginManager 期望的 ManagerHost 形态。
//
// main.js 文本 → Blob URL → dynamic import,绕过 file:// 跨进程加载限制。

import type { ManagerHost } from '@/plugins/PluginManager';

export function createWindowApiHost(): ManagerHost {
  return {
    listPluginDirs: async () => {
      const r = await window.api.plugins.listDirs();
      if (!r.ok) {
        console.warn('[plugins-host] listDirs failed', r.code, r.message);
        return [];
      }
      // 用 Blob URL 让 dynamic import 能拿到外部文件内容。
      // 注意:URL.revokeObjectURL 不在此调,等 plugin _deactivate 后由
      // 浏览器 GC(主流程是 LM 整个生命周期持有 plugin instance)。
      return r.data.map((dir) => {
        const blob = new Blob([dir.mainText], {
          type: 'application/javascript',
        });
        return {
          id: dir.id,
          manifestText: dir.manifestText,
          moduleUrl: URL.createObjectURL(blob),
          stylesText: dir.stylesText,
        };
      });
    },
    readEnabledIds: async () => {
      const r = await window.api.plugins.readEnabled();
      if (!r.ok) {
        console.warn('[plugins-host] readEnabled failed', r.code, r.message);
        return new Set<string>();
      }
      return new Set(r.data);
    },
    writeEnabledIds: async (ids) => {
      const r = await window.api.plugins.writeEnabled(ids);
      if (!r.ok) {
        console.warn('[plugins-host] writeEnabled failed', r.code, r.message);
      }
    },
    importModule: (url) => import(/* @vite-ignore */ url),
  };
}
