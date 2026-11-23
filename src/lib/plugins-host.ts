// renderer 端 ManagerHost 实现(M-Plugin v4.1)。
// 把 coApi.plugins.* IPC 包成 PluginManager 期望的 ManagerHost 形态。
//
// main.js 文本 → Blob URL → dynamic import,绕过 file:// 跨进程加载限制。

import type { ManagerHost } from '@/plugins/PluginManager';
import { coApi } from './co-api';
import { codedError } from '../../electron/shared/error-message';

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
 * 列举项的 moduleUrl 是惰性**源码引用**(不是可 import 的 URL):listDirs 不再携带 main 源码(perf:未启用
 * 插件的源码不读、不经 IPC 传给每个窗口),importModule 遇到引用时才按**目录名**拉源码 → Blob URL。
 * 每个引用记住生成过的 Blob URL:禁用后重新启用同一 dir info 时复用同一 URL → 命中 module map 缓存、不再拉
 * 源码(与旧版 getter 只生成一次 Blob URL 等价)。拉取失败不记,下次激活重试。
 *
 * perf(启动预取):PluginManager.init 在串行激活前对已启用插件调 prefetchModule —— 只拉源码生成 Blob URL,
 * 不 import、不执行插件代码。同一引用的拉取单飞(loading),激活时命中预取结果或加入在途拉取。
 * 令牌:引用与列举快照的 (目录, manifestHash) 一一绑定且不可变,预取与激活都以该令牌向 main 校验 —— 预取结果
 * 只挂在它自己的引用上,天然只会被同一令牌(即 entry.manifest 所出自的 manifest)的激活复用。热重载 / 重新列举
 * 换了 dirInfo → 新引用(新令牌)拉不到旧结果、重新拉取;旧引用未被 import 的预取结果由 releasePrefetchedModule
 * 丢弃(revoke)。
 */
const MAIN_REF_PREFIX = 'continuo-plugin-main:';
interface MainRef {
  readonly dir: string;
  readonly manifestHash: string;
  blobUrl: string | null;
  /** 在途拉取(预取或激活共享);结束即清。 */
  loading: Promise<string> | null;
  /** 已交给 import(此后 Blob URL 由 importModule 的 finally revoke,release 不再碰)。 */
  imported: boolean;
  /** release 代际:在途拉取完成时代际已变 → 结果作废并 revoke(不写回)。 */
  gen: number;
}
const mainRefs = new Map<string, MainRef>();
let nextMainRef = 1;
// 引用的寿命跟随它的 dirInfo:热重载每次换一个新 dirInfo(新引用),旧的不再被任何 entry 持有 → 回收后摘除
// 表项,否则 watcher 频繁触发的重载会让 mainRefs 单调增长。表项只含字符串,不反向持有 dirInfo。
// 回收时按 releasePrefetchedSource 同样处置未被 import 的预取结果(revoke Blob URL;在途拉取经代际作废):
// 预取方只存 URL 字符串、不持有 dirInfo,dirInfo 可能先于它的 release 被回收。
const mainRefCleanup = new FinalizationRegistry<string>((ref) => {
  releasePrefetchedSource(ref);
  mainRefs.delete(ref);
});

function deferredPluginDirInfo(dir: PluginDirMeta): PluginDirInfo {
  let ref: string | null = null;
  const info: PluginDirInfo = {
    id: dir.id,
    manifestText: dir.manifestText,
    get moduleUrl(): string {
      if (ref === null) {
        ref = `${MAIN_REF_PREFIX}${nextMainRef++}`;
        mainRefs.set(ref, {
          dir: dir.id,
          manifestHash: dir.manifestHash,
          blobUrl: null,
          loading: null,
          imported: false,
          gen: 0,
        });
        mainRefCleanup.register(info, ref);
      }
      return ref;
    },
  };
  return info;
}

export function buildPluginDirInfos(dirs: readonly PluginDirMeta[]): PluginDirInfo[] {
  if (dirs.length === 0) return EMPTY_PLUGIN_DIR_INFOS;
  const out = new Array<PluginDirInfo>(dirs.length);
  for (let i = 0; i < dirs.length; i++) {
    out[i] = deferredPluginDirInfo(dirs[i]!);
  }
  return out;
}

