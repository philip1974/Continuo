// 插件 IPC(M-Plugin v4.1,主进程端)。
// 扫 userData/plugins/<id>/,读 manifest + main.js + styles.css 通过 IPC 给 renderer。

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { z } from 'zod';
import { defaultIsTrustedFrame, safeHandle } from '../safe-handle';
import { makeBoundedRecordValidator } from '../../shared/validate-env-bounded';
import { PLUGINS_CHANNELS, GIT_URL_MAX } from '../../shared/plugins-channels';
import {
  createPluginsWatcher,
  installFromGit,
  listPluginDirs,
  recoverInterruptedInstalls,
  readEnabledIds,
  readPermissions,
  setEnabledId,
  uninstallPlugin,
  writeEnabledIds,
  writePermissions,
  writePluginPermissions,
} from '../services/plugins.service';

// 边界(E16):插件权限 IPC schema 此前对 ids/decisions/pathScopes/plugin id/path/permission 字符串
// 都无长度或数量上限。畸形 renderer payload 可把 _permissions.json / _path-scopes.json 写成超大对象
// 或超长路径列表 → 主进程 RMW、atomic JSON 写入、启动水合、权限 UI 卡顿。下列 cap 远超任何现实
// 插件集合,只挡损坏/滥用;超限 → safeHandle zod 校验失败 → BAD_INPUT。
const PLUGIN_ID_MAX = 256; // 反 DNS plugin id
const PERMISSION_MAX = 256; // 权限名
const PATH_MAX = 8192; // path scope 路径
const URL_MAX = GIT_URL_MAX; // git url(E282:收口到 shared,与 renderer onChange 截断同源)
const IDS_MAX = 10_000; // enabled id 数量
const DECISIONS_MAX = 1000; // 单插件 decisions 数量
// 边界(E246):单插件 path scopes 写端上限须与读盘层 MAX_PERSISTED_SCOPES_PER_PLUGIN(256,对齐
// PathScopeRegistry MAX_SCOPES_PER_PLUGIN E81)一致 —— 此前写端 10_000 过松,接受 257..10000 条写入
// 返回成功,但下次 readPermissions() 只保留前 256 条 → 重启/下轮 RMW 静默丢 scope(写读契约错位)。
// 统一到 256:写端直接拒(BAD_INPUT),把"会被读端丢弃"的写入在入口显式失败,不假成功后静默截断。
const PATHSCOPES_MAX = 256; // 单插件 path scopes 数量(对齐读盘层 MAX_PERSISTED_SCOPES_PER_PLUGIN)
const PLUGINS_MAX = 10_000; // permission record 条目数

const NoInput = z.undefined();
export const WriteEnabledInput = z
  .object({ ids: z.array(z.string().max(PLUGIN_ID_MAX)).max(IDS_MAX) })
  .strict();
const MutateEnabledInput = z
  .object({ id: z.string().min(1).max(PLUGIN_ID_MAX), enabled: z.boolean() })
  .strict();
const DecisionSchema = z
  .object({
    permission: z.string().max(PERMISSION_MAX),
    granted: z.boolean(),
    // 边界(E92,E87 读端对偶):decidedAt 必须有限非负。z.number() 接受 Infinity/NaN —— 写端
    // 看似 grant/deny 成功,但持久化 JSON.stringify(Infinity)=null,读盘层(E87 isDecision)按
    // 有限数校验丢弃该 decision → 重启后权限记录静默丢失(写读契约不对称)。.finite() 与读端
    // Number.isFinite 对齐,.nonnegative() 钳住时间戳语义(更严的前门)。
    decidedAt: z.number().finite().nonnegative(),
  })
  .strict();
// 可维护性 M6:与 shared IpcPermissionRecord 同步 —— 接受旧数组形态与新
// `{ decisions, pathScopes? }` 形态,让 IPC 校验契约与 renderer 序列化契约一致。
const PathScopeSchema = z
  .object({ path: z.string().max(PATH_MAX), mode: z.enum(['r', 'rw']) })
  .strict();
