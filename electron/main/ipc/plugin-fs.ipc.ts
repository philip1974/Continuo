// Wraps registerPluginFsHandlers from Op5 service factory.
// All handlers take token as first arg (after event); see (b)-branch design.

import { app, webContents, type IpcMain, type WebContents } from 'electron';
import { join } from 'node:path';
import { PLUGIN_FS_CHANNELS } from '../../shared/plugin-fs-channels';
import { IdentityRegistry } from '../services/identity-registry.service';
import { PathScopeRegistry } from '../services/path-scope-registry.service';
import { pluginFsIdentityEpoch, registerPluginFsHandlers } from '../services/plugin-fs.service';
import {
  persistPluginPathScopesIfInstalled,
  readPermissions,
  readPluginPathScopes,
} from '../services/plugins.service';
import { ownValue } from '../../shared/own-value';
import type { IpcPermissionDecision, IpcPermissionRecord } from '../../shared/plugins-channels';
import { ScopeRequestCorrelator } from '../services/scope-request-correlator';
import type { PathScope } from '../../shared/plugin-fs-contract';
import { withTrustedFrameGate } from '../safe-handle';
import { resolveProtectedRoots } from '../user-data-path';

export interface RegisterPluginFsIpcArgs {
  ipcMain: IpcMain;
}

export interface PluginFsIpcHandles {
  identityRegistry: IdentityRegistry;
  pathScopeRegistry: PathScopeRegistry;
  correlator: ScopeRequestCorrelator;
}

/**
 * Register plugin-fs IPC handlers. Returns the underlying registries so callers
 * can issue grant/revoke and listen to scope events in later wiring ops.
 */
// 模块级引用,供窗口硬关闭时 cancelScopeRequestsForWebContents 结算该窗发起的
// pending scope 授权请求(镜像 fs.ipc 的 releaseFsWatchersForWindow)。
let activeCorrelator: ScopeRequestCorrelator | null = null;

/**
 * 窗口关闭时,把该窗 webContents 发起的全部 pending scope 授权请求立即结算掉,
 * 否则 host 侧 `await promise` 要干等满 5min TTL 才被 sweep。返回结算条数。
 */
export function cancelScopeRequestsForWebContents(webContentsId: number): number {
  return activeCorrelator?.cancelBySender(webContentsId) ?? 0;
}

// 模块级引用,供插件卸载成功后 revokePluginFsAccess 撤销内存授权(同 activeCorrelator 手法)。
let activeHandles: PluginFsIpcHandles | null = null;

/**
 * 插件卸载成功后调用(安全):撤销该 pluginId 在所有窗口的 plugin-fs token 与内存 path-scope,
 * 并清 hydrated 标记(之后重新从已清空的磁盘水合)。_unregister-plugin 的 revokeAll 受 generation
 * 守卫(只最新实例才撤),旧 generation 窗口卸载 / 最新实例所在窗口已关时会跳过 → 内存 scope 残留,
 * 同会话重装同 id 插件经 covers() 静默继承旧目录读写授权。卸载 = 该插件在所有窗口失效,故无条件撤。
 */
export function revokePluginFsAccess(pluginId: string): void {
  if (!activeHandles) return;
  activeHandles.identityRegistry.revokeByPlugin(pluginId);
  activeHandles.pathScopeRegistry.revokeAll(pluginId);
}

/**
 * 安全:插件的 `fs` 权限被撤销(权限编辑保存 / 任何经 mutatePluginPermissions 把 fs 置为拒绝的入口)后调用:撤销该
 * 插件已批准的全部内存路径 scope(持久化的 `_plugin-path-scopes.json` 条目由调用方随即删除)。plugin-fs 主进程不看
 * `fs` 权限项(只靠 renderer 的 ensurePerm),此前撤销 `fs` 后 scope 原样留着,再勾上 `fs` 时以前批准的路径全部
 * 不经弹窗恢复(request-scope 命中 covers() 静默授予;重启后从磁盘水合同样恢复)。
 * 撤销后标记为「已水合(空)」:磁盘条目随即删除,在途 / 之后的水合读不得把旧 scope 写回内存。
 * plugin-fs token 不动(插件实例照常运行;无 `fs` 权限时 renderer 侧拒绝 fs 调用)。
 * 该插件(各窗口 / 各实例)正挂着的 scope 弹窗一并结算为取消:renderer 撤掉弹窗,请求方得到 deny;否则用户之后点
 * 「授权」,scope 照样落地并持久化,再勾上 `fs` 即不经弹窗恢复。还没走到弹窗的在途请求由 request-scope 处理器按
 * revokeAll 的代际自行放弃(见 PathScopeRegistry.revocationEpoch)。
 */
export function revokePluginPathScopes(pluginId: string): void {
  if (!activeHandles) return;
  activeHandles.pathScopeRegistry.revokeAll(pluginId);
  activeHandles.pathScopeRegistry.hydrate(pluginId, []);
  for (const token of activeHandles.identityRegistry.tokensFor(pluginId)) {
    activeHandles.correlator.cancelByToken(token);
  }
}

