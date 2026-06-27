// 插件目录扫描 + 启用禁用 + 生命周期编排(M-Plugin v1.4)。
// I/O 完全注入(ManagerHost),便于 jsdom 单测;生产由主进程 IPC 实现。

import { Plugin } from './Plugin';
import { loadPluginModule } from './loader';
import { isVersionCompatible, parseManifest } from './manifest';
import {
  ensureAuthorized,
  type PermissionKey,
  type PermissionStore,
  type PromptFn,
} from './permissions';
import { createScopedApp } from './scoped-app';
import type { CoApp, PluginManifest } from './types';
import { errorMessage } from '../../electron/shared/error-message';
import { coApi } from '@/lib/co-api';
import { runSerialPerKey } from '@/lib/serialize-per-key';

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
  /**
   * 启用/禁用单个插件 id(数据安全:read-modify-write 收口到主进程全局串行 delta 写,
   * 跨窗口无 lost update;renderer 不再整表 RMW)。enabled=true 加入、false 移除。
   */
  mutateEnabledId(id: string, enabled: boolean): void | Promise<void>;
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
  /**
   * race(R77):用户「启用意图」,与运行态 status 解耦。init 自 _enabled.json,仅
   * enable/disable(及 uninstall 删 entry)修改 —— 镜像 _enabled.json 的内存副本。
   * reload 按此意图决定是否重激活,而非用瞬时 status 推断:否则热重载连续事件中先读到
   * 半写入/非法 manifest 把已启用插件置 'failed',文件修好再 reload 时 status 已非
   * 'enabled' → 被推断成 disabled 不激活 → 持久启用的插件因一次坏快照在会话内停用。
   */
  enabledIntent: boolean;
  instance?: Plugin;
  pluginFsToken?: string;
  /** i18n(I4):存结构化 code+message,不存拼好的可见串. */
  error?: PluginError;
  /** v5 Phase 2:partial grant 标记. i18n(I3):存结构化 code+params,不存可见文本. */
  warning?: PluginWarning;
}

/**
 * 结构化 warning —— i18n(codex 复查 P1,I3):manager 不拼可见文本(否则激活时按当时
 * locale 拼的中文会泄漏到 en/ko,且 locale 切换后陈旧)。存 catalog key + 插值参数,
 * renderer 渲染时才 t(code, params),随 locale 响应。
 */
export interface PluginWarning {
  readonly code: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/**
 * 结构化 error —— i18n(codex 复查 P1,I4):同 warning,manager 不存拼好的可见串
 * (loader NO_DEFAULT_EXPORT/NOT_PLUGIN_CLASS 的 message 是硬编码中文,旧实现 `${code}:
 * ${message}` 存进 entry.error 直接渲染 → en/ko 泄漏中文且不随 locale 重算)。error 来源
 * 异构(loader/manifest 解析/权限/catch-all),故存 code + 自由 message:renderer 用
 * tWithFallback(`errors.${code}`, `${code}: ${message}`) —— catalog 收录的 code 显本地化
 * 文案,未收录(PERMISSION_DENIED/IMPORT_FAILED/EXCEPTION 等动态 message)保留旧 `code:
 * message` 格式。
 */
export interface PluginError {
  readonly code: string;
  readonly message: string;
}

export interface PluginListItem {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly status: Status;
  readonly error?: PluginError;
  /** v5 Phase 2:partial grant 标记(plugin 已激活但部分权限未授). */
  readonly warning?: PluginWarning;
}

const EMPTY_ACTIVATION_ORDER: string[] = [];
const EMPTY_PLUGIN_LIST: readonly PluginListItem[] = [];
const EMPTY_PLUGIN_PERMISSIONS: readonly PermissionKey[] = [];

export function removeActivationOrderId(order: string[], id: string): string[] {
  if (order.length === 0) return EMPTY_ACTIVATION_ORDER;
  let next: string[] | null = null;
  let count = 0;
  for (let i = 0; i < order.length; i++) {
    const activeId = order[i]!;
    if (activeId === id) {
      if (next === null) {
        next = new Array<string>(Math.max(0, order.length - 1));
        for (let j = 0; j < i; j++) {
          next[count++] = order[j]!;
        }
      }
      continue;
    }
    if (next !== null) next[count++] = activeId;
  }
  if (next === null) return order;
  if (count === 0) return EMPTY_ACTIVATION_ORDER;
  next.length = count;
  return next;
}

export function findPluginDirByManifestId(
  dirs: readonly PluginDirInfo[],
  id: string,
): PluginDirInfo | null {
  for (const dir of dirs) {
    try {
      const manifest = JSON.parse(dir.manifestText) as { id?: unknown };
      if (manifest.id === id) return dir;
    } catch {
      // 半写入/损坏 manifest:reload 继续找其它目录,保持旧行为。
    }
  }
  return null;
}

// ── PluginManager ──────────────────────────────────────

export class PluginManager {
  private entries = new Map<string, PluginEntry>();
  private cachedList: readonly PluginListItem[] | null = null;
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