const PermissionRecordSchema = z.union([
  z.array(DecisionSchema).max(DECISIONS_MAX),
  z
    .object({
      decisions: z.array(DecisionSchema).max(DECISIONS_MAX),
      pathScopes: z.array(PathScopeSchema).max(PATHSCOPES_MAX).optional(),
    })
    .strict(),
]);
export const WritePermissionsInput = z
  .object({
    // 边界(E187,E185/E186 兄弟):权限表用共享有界早停校验,不用 z.record(...).refine(Object.keys...)
    // —— 后者 PLUGINS_MAX 上限在 zod 全量遍历所有 plugin 记录 + Object.keys 全量物化之后才生效,巨表在
    // schema 阶段就 O(N) 卡顿/分配(权限表是持久化数据,防放大应在入口早停)。与 env(E185/E186)单一来源。
    data: z
      .custom<Record<string, z.infer<typeof PermissionRecordSchema>>>()
      .superRefine(
        makeBoundedRecordValidator({
          keyMax: PLUGIN_ID_MAX,
          maxEntries: PLUGINS_MAX,
          valueOk: (val) => PermissionRecordSchema.safeParse(val).success,
          label: 'permission record',
        }),
      ),
  })
  .strict();
export const WritePluginPermissionsInput = z
  .object({
    id: z.string().min(1).max(PLUGIN_ID_MAX),
    record: PermissionRecordSchema,
  })
  .strict();
export const InstallFromGitInput = z
  .object({
    url: z.string().min(1).max(URL_MAX),
    overwrite: z.boolean().optional(),
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
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(PLUGINS_CHANNELS.CHANGED, { id });
    } catch (err) {
      console.error('[plugins] PLUGINS_CHANGED broadcast failed', err);
    }
  }
}

export function registerPluginsIpc(): void {
  const userData = app.getPath('userData');
  const pluginsDir = path.join(userData, 'plugins');
  const trusted = defaultIsTrustedFrame;

  // 启动期一次性恢复被进程崩溃中断的插件更新(还原孤儿 backup / 清残留 staging),
  // 在首次列举前完成,避免崩溃中断的更新让插件静默消失(数据安全)。幂等。
  const installRecovery = recoverInterruptedInstalls(pluginsDir).catch(() => {});

  safeHandle(
    PLUGINS_CHANNELS.LIST_DIRS,
    NoInput,
    async () => {
      await installRecovery;
      return listPluginDirs(pluginsDir);
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
    PLUGINS_CHANNELS.WRITE_ENABLED,
    WriteEnabledInput,
    async ({ ids }) => {
      await writeEnabledIds(pluginsDir, ids);
    },
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.MUTATE_ENABLED,
    MutateEnabledInput,
    async ({ id, enabled }) => {
      await setEnabledId(pluginsDir, id, enabled);
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
    PLUGINS_CHANNELS.WRITE_PERMISSIONS,
    WritePermissionsInput,
    async ({ data }) => {
      await writePermissions(pluginsDir, data);
    },
    trusted,
  );

  safeHandle(
    PLUGINS_CHANNELS.WRITE_PLUGIN_PERMISSIONS,
    WritePluginPermissionsInput,
    async ({ id, record }) => {
      await writePluginPermissions(pluginsDir, id, record);
    },
    trusted,
  );

  // v4.3.1 mtime 自动 watch:任一 plugin main.js 改 → 推所有窗口
  const watcher = createPluginsWatcher(pluginsDir, broadcastPluginsChanged);
  watcher.start(2000);

  // v4.5 从 git URL 安装
  safeHandle(
    PLUGINS_CHANNELS.INSTALL_FROM_GIT,
    InstallFromGitInput,
    ({ url, overwrite }) => installFromGit(url, pluginsDir, { overwrite }),
    trusted,
  );

  // v4.6 卸载
  safeHandle(
    PLUGINS_CHANNELS.UNINSTALL,
    UninstallInput,
    async ({ id }) => {
      await uninstallPlugin(pluginsDir, id);
    },
    trusted,
  );
}
