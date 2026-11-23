import type { PathScope } from './plugin-fs-contract';
import { PLUGIN_ID_MAX_LEN } from './permission-record-limits';
import type { PermissionKey } from './permission-keys';

// 插件系统 IPC 通道(M-Plugin v4.1)。
// 主进程扫 userData/plugins/<id>/,renderer 拿到 manifest + main.js 文本
// 通过 Blob URL 动态 import。

export const PLUGINS_CHANNELS = {
  /**
   * 扫描 plugins 目录,返回所有候选(每个含 manifestText;main 可用性已判定,但不含 main 源码 ——
   * perf:未启用插件的源码不读、不跨 IPC 传输)。源码激活时经 READ_MAIN_BY_DIR 按目录名拉取。
   */
  LIST_DIRS: 'plugins:list-dirs',
  /**
   * 按**目录名**(LIST_DIRS 结果的 id)读取该插件 main 入口源码,返回 string | null(目录 / manifest / main
   * 不可用)。按目录而非 manifest.id:重复 id 的目录选择已在 renderer 完成,不在此再选一次以免口径漂移。
   * 入参须带列举项的 manifestHash:读 main 前后当前 manifest 与之不一致(列举后插件被更新)→ 抛
   * PLUGIN_MANIFEST_CHANGED,避免以旧 manifest(id / 权限 / 入口)执行新 main。
   */
  READ_MAIN_BY_DIR: 'plugins:read-main-by-dir',
  /**
   * 按 manifest.id 定位单个插件目录(perf:热重载不再全量 listDirs),返回与列举项同形的 IpcPluginDirListing | null
   *(不含 main 源码:需要激活时走 READ_MAIN_BY_DIR)。
   * 选择规则与 renderer findPluginDirByManifestId(listDirs) 等价(同名目录优先,否则目录名字典序)。
   */
  READ_DIR_BY_ID: 'plugins:read-dir-by-id',
  /** 读取 enabled.json(string[] of plugin ids). */
  READ_ENABLED: 'plugins:read-enabled',
  /**
   * 按单个 plugin 启用/禁用合并写 _enabled.json(数据安全)。renderer 整表 RMW 在多窗口
   * 下会丢失更新(后写者覆盖先写者),改走 main 端 read-modify-write 单条 delta 串行链。
   */
  MUTATE_ENABLED: 'plugins:mutate-enabled',
  /** 读 _permissions.json(v4.2). */
  READ_PERMISSIONS: 'plugins:read-permissions',
  /**
   * 按权限项增量变更单个 plugin 的 _permissions.json 记录(终审 P1)。此前 renderer 发整条记录覆盖写,
   * 陈旧窗口保存其它权限时会把别窗的撤销写回;改为只发变更项,main 在串行写链内合并当前落盘记录。
   */
  MUTATE_PLUGIN_PERMISSIONS: 'plugins:mutate-plugin-permissions',
  /**
   * main → renderer push:插件 `{ id }` 的授权记录已变更(终审 P1)。各窗口失效权限缓存,下次读重新加载,
   * 避免 A 窗口撤销后 B 窗口仍按陈旧缓存放行。
   */
  PERMISSIONS_CHANGED: 'plugins:permissions-changed',
  /** main → renderer push:某 plugin main.js mtime 变化(v4.3.1). */
  CHANGED: 'plugins:changed',
  /** main → renderer push:外部 co:// URL 唤起(v4.4). */
  PROTOCOL_URL: 'plugins:protocol-url',
  /**
   * renderer → main:本窗口已挂 PROTOCOL_URL 监听(onProtocolUrl 调用时上报)。main 只向上报过的窗口
   * 投递 / 排空 co:// 队列 —— did-finish-load 时 renderer 可能还没挂监听(冷启动深链被丢)。
   */
  PROTOCOL_READY: 'plugins:protocol-ready',
  /** 从 git URL clone + 安装到 plugins 目录(v4.5). */
  INSTALL_FROM_GIT: 'plugins:install-from-git',
  /** 卸载插件:rm -rf plugins/<id>/ + 清 _enabled / _permissions(v4.6). */
  UNINSTALL: 'plugins:uninstall',
  /**
   * main → renderer push:插件 `{ id }` 已卸载(终审 P1)。每个窗口各有一个 PluginManager,卸载成功后
   * 广播给所有窗口(含发起者),各自停用实例 / 注销贡献点 / 失效权限缓存(幂等,不触盘)。
   */
  UNINSTALLED: 'plugins:uninstalled',
  /**
   * main → renderer push:插件 `{ id, enabled }` 的启用状态已写入 _enabled.json(终审 P1)。每个窗口各有一个
   * PluginManager,启用 / 禁用成功后广播给所有窗口(含发起者),各自同步实例(幂等,不触盘)。
   */
  ENABLED_CHANGED: 'plugins:enabled-changed',
} as const;

