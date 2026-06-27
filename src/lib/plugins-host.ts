// renderer 端 ManagerHost 实现(M-Plugin v4.1)。
// 把 coApi.plugins.* IPC 包成 PluginManager 期望的 ManagerHost 形态。
//
// main.js 文本 → Blob URL → dynamic import,绕过 file:// 跨进程加载限制。

import type { ManagerHost } from '@/plugins/PluginManager';
import { coApi } from './co-api';

interface RawPluginDirInfo {
  readonly id: string;
  readonly manifestText: string;
  readonly mainText: string;
  readonly stylesText?: string;
}

type PluginDirInfo = {
  readonly id: string;
  readonly manifestText: string;
  readonly moduleUrl: string;
  readonly stylesText?: string;
};

const EMPTY_PLUGIN_DIR_INFOS: PluginDirInfo[] = [];

export function buildPluginDirInfos(
  dirs: readonly RawPluginDirInfo[],
): PluginDirInfo[] {
  if (dirs.length === 0) return EMPTY_PLUGIN_DIR_INFOS;
  const out = new Array<PluginDirInfo>(dirs.length);
  for (let i = 0; i < dirs.length; i++) {
    const dir = dirs[i]!;
    const blob = new Blob([dir.mainText], {
      type: 'application/javascript',
    });
    out[i] = {
      id: dir.id,
      manifestText: dir.manifestText,
      moduleUrl: URL.createObjectURL(blob),
      stylesText: dir.stylesText,
    };
  }
  return out;
}

export function createWindowApiHost(): ManagerHost {
  return {
    listPluginDirs: async () => {
      const r = await coApi.plugins.listDirs();
      if (!r.ok) {
        console.warn('[plugins-host] listDirs failed', r.code, r.message);
        return EMPTY_PLUGIN_DIR_INFOS;
      }
      // 用 Blob URL 让 dynamic import 能拿到外部文件内容。
      // 注意:URL.revokeObjectURL 不在此调,等 plugin _deactivate 后由
      // 浏览器 GC(主流程是 LM 整个生命周期持有 plugin instance)。
      return buildPluginDirInfos(r.data);
    },
    readEnabledIds: async () => {
      const r = await coApi.plugins.readEnabled();
      if (!r.ok) {
        // 数据安全:读失败必须**传播**(不再降级成空 Set)—— 否则 mutateEnabledIds 的 RMW
        // 会基于空集合写回,抹掉其它已启用插件(codex)。调用方各自决定:init 降级、
        // mutate 中止写。(main readEnabledIds 仅 ENOENT 返回 [],EACCES/EIO 才 fail。)
        throw Object.assign(new Error(r.message ?? 'readEnabled failed'), {
          code: r.code,
        });
      }
      return new Set(r.data);
    },
    mutateEnabledId: async (id, enabled) => {
      // 数据安全:启用/禁用走 main 端 delta 串行写(MUTATE_ENABLED),read-modify-write
      // 在主进程单条链内原子完成 → 跨窗口无 lost update(renderer 不再整表 RMW)。
      const r = await coApi.plugins.mutateEnabled(id, enabled);
      if (!r.ok) {
        // 持久化失败必须**传播**(不只 warn):否则 enable/disable 静默 resolve,用户以为
        // 已切换但 _enabled.json 没写成,重启回滚。盘未被改动(写失败=盘不变),重启 init
        // 从盘对账回操作前状态;in-session 内存短暂偏离 → 调用方据此 reject 让失败可见。
        throw Object.assign(new Error(r.message ?? 'mutateEnabled failed'), {
          code: r.code,
        });
      }
    },
    importModule: (url) => import(/* @vite-ignore */ url),
    removePluginDir: async (id) => {
      const r = await coApi.plugins.uninstall(id);
      if (!r.ok) {
        throw Object.assign(new Error(r.message), { code: r.code });
      }
    },
  };
}
