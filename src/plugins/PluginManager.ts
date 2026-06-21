// 插件目录扫描 + 启用禁用 + 生命周期编排(M-Plugin v1.4)。
// I/O 完全注入(ManagerHost),便于 jsdom 单测;生产由主进程 IPC 实现。

import { Plugin } from './Plugin';
import { loadPluginModule } from './loader';
import { isVersionCompatible, parseManifest } from './manifest';
import { ensureAuthorized, type PermissionStore, type PromptFn } from './permissions';
import { createScopedApp } from './scoped-app';
import type { CoApp, PluginManifest } from './types';
import { errorMessage } from '../../electron/shared/error-message';
import { coApi } from '@/lib/co-api';

// ── Host 注入接口 ──────────────────────────────────────

export interface PluginDirInfo {
  /** 目录名(通常等于 manifest.id,实际以 manifest.id 为准). */
  readonly id: string;
  /** manifest.json 文件文本. */
  readonly manifestText: string;
  /** main.js 模块 URL(主进程 file://...,renderer dynamic import 用). */
  readonly moduleUrl: string;
  /** styles.css 文本(可选). */
  readonly stylesText?: string;
}

export interface ManagerHost {
  /** 同步返回所有插件目录信息(主进程预先扫好). */
  listPluginDirs(): readonly PluginDirInfo[] | Promise<readonly PluginDirInfo[]>;
  /** 读取 enabled.json. */
  readEnabledIds(): ReadonlySet<string> | Promise<ReadonlySet<string>>;
  /** 写 enabled.json. */
  writeEnabledIds(ids: readonly string[]): void | Promise<void>;
  /** 动态 import,可注入 mock. */
  importModule(url: string): Promise<unknown>;
  /** v3.4 权限存储(可选,缺省 → 不做权限门). */
  permissionStore?: PermissionStore;
  /** v3.4 权限弹窗 PromptFn(可选,缺省 → 默认拒绝所有 pending). */
  promptFn?: PromptFn;
  /** v4.6 卸载:rm -rf plugins/<id>/(可选,缺省 → uninstall 抛 NOT_SUPPORTED). */
  removePluginDir?(id: string): Promise<void>;
}

// ── PluginEntry / Status ───────────────────────────────

type Status = 'enabled' | 'disabled' | 'failed';

interface PluginEntry {
  readonly id: string;
  manifest: PluginManifest;     // reload 时可重新解析
  dirInfo: PluginDirInfo;       // reload 时刷新 moduleUrl / manifestText
  status: Status;
  instance?: Plugin;
  pluginFsToken?: string;
  error?: string;
  /** v5 Phase 2:partial grant 时记 "部分授权:已授 X;未授 Y". */
  warning?: string;
}

export interface PluginListItem {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly status: Status;
  readonly error?: string;
  /** v5 Phase 2:partial grant 标记(plugin 已激活但部分权限未授). */
  readonly warning?: string;
}

// ── PluginManager ──────────────────────────────────────