  /** 同 id 生命周期操作串行化(见 lifecycleLocks 注释).
   * race(R101):串行 + 排空回收收口到共享 runSerialPerKey(原 inline 副本漏删 key →
   * lifecycleLocks 随操作过的不同插件 id 单调增长内存泄漏)。 */
  private withLifecycleLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    return runSerialPerKey(this.lifecycleLocks, id, fn);
  }

  /** 扫描全部目录 + 解析 manifest + 激活 enabled. */
  async init(): Promise<void> {
    const dirs = await this.host.listPluginDirs();
    // 读 _enabled.json 失败(IO 错误)→ 本次不激活任何插件(降级),但**不**写回:init
    // 不触发任何 enabled 写,故不会抹盘。避免启动因一次读错误崩溃。enable/disable 的写路径
    // (host.mutateEnabledId → main setEnabledId)在主进程内 RMW,读错误会传播以中止写。
    let enabledIds: ReadonlySet<string>;
    try {
      enabledIds = await this.host.readEnabledIds();
    } catch (err) {
      console.warn(
        '[PluginManager] readEnabledIds failed at init — activating none',
        err,
      );
      enabledIds = new Set();
    }

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

      const intended = enabledIds.has(manifest.id);
      const entry: PluginEntry = {
        id: manifest.id,
        manifest,
        dirInfo: dir,
        status: intended ? 'enabled' : 'disabled',
        enabledIntent: intended, // race(R77):持久启用意图,reload 据此重激活
      };
      this.entries.set(manifest.id, entry);
      this.invalidateListCache();

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
      after.enabledIntent = true; // race(R77):与 _enabled.json 持久化同步置意图
      await this.host.mutateEnabledId(id, true);
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
    entry.enabledIntent = false; // race(R77):用户禁用 → 清持久启用意图(reload 不再重激活)
    this.invalidateListCache();
    this.activationOrder = removeActivationOrderId(this.activationOrder, id);

    await this.host.mutateEnabledId(id, false);
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
    const fresh = findPluginDirByManifestId(dirs, id);
    if (!fresh) {
      throw new Error(`Plugin ${id} no longer exists in plugins dir`);
    }

    // race(R77):据「用户启用意图」而非瞬时 status 判是否重激活。否则连续热重载中先读到
    // 坏 manifest 把已启用插件置 'failed',文件修好再 reload 时 status 已非 'enabled' →
    // 被推断成 disabled 不激活 → 持久启用的插件因一次坏快照在会话内停用,直到手动启用/重启。
    const wasEnabled = entry.enabledIntent;
    if (wasEnabled && entry.instance) {
      await this.deactivateEntry(entry, `reload ${id}`);
      this.activationOrder = removeActivationOrderId(this.activationOrder, id);
    }

    // 解析新 manifest(可能 version / permissions 等变了)
    const parsed = parseManifest(fresh.manifestText);
    if (!parsed.ok) {
      entry.status = 'failed';
      entry.error = { code: parsed.code, message: parsed.message };
      entry.warning = undefined; // 失败转换清陈旧 partial-grant warning(否则 failed 行同显 error+旧 warning)
      this.invalidateListCache();
      return;
    }

    entry.manifest = parsed.data;
    entry.dirInfo = fresh;
    entry.status = wasEnabled ? 'enabled' : 'disabled';
    entry.error = undefined;
    // reload→disabled 不会走 activateEntry(只 wasEnabled 才走),warning 须在此清;
    // reload→enabled 会走 activateEntry(311 清 + 342 按本次授权重设),此处清亦无害。
    entry.warning = undefined;
    this.invalidateListCache();

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
    this.invalidateListCache();
  }

