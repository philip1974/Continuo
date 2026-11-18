// 插件 IPC(M-Plugin v4.1,主进程端)。
// 扫 userData/plugins/<id>/,读 manifest + main.js 通过 IPC 给 renderer。

import { app } from 'electron';
import { PLUGIN_ID_MAX_LEN } from '../../shared/permission-record-limits';
import path from 'node:path';
import { z } from 'zod';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import {
  PLUGINS_CHANNELS,
  GIT_URL_MAX,
  PLUGIN_DIR_NAME_MAX_LEN,
  PLUGIN_MANIFEST_HASH_RE,
} from '../../shared/plugins-channels';
import {
  createPluginsWatcher,
  installFromGit,
  listPluginDirs,
  readPluginDirByManifestId,
  readPluginMainByDir,
  recoverInterruptedInstalls,
  readEnabledIds,
  readPermissions,
  mutatePluginPermissions,
  setEnabledId,
  uninstallPlugin,
  writePluginPathScopes,
} from '../services/plugins.service';
import { broadcastToWindows } from '../lib/broadcast';
import { revokePluginFsAccess, revokePluginPathScopes } from './plugin-fs.ipc';
import { PERMISSION_KEYS } from '../../shared/permission-keys';
import { GIT_BRANCH_MAX, isValidGitBranch } from '../../shared/git-branch';

// 边界(E16):插件 IPC schema 的长度上限,远超任何现实插件集合,只挡损坏/滥用;超限 → safeHandle zod
// 校验失败 → BAD_INPUT。(授权记录不再整条经 IPC 写入,decisions/pathScopes 的数量上限由 service 读写端负责。)
const PLUGIN_ID_MAX = PLUGIN_ID_MAX_LEN; // 反 DNS plugin id
const URL_MAX = GIT_URL_MAX; // git url(E282:收口到 shared,与 renderer onChange 截断同源)

const NoInput = z.undefined();
const MutateEnabledInput = z
  .object({ id: z.string().min(1).max(PLUGIN_ID_MAX), enabled: z.boolean() })
  .strict();
// 终审 P1:renderer 只发授权增量(按权限项),不再发整条记录覆盖写 —— 陈旧窗口的整条记录会把别窗的撤销
// 写回。decidedAt 由 main 取当前时间;perms 必须是权限枚举成员,数量不超过枚举大小。
const PermissionMutationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('set'),
      perms: z.array(z.enum(PERMISSION_KEYS)).min(1).max(PERMISSION_KEYS.length),
      granted: z.boolean(),
    })
    .strict(),
  z.object({ kind: z.literal('clear-denied') }).strict(),
]);
export const MutatePluginPermissionsInput = z
  .object({
    id: z.string().min(1).max(PLUGIN_ID_MAX),
    mutation: PermissionMutationSchema,
  })
  .strict();
export const InstallFromGitInput = z
  .object({
    url: z.string().min(1).max(URL_MAX),
    overwrite: z.boolean().optional(),
    // marketplace entry.branch / entry.id(可选,缺省行为不变);形态校验同 service 层契约。
    branch: z.string().max(GIT_BRANCH_MAX).refine(isValidGitBranch).optional(),
    expectedId: z.string().min(1).max(PLUGIN_ID_MAX).optional(),
  })
  .strict();
export const ReadDirByIdInput = z
  .object({ id: z.string().min(1).max(PLUGIN_ID_MAX) })
  .strict();
export const ReadMainByDirInput = z
  .object({
    dir: z.string().min(1).max(PLUGIN_DIR_NAME_MAX_LEN),
    // 列举项的 manifest 版本令牌(sha256 hex,定长 64)。
    manifestHash: z.string().max(64).regex(PLUGIN_MANIFEST_HASH_RE),
  })
  .strict();
export const UninstallInput = z
  .object({ id: z.string().min(1).max(PLUGIN_ID_MAX) })
  .strict();