export class PluginManager {
  private entries = new Map<string, PluginEntry>();
  /** 已激活顺序(用于 shutdown LIFO). */
  private activationOrder: string[] = [];
  /**
   * Per-id 生命周期串行锁。enable/disable/reload/uninstall 含多个 await 让权点
   * (权限 prompt / _registerPlugin / _activate / IPC),且 reload 由 mtime watcher
   * 每 2s fire-and-forget 触发 + 用户手动操作 → 同 id 并发交错会:旧 activateEntry
   * resume 后用旧 token 覆盖 entry.pluginFsToken,泄漏新 token(永不 _unregisterPlugin)
   * + 留下双激活的僵尸实例 + 重复贡献 panel/command/MCP tool。复用 plugins.service
   * 的 withInstallLock 同款 Promise 链锁串行化同 id 生命周期操作。
   */
  private readonly lifecycleLocks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly app: CoApp,
    private readonly host: ManagerHost,
  ) {}

  /** 同 id 生命周期操作串行化(见 lifecycleLocks 注释). */
  private withLifecycleLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.lifecycleLocks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.lifecycleLocks.set(
      id,
      run.then(
        () => {},
        () => {},
      ),
    );
    return run;
  }

  /** 扫描全部目录 + 解析 manifest + 激活 enabled. */
  async init(): Promise<void> {
    const dirs = await this.host.listPluginDirs();
    const enabledIds = await this.host.readEnabledIds();

    for (const dir of dirs) {
      const parsed = parseManifest(dir.manifestText);
      if (!parsed.ok) {
        console.warn(
          `[plugin-manager] skip ${dir.id}: ${parsed.code} ${parsed.message}`,
        );
        continue;
      }
      const manifest = parsed.data;

      // 版本兼容
      if (
        manifest.minLMVersion &&
        !isVersionCompatible(this.app.version, manifest.minLMVersion)
      ) {
        console.warn(
          `[plugin-manager] skip ${manifest.id}: minLMVersion ${manifest.minLMVersion} > app ${this.app.version}`,
        );
        continue;
      }

      const entry: PluginEntry = {
        id: manifest.id,
        manifest,
        dirInfo: dir,
        status: enabledIds.has(manifest.id) ? 'enabled' : 'disabled',
      };
      this.entries.set(manifest.id, entry);

      if (entry.status === 'enabled') {
        // init 的激活也必须走生命周期锁:activateEntry 在 ensureAuthorized 处 await
        // 用户权限弹窗(可挂数秒),而 main-app 紧接 init 就接线 mtime watcher 的
        // onChanged→reload(走锁)。若 init 不上锁,弹窗挂起期间被改动文件触发的
        // reload 会拿到空锁并发执行 → 与 reload/enable 同源的 token 泄漏/双激活。
        await this.withLifecycleLock(entry.id, () => this.activateEntry(entry));
      }
    }
  }

  /** 关闭所有 active 插件,LIFO 反序. */
  async shutdown(): Promise<void> {
    for (let i = this.activationOrder.length - 1; i >= 0; i--) {
      const id = this.activationOrder[i]!;
      const entry = this.entries.get(id);
      if (entry?.instance) {
        await this.deactivateEntry(entry, `shutdown ${id}`);
      }
    }
    this.activationOrder = [];
  }

  /** 启用单个插件(若已 active 幂等). per-id 串行. */
  async enable(id: string): Promise<void> {
    return this.withLifecycleLock(id, () => this.enableLocked(id));
  }

  private async enableLocked(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin ${id} not found`);
    if (entry.status === 'enabled') return; // 幂等

    // FAILED 重试:清掉旧的 deny 决策,让 ensureAuthorized 重新 prompt 用户
    // (允许用户改主意 — 上次拒绝 ≠ 永远拒绝)
    if (entry.status === 'failed' && this.host.permissionStore?.clearDenied) {
      await this.host.permissionStore.clearDenied(id);
    }

    await this.activateEntry(entry);
    // activateEntry 是 mutating 方法,TS 不知道 status 已变。
    // 重新从 map 取拿到 widening 后的类型。
    const after = this.entries.get(id);
    if (after?.status === 'enabled') {
      const ids = [...(await this.host.readEnabledIds()), id];
      await this.host.writeEnabledIds(Array.from(new Set(ids)));
    }
  }

  /** 禁用单个插件(若已 disabled 幂等). per-id 串行. */
  async disable(id: string): Promise<void> {
    return this.withLifecycleLock(id, () => this.disableLocked(id));
  }

  private async disableLocked(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin ${id} not found`);
    if (entry.status !== 'enabled' || !entry.instance) return;

    await this.deactivateEntry(entry, `disable ${id}`);
    entry.status = 'disabled';
    // partial-grant warning(及 error)只对 enabled+active 插件有意义。disable 后
    // 必须清,否则 PluginsTab 行无条件渲染 p.warning(无 status 门控)→ 已禁用的
    // 插件仍挂着「⚠ 部分授权」陈旧标记。deactivateEntry 不碰这两字段,activateEntry
    // 只在重新激活时清(311)→ 离开 active 的转换此前漏清(对称性缺口)。
    entry.error = undefined;
    entry.warning = undefined;
    this.activationOrder = this.activationOrder.filter((x) => x !== id);

    const remaining = [...(await this.host.readEnabledIds())].filter(
      (x) => x !== id,
    );
    await this.host.writeEnabledIds(remaining);
  }

  /**
   * 重新加载单个插件(M-Plugin v4.3,开发体验):
   * 1. 从 host 重新拉 dir info(拿最新 mainText / manifestText)
   * 2. 若已 active → _deactivate
   * 3. 重解析 manifest + 替换 entry.dirInfo / manifest
   * 4. 若原本 enabled → 重新 activateEntry
   *
   * 不存在的 id → 抛错;插件已从 plugins 目录移除 → 抛错。
   * 不变更 enabled.json(reload 是"刷新已加载",非启用切换)。
   *
   * per-id 串行:auto-reload watcher 每 2s fire-and-forget + 用户操作易并发同 id。
   */
  async reload(id: string): Promise<void> {
    return this.withLifecycleLock(id, () => this.reloadLocked(id));
  }

  private async reloadLocked(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin ${id} not found`);

    const dirs = await this.host.listPluginDirs();
    // 用 manifest.id 匹配(目录名可能跟 id 不一致;manifest.id 是真源)
    const fresh = dirs.find((d) => {
      try {
        const m = JSON.parse(d.manifestText) as { id?: unknown };
        return m.id === id;
      } catch {
        return false;
      }
    });
    if (!fresh) {
      throw new Error(`Plugin ${id} no longer exists in plugins dir`);
    }

    const wasEnabled = entry.status === 'enabled';
    if (wasEnabled && entry.instance) {
      await this.deactivateEntry(entry, `reload ${id}`);
      this.activationOrder = this.activationOrder.filter((x) => x !== id);
    }

    // 解析新 manifest(可能 version / permissions 等变了)
    const parsed = parseManifest(fresh.manifestText);
    if (!parsed.ok) {
      entry.status = 'failed';
      entry.error = `${parsed.code}: ${parsed.message}`;
      entry.warning = undefined; // 失败转换清陈旧 partial-grant warning(否则 failed 行同显 error+旧 warning)
      return;
    }

    entry.manifest = parsed.data;
    entry.dirInfo = fresh;
    entry.status = wasEnabled ? 'enabled' : 'disabled';
    entry.error = undefined;
    // reload→disabled 不会走 activateEntry(只 wasEnabled 才走),warning 须在此清;
    // reload→enabled 会走 activateEntry(311 清 + 342 按本次授权重设),此处清亦无害。
    entry.warning = undefined;

    if (wasEnabled) {
      await this.activateEntry(entry);
    }
  }

  /**
   * 卸载插件(M-Plugin v4.6):
   * 1. 若 enabled → disable LIFO _deactivate + 写 _enabled.json
   * 2. host.removePluginDir(id) → 主进程 rm -rf plugins/<id>/ + 清 _permissions
   * 3. 从 entries map 移除
   *
   * 不存在的 id → 抛错。host 未配 removePluginDir → 抛 NOT_SUPPORTED。
   *
   * per-id 串行:整段(含内部 disable)在同一把锁内,内部走 disableLocked
   * 避免对同 id 重入锁自死锁。
   */
  async uninstall(id: string): Promise<void> {
    return this.withLifecycleLock(id, () => this.uninstallLocked(id));
  }

  private async uninstallLocked(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin ${id} not found`);
    if (!this.host.removePluginDir) {
      throw Object.assign(new Error(`host 未实现 removePluginDir`), {
        code: 'NOT_SUPPORTED',
      });
    }

    if (entry.status === 'enabled' && entry.instance) {
      // 注意:走 disableLocked(非 public disable),否则在已持有的同 id 锁上重入死锁
      await this.disableLocked(id);
    }
    await this.host.removePluginDir(id);
    this.entries.delete(id);
  }

  /** 列出所有已发现插件状态. */
  listAll(): readonly PluginListItem[] {
    return Array.from(this.entries.values()).map((e) => ({
      id: e.id,
      manifest: e.manifest,
      status: e.status,
      error: e.error,
      warning: e.warning,
    }));
  }

  // ── 内部 ────────────────────────────────────────────

  private async activateEntry(entry: PluginEntry): Promise<void> {
    // 先清前次的 error / warning,确保最终状态干净反映本次激活
    entry.error = undefined;
    entry.warning = undefined;

    // v3.4 权限门:manifest 声明了 permissions 且 host 配了 store + prompt
    // 才阻塞;否则放行(向后兼容)。
    // 安全:权限门必须在 loadPluginModule(import())之前 —— 插件 bundle 顶层
    // 代码在 import() 时即执行,若放到 load 之后,用户点"拒绝"时恶意顶层代码
    // 已运行过一次(可读 DOM / 调未 gate 的 IPC / 外带数据)。manifest 在扫描期
    // 已读到,权限判定无需先加载模块。
    const requested = entry.manifest.permissions ?? [];
    if (
      requested.length > 0 &&
      this.host.permissionStore &&
      this.host.promptFn
    ) {
      const auth = await ensureAuthorized(
        entry.id,
        requested,
        this.host.permissionStore,
        this.host.promptFn,
      );
      if (!auth.ok) {
        console.warn(
          `[plugin-manager] ${entry.id} permission denied:`,
          auth.deniedPerms,
        );
        entry.status = 'failed';
        entry.error = `PERMISSION_DENIED: ${auth.deniedPerms.join(', ')}`;
        return;
      }
      // v5 Phase 2:partial grant → 设 warning,plugin 仍激活
      if (auth.denied.length > 0) {
        entry.warning = `部分授权:已授 ${auth.granted.join(', ')};未授 ${auth.denied.join(', ')}`;
      }
    }

    const loaded = await loadPluginModule({
      moduleUrl: entry.dirInfo.moduleUrl,
      manifest: entry.manifest,
      importer: (url) => this.host.importModule(url),
    });
    if (!loaded.ok) {
      console.warn(
        `[plugin-manager] load ${entry.id} failed: ${loaded.code} ${loaded.message}`,
      );
      entry.status = 'failed';
      entry.error = `${loaded.code}: ${loaded.message}`;
      return;
    }

    // 可维护性 M3:loader 现在把 PluginClass 类型为可构造的 PluginConstructor
    // (信任边界 runtime subclass 校验集中在 loader),此处直接 new,无需 as any。
    // v5 Phase 1:plugin 拿到的是 per-plugin scoped app(持 pluginId 给
    // permission.check;fs/network 等命名空间预留 Phase 3 启用 gating)
    const { token: pluginFsToken } =
      await coApi.pluginFsRaw._registerPlugin(entry.id);
    entry.pluginFsToken = pluginFsToken;
    const scopedApp = createScopedApp(
      this.app,
      entry.id,
      this.host.permissionStore ?? null,
      pluginFsToken,
    );
    // 构造器必须和 _activate 同在 try/catch 内:token 已在上面注册并设 active,
    // 若 `new PluginClass()` 同步抛错(插件构造函数 throw)而它在 try 之外,就会跳出
    // activateEntry 既不撤 token 也不标 failed → entry 停在 status='enabled' 但
    // instance=undefined 的半激活态。后续 disableLocked 的 `!entry.instance` 守卫
    // 又会早退、不走 deactivateEntry → 泄漏的 plugin-fs capability token 永不回收
    // (codex 复审 loop R1)。
    let instance: Plugin;
    try {
      instance = new loaded.PluginClass(scopedApp, entry.manifest);
      await instance._activate();
    } catch (err) {
      console.warn(
        `[plugin-manager] activate ${entry.id} failed`,
        err,
      );
      entry.status = 'failed';
      entry.error = errorMessage(err);
      await this.revokePluginFsToken(entry);
      return;
    }

    entry.instance = instance;
    entry.status = 'enabled';
    // entry.error / warning 已在方法开头清(成功路径不再重复 reset 错误,
    // warning 若 partial grant 已在权限段设了)
    this.activationOrder.push(entry.id);
  }

  private async deactivateEntry(
    entry: PluginEntry,
    label: string,
  ): Promise<void> {
    try {
      await entry.instance?._deactivate();
    } catch (err) {
      console.warn(`[plugin-manager] ${label} failed`, err);
    } finally {
      entry.instance = undefined;
      await this.revokePluginFsToken(entry);
    }
  }

  private async revokePluginFsToken(entry: PluginEntry): Promise<void> {
    if (!entry.pluginFsToken) return;
    const token = entry.pluginFsToken;
    entry.pluginFsToken = undefined;
    await coApi.pluginFsRaw._unregisterPlugin(token);
  }
}

// ── user PluginManager singleton ──────────────────────────────────
// main.tsx 在 bootCorePlugins 后实例化并 init();其它地方通过 getter 访问
// 当前快照(用于 Plugins SettingTab 等 UI)。

let _userManager: PluginManager | null = null;

export function setUserPluginManager(m: PluginManager): void {
  _userManager = m;
}

export function getUserPluginManager(): PluginManager | null {
  return _userManager;
}