/** 按引用拉源码 → Blob URL(单飞)。失败不缓存;完成时已被 release(代际变)→ revoke 并作废。 */
function loadMainBlobUrl(ref: MainRef): Promise<string> {
  if (ref.loading !== null) return ref.loading;
  const gen = ref.gen;
  const p = (async () => {
    // 带列举快照的 manifest 令牌:期间插件被更新 → main 端拒绝(PLUGIN_MANIFEST_CHANGED)→ 激活失败,
    // 不以旧 manifest(id / 权限 / 入口)执行新 main;watcher 检测到 manifest 变化后广播热重载。
    const r = await coApi.plugins.readMainByDir(ref.dir, ref.manifestHash);
    if (!r.ok) throw codedError(r.code, r.message);
    if (r.data === null) throw new Error(`plugin main is unavailable: ${ref.dir}`);
    const url = URL.createObjectURL(new Blob([r.data], { type: 'application/javascript' }));
    if (ref.gen !== gen) {
      URL.revokeObjectURL(url);
      throw new Error(`plugin main prefetch discarded: ${ref.dir}`);
    }
    ref.blobUrl = url;
    return url;
  })().finally(() => {
    if (ref.loading === p) ref.loading = null;
  });
  ref.loading = p;
  return p;
}

/** 源码引用 → 可 import 的 Blob URL(命中预取 / 加入在途拉取 / 首次按目录名拉源码);非引用原样返回。 */
async function resolveModuleUrl(url: string): Promise<string> {
  const ref = mainRefs.get(url);
  if (ref === undefined) return url;
  let target = ref.blobUrl;
  if (target === null) {
    const joined = ref.loading !== null;
    try {
      target = await loadMainBlobUrl(ref);
    } catch (err) {
      // 加入的是预取的在途拉取且它失败 → 预取失败不算数,照原路径重拉一次;自己发起的拉取失败照旧抛。
      if (!joined) throw err;
      target = await loadMainBlobUrl(ref);
    }
  }
  ref.imported = true;
  return target;
}

/** 预取源码(不 import、不执行插件代码);失败吞掉不缓存,激活时照常拉取。 */
async function prefetchMainSource(url: string): Promise<void> {
  const ref = mainRefs.get(url);
  if (ref === undefined || ref.blobUrl !== null) return;
  try {
    await loadMainBlobUrl(ref);
  } catch {
    // 预取失败不缓存:激活时 resolveModuleUrl 照原路径拉取并报错。
  }
}

/** 丢弃未被 import 的预取结果:revoke Blob URL;在途拉取完成时作废并 revoke。已 import 的不动。 */
function releasePrefetchedSource(url: string): void {
  const ref = mainRefs.get(url);
  if (ref === undefined || ref.imported) return;
  ref.gen++;
  if (ref.blobUrl !== null) {
    URL.revokeObjectURL(ref.blobUrl);
    ref.blobUrl = null;
  }
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
      // perf:热重载只定位目标插件(main 端选择规则与 findPluginDirByManifestId(listDirs) 等价),结果与列举项
      // 同形:moduleUrl 同样是惰性源码引用,重新激活时才按目录名 + manifest 令牌拉 main。
      // 失败与旧 listDirs 失败同降级:当作找不到(reload 抛 no longer exists)。
      const r = await coApi.plugins.readDirById(id);
      if (!r.ok) {
        console.warn('[plugins-host] readDirById failed', r.code, r.message);
        return null;
      }
      return r.data ? deferredPluginDirInfo(r.data) : null;
    },
    readEnabledIds: async () => {
      const r = await coApi.plugins.readEnabled();
      if (!r.ok) {
        // 数据安全:读失败必须**传播**(不再降级成空 Set)—— 否则 mutateEnabledIds 的 RMW
        // 会基于空集合写回,抹掉其它已启用插件。调用方各自决定:init 降级、
        // mutate 中止写。(main readEnabledIds 仅 ENOENT 返回 [],EACCES/EIO 才 fail。)
        throw codedError(r.code, r.message);
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
        throw codedError(r.code, r.message);
      }
    },
    prefetchModule: prefetchMainSource,
    releasePrefetchedModule: releasePrefetchedSource,
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