/**
 * 把「某插件 main.js 变更」热重载通知广播给所有未销毁窗口。createPluginsWatcher 的 onChange。
 *
 * race(R67,R63/R64/R65/R66 同族):isDestroyed() 检查后、send 前窗口可能销毁,send 抛
 * "Object has been destroyed"。本函数是 watcher 的 onChange,裸抛会:(1)中断循环 → 后续窗口
 * 漏收 PLUGINS_CHANGED;(2)抛回 watcher 扫描循环被其 per-entry catch 吞掉 continue → mtimes
 * 不推进(见 plugins.service R67-B)→ 同一变更每 tick 反复触发/反复失败。每个窗口的 send 独立
 * try/catch,失败只跳过/记录并继续。导出供 R67 回归测试。
 */
export function broadcastPluginsChanged(id: string): void {
  broadcastToWindows(PLUGINS_CHANNELS.CHANGED, () => ({ id }), '[plugins] PLUGINS_CHANGED');
}

/**
 * 卸载成功后向所有窗口广播(终审 P1):每个窗口各自持有插件实例与内存授权缓存,只在发起窗口本地撤销会让
 * 其它窗口里的已卸载插件继续运行、继续调用 shell/network/clipboard。watcher 只发现 main.js 变化,发现不了删除。
 */
export function broadcastPluginUninstalled(id: string): void {
  broadcastToWindows(PLUGINS_CHANNELS.UNINSTALLED, () => ({ id }), '[plugins] PLUGINS_UNINSTALLED');
}

/**
 * 授权记录变更成功后向所有窗口广播(终审 P1):每个窗口各有内存授权缓存,A 撤销后 B 若不失效缓存,
 * 禁用再启用 / permission.check 仍按陈旧授权放行。
 */
export function broadcastPluginPermissionsChanged(id: string): void {
  broadcastToWindows(
    PLUGINS_CHANNELS.PERMISSIONS_CHANGED,
    () => ({ id }),
    '[plugins] PLUGINS_PERMISSIONS_CHANGED',
  );
}

/**
 * 启用状态写入成功后向所有窗口广播(终审 P1):每个窗口各自持有插件实例,窗口 A 禁用只在 A 本地停用,
 * 其它窗口的实例会继续运行、继续使用能力。
 */
export function broadcastPluginEnabledChanged(id: string, enabled: boolean): void {
  broadcastToWindows(
    PLUGINS_CHANNELS.ENABLED_CHANGED,
    () => ({ id, enabled }),
    '[plugins] PLUGINS_ENABLED_CHANGED',
  );
}

let primeBaseline: (() => void) | null = null;

/**
 * 冷启动:首窗创建后提前建立插件 watcher 基线。不在注册时(早于建窗)扫,免与建窗前 IO 争 libuv 线程池;
 * 也不等第一个 2s 周期 —— 否则 renderer 首次 LIST_DIRS 会在插件 init 关键路径上当场串行扫一遍。
 * 幂等(ensureBaseline 已建好 / 在途时直接复用);未注册时 no-op。
 */
export function primePluginsWatcherBaseline(): void {
  primeBaseline?.();
}

