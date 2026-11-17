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

interface PluginDirMeta {
  readonly id: string;
  readonly manifestText: string;
  /** 列举时 manifest 的版本令牌,拉 main 时回传给 main 端校验(manifest 未变才给源码). */
  readonly manifestHash: string;
}

type PluginDirInfo = {
  readonly id: string;
  readonly manifestText: string;
  readonly moduleUrl: string;
};

const EMPTY_PLUGIN_DIR_INFOS: PluginDirInfo[] = [];

/**
 * moduleUrl 惰性生成:只在真正读取(激活该插件时 import)才 createObjectURL,且只生成一次。
 * 此前列举为每条都 createObjectURL 且从不 revoke → 反复 reload 单调泄漏 Blob URL。未读的 info 随 GC 回收。
 * (getter 须直接定义在返回对象上 —— 对象展开会立即求值 getter。)用于 readDirById(热重载)结果。
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

/**
 * 列举项的 moduleUrl 是惰性**源码引用**(不是可 import 的 URL):listDirs 不再携带 main 源码(perf:未启用
 * 插件的源码不读、不经 IPC 传给每个窗口),importModule 遇到引用时才按**目录名**拉源码 → Blob URL。
 * 每个引用记住生成过的 Blob URL:禁用后重新启用同一 dir info 时复用同一 URL → 命中 module map 缓存、不再拉
 * 源码(与旧版 getter 只生成一次 Blob URL 等价)。拉取失败不记,下次激活重试。
 */
const MAIN_REF_PREFIX = 'continuo-plugin-main:';
const mainRefs = new Map<
  string,
  { readonly dir: string; readonly manifestHash: string; blobUrl: string | null }
>();
let nextMainRef = 1;

function deferredPluginDirInfo(dir: PluginDirMeta): PluginDirInfo {
  let ref: string | null = null;
  return {
    id: dir.id,
    manifestText: dir.manifestText,
    get moduleUrl(): string {
      if (ref === null) {
        ref = `${MAIN_REF_PREFIX}${nextMainRef++}`;
        mainRefs.set(ref, { dir: dir.id, manifestHash: dir.manifestHash, blobUrl: null });
      }
      return ref;
    },
  };
}

export function buildPluginDirInfos(dirs: readonly PluginDirMeta[]): PluginDirInfo[] {
  if (dirs.length === 0) return EMPTY_PLUGIN_DIR_INFOS;
  const out = new Array<PluginDirInfo>(dirs.length);
  for (let i = 0; i < dirs.length; i++) {
    out[i] = deferredPluginDirInfo(dirs[i]!);
  }
  return out;
}

/** 源码引用 → 可 import 的 Blob URL(首次按目录名拉源码);非引用原样返回。 */
async function resolveModuleUrl(url: string): Promise<string> {
  const ref = mainRefs.get(url);
  if (ref === undefined) return url;
  if (ref.blobUrl !== null) return ref.blobUrl;
  // 带列举快照的 manifest 令牌:期间插件被更新 → main 端拒绝(PLUGIN_MANIFEST_CHANGED)→ 激活失败,
  // 不以旧 manifest(id / 权限 / 入口)执行新 main;watcher 检测到 manifest 变化后广播热重载。
  const r = await coApi.plugins.readMainByDir(ref.dir, ref.manifestHash);
  if (!r.ok) throw codedError(r.code, r.message ?? 'readMainByDir failed');
  if (r.data === null) throw new Error(`plugin main is unavailable: ${ref.dir}`);
  ref.blobUrl = URL.createObjectURL(new Blob([r.data], { type: 'application/javascript' }));
  return ref.blobUrl;
}

export function createWindowApiHost(): ManagerHost {
  return {
    listPluginDirs: async () => {
      const r = await coApi.plugins.listDirs();
      if (!r.ok) {
        console.warn('[plugins-host] listDirs failed', r.code, r.message);
        return EMPTY_PLUGIN_DIR_INFOS;
      }
      // moduleUrl 为惰性源码引用,激活时 importModule 才按目录拉源码并转 Blob URL(import 完成后即 revoke)。
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
      const target = await resolveModuleUrl(url);
      try {
        return await import(/* @vite-ignore */ target);
      } finally {
        // import 结束(成功或失败)即 revoke:已求值模块留在 module map(按 URL 缓存),同 URL 再
        // import(禁用后重新启用)命中缓存、不再 fetch,不依赖 blob 存活;失败的 URL 也不会再被用到。
        if (target.startsWith('blob:')) URL.revokeObjectURL(target);
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