  /** 列出所有已发现插件状态. */
  listAll(): readonly PluginListItem[] {
    if (this.cachedList !== null) return this.cachedList;
    if (this.entries.size === 0) return EMPTY_PLUGIN_LIST;
    const list = new Array<PluginListItem>(this.entries.size);
    let i = 0;
    for (const e of this.entries.values()) {
      list[i++] = {
        id: e.id,
        manifest: e.manifest,
        status: e.status,
        error: e.error,
        warning: e.warning,
      };
    }
    this.cachedList = list;
    return list;
  }

  // ── 内部 ────────────────────────────────────────────

  private async activateEntry(entry: PluginEntry): Promise<void> {
    // 先清前次的 error / warning,确保最终状态干净反映本次激活
    entry.error = undefined;
    entry.warning = undefined;
    this.invalidateListCache();

    // v3.4 权限门:manifest 声明了 permissions 且 host 配了 store + prompt
    // 才阻塞;否则放行(向后兼容)。
    // 安全:权限门必须在 loadPluginModule(import())之前 —— 插件 bundle 顶层
    // 代码在 import() 时即执行,若放到 load 之后,用户点"拒绝"时恶意顶层代码
    // 已运行过一次(可读 DOM / 调未 gate 的 IPC / 外带数据)。manifest 在扫描期
    // 已读到,权限判定无需先加载模块。
    const requested = entry.manifest.permissions ?? EMPTY_PLUGIN_PERMISSIONS;
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
        entry.error = {
          code: 'PERMISSION_DENIED',
          message: auth.deniedPerms.join(', '),
        };
        this.invalidateListCache();
        return;
      }
      // v5 Phase 2:partial grant → 设 warning,plugin 仍激活
      // i18n(I3):存结构化 code+params,renderer 用 catalog 渲染(避免 manager 拼中文)。
      if (auth.denied.length > 0) {
        entry.warning = {
          code: 'plugins_tab.warning.partial_grant',
          params: {
            granted: auth.granted.join(', '),
            denied: auth.denied.join(', '),
          },
        };
        this.invalidateListCache();
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
      entry.error = { code: loaded.code, message: loaded.message };
      this.invalidateListCache();
      return;
    }

    // 可维护性 M3:loader 现在把 PluginClass 类型为可构造的 PluginConstructor
    // (信任边界 runtime subclass 校验集中在 loader),此处直接 new,无需 as any。
    // v5 Phase 1:plugin 拿到的是 per-plugin scoped app(持 pluginId 给
    // permission.check;fs/network 等命名空间预留 Phase 3 启用 gating)
    // race(R29):若上次停用时 _unregisterPlugin 失败,entry.pluginFsToken 会被保留(见
    // revokePluginFsToken)。注册新 token 前先尝试回收残留的旧 token,否则下一行的赋值会用新
    // token 覆盖旧 token 引用 → 旧 token 永久泄漏。生命周期锁串行化同 id 操作,此处无并发
    // deactivate 竞争(见 lifecycleLocks 注释)。revoke best-effort 不抛;若仍失败,旧 token
    // 保留但会被新 token 覆盖(仅在 main IPC 持续不可用时发生,届时 token 记账本就无解)。
    await this.revokePluginFsToken(entry);
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
      entry.error = { code: 'EXCEPTION', message: errorMessage(err) };
      await this.revokePluginFsToken(entry);
      this.invalidateListCache();
      return;
    }

    entry.instance = instance;
    entry.status = 'enabled';
    this.invalidateListCache();
    // entry.error / warning 已在方法开头清(成功路径不再重复 reset 错误,
    // warning 若 partial grant 已在权限段设了)
    this.activationOrder.push(entry.id);
  }

  private invalidateListCache(): void {
    this.cachedList = null;
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
    const token = entry.pluginFsToken;
    if (!token) return;
    try {
      await coApi.pluginFsRaw._unregisterPlugin(token);
      // race(R29):仅在 unregister 成功后才清 token。此前是「先清 token 再 await」——
      // unregister IPC reject 时本地丢 token 而 main 侧仍有效 = 不可回收的 capability 泄漏;
      // 且异常上抛会让 deactivateEntry 的 finally 半提交(instance 已清、status 没落到
      // 'disabled'),后续 disableLocked 的 `!entry.instance` 守卫又早退,无法重试回收。
      entry.pluginFsToken = undefined;
    } catch (err) {
      // 保留 token(不清、不抛):本地拆除照常完成(status 正常落 'disabled'),token 仍被
      // 追踪,可在下次激活前的 flush(见 activateEntry)重试回收。
      console.warn(
        '[plugin-manager] _unregisterPlugin failed, token retained for retry',
        err,
      );
    }
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