// 边界(E242,E168-E175 IPC push ingress 守卫族):main→renderer push 事件的 payload runtime 守卫。
// preload 的 onChanged / onProtocolUrl 此前直接 `payload.id` / `payload.url` 解包,信任 main 发来的形态:
// null payload 在 listener 中抛(未捕获),超长/非字符串 id 会进 plugin-reload-gate pending Set 或触发
// reload(污染启动期缓冲/错误路径),超长 url 进 protocol-dispatch。纯函数守卫(无 zod,preload 可 import),
// preload 不合法则 warn+drop 不调 cb。与 fs:dir-changed / agent-auth 的 push 守卫同款纵深防御。
export const PROTOCOL_URL_MAX_LEN = 8192; // co:// URL 长度上限(对齐 path 类上限)

// 边界(E282):git 安装 URL 长度上限。renderer 两个 Git URL 输入(Marketplace / PluginsTab)与 main
// InstallFromGitInput schema 共用,renderer onChange 截断(防超长 paste 撑 React state + IPC structured-clone
// 放大,main schema 才拒);main schema 作后门防线。
export const GIT_URL_MAX = 4096;

/** 边界(E282):截断 git URL 到 GIT_URL_MAX(两个 Git URL 输入 onChange 复用)。 */
export function clampGitUrl(url: string): string {
  return url.length > GIT_URL_MAX ? url.slice(0, GIT_URL_MAX) : url;
}

/** 边界(E242):plugins:changed push payload 守卫 —— 非空 string id 且 ≤ PLUGIN_ID_MAX_LEN. */
export function isPluginsChangedPayload(p: unknown): p is { id: string } {
  if (p === null || typeof p !== 'object') return false;
  const id = (p as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 && id.length <= PLUGIN_ID_MAX_LEN;
}

/** plugins:enabled-changed push payload 守卫 —— 同 isPluginsChangedPayload 的 id 约束 + boolean enabled. */
export function isPluginEnabledChangedPayload(p: unknown): p is { id: string; enabled: boolean } {
  return isPluginsChangedPayload(p) && typeof (p as { enabled?: unknown }).enabled === 'boolean';
}

/** 边界(E242):plugins:protocol-url push payload 守卫 —— 非空 string url 且 ≤ PROTOCOL_URL_MAX_LEN. */
export function isProtocolUrlPayload(p: unknown): p is { url: string } {
  if (p === null || typeof p !== 'object') return false;
  const url = (p as { url?: unknown }).url;
  return typeof url === 'string' && url.length > 0 && url.length <= PROTOCOL_URL_MAX_LEN;
}

/** 插件目录列举项(LIST_DIRS):manifest + 目录名,不含 main 源码. */
export interface IpcPluginDirMeta {
  /** 目录名(以 manifest.id 为准,renderer 端再校验). */
  readonly id: string;
  /** manifest.json 文件文本. */
  readonly manifestText: string;
}

/** 插件目录列举项(LIST_DIRS):在 IpcPluginDirMeta 基础上带 manifest 版本令牌. */
export interface IpcPluginDirListing extends IpcPluginDirMeta {
  /** manifestText 的 sha256(小写 hex);激活时随 READ_MAIN_BY_DIR 提交,校验 manifest 未变. */
  readonly manifestHash: string;
}

/** READ_MAIN_BY_DIR 目录名长度上限(= 常见文件系统单级文件名上限 NAME_MAX). */
export const PLUGIN_DIR_NAME_MAX_LEN = 255;

/** manifest 版本令牌格式(sha256 小写 hex,定长 64). */
export const PLUGIN_MANIFEST_HASH_RE = /^[0-9a-f]{64}$/;

/** v4.2 权限决策存储的磁盘格式. */
export interface IpcPermissionDecision {
  readonly permission: string;        // 'fs' | 'network' | 'shell' | 'clipboard'(运行时校验)
  readonly granted: boolean;
  readonly decidedAt: number;
}

/** 路径 scope(plugin-fs 授权)的 IPC/磁盘只读形态 —— 与 PathScope 同一契约(单一来源)。 */
export type IpcPathScope = Readonly<PathScope>;

/**
 * 单个 plugin 的权限磁盘/IPC 记录。两种形态:
 *  - 旧:决策数组(v4.2 起);
 *  - 新:`{ decisions, pathScopes? }`(plugin-fs path scope 持久化)。
 * main / preload / renderer 共用此契约,避免 renderer 序列化时 `as never` 强转
 * (可维护性 M6:此前 shared 只建模旧数组形态,renderer 写时被迫断言)。
 */
export type IpcPermissionRecord =
  | readonly IpcPermissionDecision[]
  | {
      readonly decisions: readonly IpcPermissionDecision[];
      readonly pathScopes?: readonly IpcPathScope[];
    };

export type IpcPermissionsMap = Readonly<Record<string, IpcPermissionRecord>>;

/**
 * 单个 plugin 的授权增量变更(终审 P1):`set` 只替换所列权限项的决策(decidedAt 由 main 取当前时间);
 * `clear-denied` 去掉所有拒绝项。其它权限项与 pathScopes 以 main 当前落盘记录为准原样保留。
 */
export type IpcPermissionMutation =
  | {
      readonly kind: 'set';
      readonly perms: readonly PermissionKey[];
      readonly granted: boolean;
    }
  | { readonly kind: 'clear-denied' };