function recordGrantsFs(record: IpcPermissionRecord | undefined): boolean {
  if (record === undefined) return false;
  // Array.isArray 不收窄 readonly[] union 分支(同 plugins.service),显式 cast 对象形态。
  const decisions: readonly IpcPermissionDecision[] = Array.isArray(record)
    ? record
    : (record as { decisions: readonly IpcPermissionDecision[] }).decisions;
  return decisions.some((d) => d.permission === 'fs' && d.granted);
}

/**
 * 冷启动水合读盘(安全纵深):先对照 `_permissions.json` —— 该插件当前未持有 `fs` 授权 → 不水合任何 scope
 * (返回 []),并顺带清掉盘上残留。撤销 `fs` 的清盘若因任何原因(交错、崩溃、旧版本残留)没落盘,不能在下次
 * 重新授予 `fs` 后不经弹窗恢复旧路径。权限文件读失败 → 抛出,水合方按 [] 降级(fail-closed)。
 * 清残留不 await:走同 id 锁(FIFO,排在其后的授权持久化不受影响),不让水合等安装 / 更新持有的锁。
 */
export async function loadPersistedScopesIfFsGranted(
  pluginsDir: string,
  pluginId: string,
): Promise<PathScope[]> {
  const record = ownValue(await readPermissions(pluginsDir), pluginId);
  if (!recordGrantsFs(record)) {
    persistPluginPathScopesIfInstalled(pluginsDir, pluginId, []).catch(() => undefined);
    return [];
  }
  return readPluginPathScopes(pluginsDir, pluginId);
}

export function copyScopesForPersistence(
  scopes: readonly { path: string; mode: 'r' | 'rw' }[],
): PathScope[] {
  const out = new Array<PathScope>(scopes.length);
  for (let i = 0; i < scopes.length; i++) {
    const scope = scopes[i]!;
    out[i] = { path: scope.path, mode: scope.mode };
  }
  return out;
}

export function registerPluginFsIpc({
  ipcMain,
}: RegisterPluginFsIpcArgs): PluginFsIpcHandles {
  const identityRegistry = new IdentityRegistry();
  // 安全:应用自身的数据 / 程序目录是受保护根,任何 path-scope(哪怕用户授了 `~`)都不覆盖。
  const pathScopeRegistry = new PathScopeRegistry(identityRegistry, {
    protectedRoots: resolveProtectedRoots({
      userDataPath: app.getPath('userData'),
      appDataPath: app.getPath('appData'),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath ?? '',
      platform: process.platform,
    }),
    // 性能:受保护根 inode 判定的身份在两次 plugin-fs 变更(独占锁授予)之间复用。
    identityCache: { getEpoch: pluginFsIdentityEpoch },
  });
  const correlator = new ScopeRequestCorrelator();
  activeCorrelator = correlator;

  // path-scope 持久化落在 userData/plugins/_plugin-path-scopes.json,与决策同目录、分文件。
  const pluginsDir = join(app.getPath('userData'), 'plugins');

  // frame-trust 门(token + sender 校验之外的纵深防御;_register-plugin 本身不带 token)。
  registerPluginFsHandlers(withTrustedFrameGate(ipcMain), {
    identityRegistry,
    pathScopeRegistry,
    correlator,
    webContentsForSender: (senderId: number): WebContents | null =>
      webContents.fromId(senderId) ?? null,
    loadPersistedScopes: (pluginId) =>
      loadPersistedScopesIfFsGranted(pluginsDir, pluginId),
    // 安全:经同 id mutation 锁 + 已安装校验落盘,防卸载间隙的授权把 scope 写回磁盘(见函数注释)。
    persistScopes: (pluginId, scopes) =>
      persistPluginPathScopesIfInstalled(
        pluginsDir,
        pluginId,
        copyScopesForPersistence(scopes),
      ),
  });

  pathScopeRegistry.on(
    'scope-updated',
    (payload: {
      pluginId: string;
      scopes: readonly { path: string; mode: 'r' | 'rw' }[];
    }) => {
      // perf:只发给持有该插件 token 的 webContents(此前遍历 getAllWebContents(),连其它窗口与
      // devtools 都收到该插件的完整授权路径列表)。
      for (const wcId of identityRegistry.webContentsIdsFor(payload.pluginId)) {
        const wc = webContents.fromId(wcId);
        if (!wc || wc.isDestroyed()) continue;
        // race(R65,R63/R64 同族):isDestroyed() 检查后、send 前 wc 可能销毁,send 抛
        // "Object has been destroyed"。本回调是 pathScopeRegistry 的 EventEmitter listener,
        // grant()/revokeAll() 会同步 emit('scope-updated') 触发它;若 send 抛错冒泡出 listener
        // → 反向打断 grant/revokeAll 的调用栈 → 对应 IPC handler(request-scope / _unregister-
        // plugin)收到异常返回失败,但 scope 可能已写入内存(grant)或 token 已 revoke / scope
        // 已清(unregister),形成「授权状态已变更但调用方感知失败」的不一致。每个 wc.send 独立
        // try/catch,失败只跳过/记录,不让广播异常冒泡。镜像 i18n(R64)/protocol(R63)。
        try {
          wc.send(PLUGIN_FS_CHANNELS.SCOPE_UPDATED, payload);
        } catch (err) {
          console.error('[plugin-fs] scope-updated broadcast failed', err);
        }
      }
    },
  );

  activeHandles = { identityRegistry, pathScopeRegistry, correlator };
  return activeHandles;
}
