// renderer 端 ManagerHost 实现(M-Plugin v4.1)。
// 把 coApi.plugins.* IPC 包成 PluginManager 期望的 ManagerHost 形态。
//
// main.js 文本 → Blob URL → dynamic import,绕过 file:// 跨进程加载限制。

import type { ManagerHost } from '@/plugins/PluginManager';
import { coApi } from './co-api';
import { codedError } from '../../electron/shared/error-message';

interface RawPluginDirInfo {
  readonly id: string;
  readonly manifestText: string;
  readonly mainText: string;
}

type PluginDirInfo = {
  readonly id: string;
  readonly manifestText: string;
  readonly moduleUrl: string;
};

const EMPTY_PLUGIN_DIR_INFOS: PluginDirInfo[] = [];

export function buildPluginDirInfos(
  dirs: readonly RawPluginDirInfo[],
): PluginDirInfo[] {
  if (dirs.length === 0) return EMPTY_PLUGIN_DIR_INFOS;
  const out = new Array<PluginDirInfo>(dirs.length);
  for (let i = 0; i < dirs.length; i++) {
    out[i] = lazyPluginDirInfo(dirs[i]!);
  }
  return out;
}

/**
 * moduleUrl 惰性生成:只在真正读取(激活该插件时 import)才 createObjectURL,且只生成一次。
 * 每次 listPluginDirs(init / 每次 reload)都为全部插件构造 dir info,而 reload 只用目标插件那条;
 * 此前为每条都 createObjectURL 且从不 revoke → 反复 reload 单调泄漏 Blob URL。未读的 info 随 GC 回收。
 * (getter 须直接定义在返回对象上 —— 对象展开会立即求值 getter。)
 */
function lazyPluginDirInfo(dir: RawPluginDirInfo): PluginDirInfo {
  let url: string | null = null;
  return {
    id: dir.id,
    manifestText: dir.manifestText,
    get moduleUrl(): string {
      url ??= URL.createObjectURL(
        new Blob([dir.mainText], { type: 'application/javascript' }),
      );
      return url;
    },
  };
}

export function createWindowApiHost(): ManagerHost {
  return {
    listPluginDirs: async () => {
      const r = await coApi.plugins.listDirs();
      if (!r.ok) {
        console.warn('[plugins-host] listDirs failed', r.code, r.message);
        return EMPTY_PLUGIN_DIR_INFOS;
      }
      // 用 Blob URL 让 dynamic import 能拿到外部文件内容(惰性生成,import 完成后即 revoke,见 importModule)。
      return buildPluginDirInfos(r.data);
    },
    readPluginDirByManifestId: async (id) => {
      // perf:热重载只读目标插件(main 端选择规则与 findPluginDirByManifestId(listDirs) 等价)。
      // 失败与旧 listDirs 失败同降级:当作找不到(reload 抛 no longer exists)。
      const r = await coApi.plugins.readDirById(id);
      if (!r.ok) {
        console.warn('[plugins-host] readDirById failed', r.code, r.message);
        return null;
      }
      return r.data ? lazyPluginDirInfo(r.data) : null;
    },
    readEnabledIds: async () => {
      const r = await coApi.plugins.readEnabled();
      if (!r.ok) {
        // 数据安全:读失败必须**传播**(不再降级成空 Set)—— 否则 mutateEnabledIds 的 RMW
        // 会基于空集合写回,抹掉其它已启用插件(codex)。调用方各自决定:init 降级、
        // mutate 中止写。(main readEnabledIds 仅 ENOENT 返回 [],EACCES/EIO 才 fail。)
        throw codedError(r.code, r.message ?? 'readEnabled failed');
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
        throw codedError(r.code, r.message ?? 'mutateEnabled failed');
      }
    },
    importModule: async (url) => {
      try {
        return await import(/* @vite-ignore */ url);
      } finally {
        // import 结束(成功或失败)即 revoke:已求值模块留在 module map(按 URL 缓存),同 URL 再
        // import(禁用后重新启用)命中缓存、不再 fetch,不依赖 blob 存活;失败的 URL 也不会再被用到。
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      }
    },
    removePluginDir: async (id) => {
      const r = await coApi.plugins.uninstall(id);
      if (!r.ok) {
        throw codedError(r.code, r.message);
      }
    },
    killPluginShellProcesses: async (id) => {
      const r = await coApi.shell.killPluginProcesses(id);
      if (!r.ok) {
        throw codedError(r.code, r.message);
      }
    },
  };
}