export function registerPluginsIpc(): void {
  const userData = app.getPath('userData');
  const pluginsDir = path.join(userData, 'plugins');
  const trusted = defaultIsTrustedFrame;

  // 启动期一次性恢复被进程崩溃中断的插件更新(还原孤儿 backup / 清残留 staging),
  // 在首次列举前完成,避免崩溃中断的更新让插件静默消失(数据安全)。幂等。
  const installRecovery = recoverInterruptedInstalls(pluginsDir).catch(() => {});

  // v4.3.1 mtime 自动 watch:任一 plugin main.js 改 → 推所有窗口。
  // 冷启动性能:不在注册时(早于建首窗)立即首扫 —— 与启动 IO 争 libuv 线程池;首扫推迟到第一个周期,
  // 或由 LIST_DIRS 在列举前按需建立(见下),两者取先到者。
  const watcher = createPluginsWatcher(pluginsDir, broadcastPluginsChanged);
  watcher.start(2000, { immediate: false });
  // 首窗创建后由 index.ts 调 primePluginsWatcherBaseline 提前建基线(安装恢复之后,免把恢复动作误报为变更)。
  primeBaseline = () => {
    void installRecovery.then(() => watcher.ensureBaseline());
  };

  safeHandle(
    PLUGINS_CHANNELS.LIST_DIRS,
    NoInput,
    async () => {
      await installRecovery;
      // 基线须在列举前建立(串行,不可并发):否则基线可能吞掉「列举之后、基线之前」的插件修改 →
      // renderer 拿到旧内容而永不收到 CHANGED。列举在基线之后读盘 → 此后的修改必被后续 tick 发现。
      await watcher.ensureBaseline();
      return listPluginDirs(pluginsDir);
    },
    trusted,
  );

  // perf:列举不带 main 源码,激活时按目录名只读该插件 main。
  safeHandle(
    PLUGINS_CHANNELS.READ_MAIN_BY_DIR,
    ReadMainByDirInput,
    async ({ dir, manifestHash }) => {
      await installRecovery;
      return readPluginMainByDir(pluginsDir, dir, manifestHash);
    },
    trusted,
  );

  // perf:单插件热重载只读目标插件(不再每个窗口全量 listDirs)。
  safeHandle(
    PLUGINS_CHANNELS.READ_DIR_BY_ID,
    ReadDirByIdInput,
    async ({ id }) => {
      await installRecovery;
      return readPluginDirByManifestId(pluginsDir, id);
    },
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.READ_ENABLED,
    NoInput,
    () => readEnabledIds(pluginsDir),
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.MUTATE_ENABLED,
    MutateEnabledInput,
    async ({ id, enabled }) => {
      await setEnabledId(pluginsDir, id, enabled);
      // 仅成功后广播(含发起窗口):各窗口同步实例启停(终审 P1)。
      broadcastPluginEnabledChanged(id, enabled);
    },
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.READ_PERMISSIONS,
    NoInput,
    () => readPermissions(pluginsDir),
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.MUTATE_PLUGIN_PERMISSIONS,
    MutatePluginPermissionsInput,
    async ({ id, mutation }) => {
      const record = await mutatePluginPermissions(pluginsDir, id, mutation);
      // 仅成功后广播(含发起窗口):各窗口失效权限缓存,下次读重新加载(终审 P1)。
      broadcastPluginPermissionsChanged(id);
      // 安全:撤销 `fs` → 一并撤销该插件已批准的全部路径 scope(内存 + 持久化),否则再授予 `fs` 时旧路径不经弹窗
      // 恢复。持久化失败如实报错(权限项本身已撤销)。
      if (mutation.kind === 'set' && !mutation.granted && mutation.perms.includes('fs')) {
        revokePluginPathScopes(id);
        await writePluginPathScopes(pluginsDir, id, []);
      }
      return record;
    },
    trusted,
  );

  // v4.5 从 git URL 安装
  safeHandle(
    PLUGINS_CHANNELS.INSTALL_FROM_GIT,
    InstallFromGitInput,
    ({ url, overwrite, branch, expectedId }) =>
      installFromGit(url, pluginsDir, { overwrite, branch, expectedId }),
    trusted,
  );

  // v4.6 卸载
  safeHandle(
    PLUGINS_CHANNELS.UNINSTALL,
    UninstallInput,
    async ({ id }) => {
      await uninstallPlugin(pluginsDir, id);
      // 安全:盘上授权已清,内存 path-scope / token 也必须同步撤(否则同会话重装同 id 静默继承)。
      revokePluginFsAccess(id);
      // 仅成功后广播(失败时插件仍在盘上,各窗口照常运行)。
      broadcastPluginUninstalled(id);
    },
    trusted,
  );
}
