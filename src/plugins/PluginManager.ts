// 插件目录扫描 + 启用禁用 + 生命周期编排(M-Plugin v1.4)。
// I/O 完全注入(ManagerHost),便于 jsdom 单测;生产由主进程 IPC 实现。

import { Plugin } from './Plugin';
import { loadPluginModule } from './loader';
import { admitManifest } from './manifest';
import {
  ensureAuthorized,
  type PermissionKey,
  type PermissionStore,
  type PromptFn,
} from './permissions';
import { createScopedAppController, type ScopedAppController } from './scoped-app';
import type { CoApp, PluginManifest } from './types';
import { codedError, errorCodeOf, errorMessage } from '../../electron/shared/error-message';
import { coApi } from '@/lib/co-api';
import { runSerialPerKey } from '@/lib/serialize-per-key';
import { allSettledWithConcurrency } from '@/lib/map-with-concurrency';

// ── Host 注入接口 ──────────────────────────────────────

export interface PluginDirInfo {
  /** 目录名(main 列举只收目录名 = manifest.id 的目录,见 plugins.service readOnePluginDirMeta). */
  readonly id: string;
  /** manifest.json 文件文本. */
  readonly manifestText: string;
  /** 插件入口的惰性源码引用(激活时 host.importModule 才按目录名 + manifest 令牌拉 main 源码). */
  readonly moduleUrl: string;
  /** main 入口文件的 mtime(ms,与 main 文件监视同一变化信号);列举不读 main 源码,据此判断 main 是否改过。 */
  readonly mainMtime?: number;
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
  /**
   * 预取模块源码(可选,perf:启动并行读源码):只读取并准备好 importModule(url) 所需资源,**不 import、不执行
   * 插件代码**(故可在权限门之前)。不得 reject;失败不缓存,importModule 照常走原路径。
   */
  prefetchModule?(url: string): Promise<void>;
  /** 丢弃 url 未被 importModule 用掉的预取结果(可选,释放 Blob URL 等资源);已 import 的不受影响。 */
  releasePrefetchedModule?(url: string): void;
  /** v3.4 权限存储(可选,缺省 → 不做权限门). */
  permissionStore?: PermissionStore;
  /** v3.4 权限弹窗 PromptFn(可选,缺省 → 不做权限门,与 permissionStore 缺省同,向后兼容). */
  promptFn?: PromptFn;
  /** v4.6 卸载:rm -rf plugins/<id>/(可选,缺省 → uninstall 抛 NOT_SUPPORTED). */
  removePluginDir?(id: string): Promise<void>;
  /**
   * 终止本窗口内该插件启动的全部 shell 进程(可选,缺省 → 不终止)。插件实例离开运行态时调用
   * (终审 P1:否则停用/卸载后长任务继续跑到超时)。
   */
  killPluginShellProcesses?(id: string): Promise<void>;
  /**
   * 取消该插件待决的授权弹窗(可选,终审 P1):插件已被别的窗口卸载时调用,对应 promptFn 以 reason reject
   * (不得 resolve([]) —— 那会被当作「用户全拒」写盘)。
   */
  cancelPermissionPrompt?(id: string, reason: Error): void;
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
  /**
   * 当前实例的 scoped app 控制面(终审 P1):离开运行态时先 revoke() 再调 onunload;授权变更时
   * recheckMcpPermission()。与 instance 同生命周期。
   */
  scoped?: ScopedAppController;
  /**
   * 激活进行中(终审 P1:onload 挂起):revokeImmediately 据此决定是否立即终止 shell 进程;abortActivation 在开始
   * import 前挂上,调用即不再等 import / onload、激活按「被禁用」收尾、释放生命周期锁。
   */
  activating?: boolean;
  abortActivation?: () => void;
  /**
   * 激活期间(onload 已注册贡献、界面已渲染,但 status 尚未置 enabled)上报的渲染出错:激活成功置 enabled 后立即转
   * failed(RENDER_FAILED),否则被 enabled 覆盖(界面显示错误而插件页显示正常、无失败通知)。只取首个;每次激活前清除。
   */
  pendingRenderError?: PluginError;
  pluginFsToken?: string;
  /** i18n(I4):存结构化 code+message,不存拼好的可见串. */
  error?: PluginError;
  /** v5 Phase 2:partial grant 标记. i18n(I3):存结构化 code+params,不存可见文本. */
  warning?: PluginWarning;
  /**
   * 同会话卸载后重装、由 adoptInstalled 登记时的目录快照(一次性):main 文件监视对该 id 留有卸载 tombstone,
   * 重装后必广播一次 PLUGINS_CHANGED → 排队的 reload 若目录仍是这份 manifest 且 main 未改、且在 adopt 后
   * ADOPT_RELOAD_SKIP_MS 内,就跳过(否则 onload / onunload / onload 各一遍)。首个 reload 消费后清除;全新安装不设
   *(没有 tombstone,不会有这次广播)。那次广播若先于登记到达(reload 因条目不存在抛错),标记无人消费 ——
   * main 校验与时限保证之后的真实热重载 / 手动重新加载不被它吞掉。
   */
  adoptedSnapshot?: { readonly manifestText: string; readonly mainMtime: number | undefined; readonly until: number };
  /**
   * 别的窗口装的(adoptInstalled prompt:false)、因授权尚未决定只登记为禁用:授权由发起窗口的弹窗决定。该窗口授权后
   * 本窗口收到 permissions-changed → 盘上仍启用且已无未决定权限即激活(handlePermissionsChanged)。任一次激活尝试 /
   * 停用后清除。插件页据此显示「已在其他窗口安装,等待授权」。
   */
  awaitingGrantElsewhere?: boolean;
}

/**
 * 结构化 warning —— i18n(复查 P1,I3):manager 不拼可见文本(否则激活时按当时
 * locale 拼的中文会泄漏到 en/ko,且 locale 切换后陈旧)。存 catalog key + 插值参数,
 * renderer 渲染时才 t(code, params),随 locale 响应。
 */
export interface PluginWarning {
  readonly code: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/**
 * 结构化 error —— i18n(复查 P1,I4):同 warning,manager 不存拼好的可见串
 * (loader NO_DEFAULT_EXPORT/NOT_PLUGIN_CLASS 的 message 是硬编码中文,旧实现 `${code}:
 * ${message}` 存进 entry.error 直接渲染 → en/ko 泄漏中文且不随 locale 重算)。error 来源
 * 异构(loader/manifest 解析/权限/catch-all),故存 code + 自由 message:renderer 用
 * localizeErrorByCode(code, `${code}: ${message}`) —— catalog 收录的 code 显本地化文案,未收录
 *(PERMISSION_DENIED/IMPORT_FAILED/EXCEPTION 等动态 message)或模板带占位符时保留 `code: message`。
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
  /** 别的窗口装的、等待该窗口授权(见 PluginEntry.awaitingGrantElsewhere)。 */
  readonly awaitingGrantElsewhere?: true;
}

const EMPTY_PLUGIN_LIST: readonly PluginListItem[] = [];
const EMPTY_PLUGIN_PERMISSIONS: readonly PermissionKey[] = [];
/** 重装后跳过 tombstone 那次 reload 的时限(main 文件监视 2s 一轮,广播在此之内到达)。 */
const ADOPT_RELOAD_SKIP_MS = 10_000;
/** init 预取插件源码的并发上限(读源码 IPC + Blob 生成;激活本身仍串行)。 */
const PREFETCH_CONCURRENCY = 4;

/**
 * 多个目录声明同一 manifest.id 时的确定性取舍:目录名 == id 的优先,否则按目录名字典序取第一个。main 列举已跳过
 * 目录名 ≠ manifest.id 的目录(两端契约 plugins/<id>/),正常列举结果不会出现同 id 多目录;此函数保留为对 host 输入的
 * 防御性确定取舍(测试 / 非 main host)。返回 candidate 是否应取代 current。
 */
function preferPluginDir(candidate: PluginDirInfo, current: PluginDirInfo, id: string): boolean {
  const candidateExact = candidate.id === id;
  if (candidateExact !== (current.id === id)) return candidateExact;
  return candidate.id < current.id;
}

export interface SelectedPluginDir {
  readonly dir: PluginDirInfo;
  readonly manifest: PluginManifest;
}

/**
 * 启动与热重载共用的「准入 + 选目录」(单一来源,保证两者对同一份磁盘状态选同一目录):不合格的目录跳过并 warn;
 * 同一 manifest.id 只在合格目录中按 preferPluginDir 留一个。返回 id → 选中目录,Map 插入序 = 选中目录的列举序
 *(启动按此顺序登记、激活)。
 */
export function selectPluginDirs(
  dirs: readonly PluginDirInfo[],
  appVersion: string,
): Map<string, SelectedPluginDir> {
  // id → 合格目录(按列举序,带下标)
  const admitted = new Map<string, { dir: PluginDirInfo; manifest: PluginManifest; index: number }[]>();
  for (const [index, dir] of dirs.entries()) {
    const admission = admitManifest(dir.manifestText, appVersion);
    if (!admission.ok) {
      console.warn(`[plugin-manager] skip ${dir.id}: ${admission.code} ${admission.message}`);
      continue;
    }
    const list = admitted.get(admission.manifest.id);
    const item = { dir, manifest: admission.manifest, index };
    if (list) list.push(item);
    else admitted.set(admission.manifest.id, [item]);
  }
  const winners: { id: string; dir: PluginDirInfo; manifest: PluginManifest; index: number }[] = [];
  for (const [id, list] of admitted) {
    const winner = list.reduce((best, c) => (preferPluginDir(c.dir, best.dir, id) ? c : best));
    for (const c of list) {
      if (c !== winner) {
        console.warn(`[plugin-manager] skip ${c.dir.id}: duplicate manifest id ${id} (using ${winner.dir.id})`);
      }
    }
    winners.push({ id, ...winner });
  }
  winners.sort((x, y) => x.index - y.index);
  return new Map(winners.map(({ id, dir, manifest }) => [id, { dir, manifest }]));
}

/** manifest 原始 JSON 里的 id(JSON 损坏 → undefined);只用于「哪些目录声明了这个 id」,准入仍走 admitManifest。 */
function rawManifestId(manifestText: string): unknown {
  try {
    return (JSON.parse(manifestText) as { id?: unknown } | null)?.id;
  } catch {
    return undefined;
  }
}

function activationAbortedError(id: string): Error {
  return codedError('ACTIVATION_ABORTED', `plugin ${id} activation aborted (disabled / uninstalled)`);
}

function uninstalledError(id: string): Error {
  return codedError('NOT_INSTALLED', `plugin ${id} has been uninstalled`);
}

// ── PluginManager ──────────────────────────────────────

export class PluginManager {
  private entries = new Map<string, PluginEntry>();
  private cachedList: readonly PluginListItem[] | null = null;
  private readonly listListeners = new Set<() => void>();
  /**
   * Per-id 生命周期串行锁。enable/disable/reload/uninstall 含多个 await 让权点
   * (权限 prompt / _registerPlugin / _activate / IPC),且 reload 由 mtime watcher
   * 每 2s fire-and-forget 触发 + 用户手动操作 → 同 id 并发交错会:旧 activateEntry
   * resume 后用旧 token 覆盖 entry.pluginFsToken,泄漏新 token(永不 _unregisterPlugin)
   * + 留下双激活的僵尸实例 + 重复贡献 panel/command/MCP tool。复用 plugins.service
   * 的 withPluginMutationLock 同款 Promise 链锁(共享 runSerialPerKey)串行化同 id 生命周期操作。
   */
  private readonly lifecycleLocks = new Map<string, Promise<unknown>>();
  /**
   * per-id「停用意图」(终审 P1:热重载绕过禁用 / 卸载)—— 统一取代此前三套标记(已卸载 id 集合、激活中的
   * revokeRequested、init 期间尚无 entry 的禁用标记)。
   * - 写入:禁用 / 卸载**请求到达时同步**写入(本地 disable / uninstall 进锁前;禁用 / 卸载广播的 handleEnabledChanged /
   *   handleUninstalled 开头同步调用 revokeImmediately / markUninstalled),不依赖 entry 是否存在、是否 activating,
   *   不等扫描 / 生命周期锁 / init。
   * - 检查:所有激活路径(init、enable、热重载、enabled=true 广播)在 activateEntryUnguarded 中、导入模块 / 构造实例之前
   *   检查,存在 → 不激活,按禁用收尾(落 disabled;启用意图由排队的锁内停用清除并落盘)。init 与 reload 先查,存在
   *   则直接不激活。激活不会清除它。
   * - 清除:只有显式启用 —— 本地 enable() 调用时、enabled=true 广播到达时(handleEnabledChanged 开头 markEnabled)同步
   *   清除。'uninstalled'(目录已删)不被启用清除;本地卸载失败(entry 仍在)时降为 'disabled',用户可重新启用。
   * 否则:旧实例 onunload 挂起期间的禁用只吊销旧 scoped app,重载随后建全新 scoped app 并激活;排在禁用之前的 reload
   * 按旧启用意图重新激活。
   */
  private readonly deactivationIntents = new Map<string, 'disabled' | 'uninstalled'>();
  /**
   * 扫描完成信号(见 whenScanned):init 登记完全部插件 entry、进入激活循环前 resolve;init 失败(扫描抛)也 resolve。
   * 激活可能 await 授权弹窗 / 插件 onload 挂起,init 可能长时间不完成 —— 只需 manifest 的消费者不应被它拖住。
   * 也是 main 推送事件的启动门控(R16):reload / handleUninstalled / handleEnabledChanged 在扫描完成前到达时先等它
   *(否则条目未登记 → 「Plugin not found」丢弃 / 被 init 的旧快照复活),之后经生命周期锁与 init 的激活按 id 排序;
   * 不等全部激活完(某插件授权弹窗无人理会时,其它插件的事件照常生效)。
   */
  private scanDone = false;
  private resolveScanned!: () => void;
  private readonly scanned = new Promise<void>((resolve) => {
    this.resolveScanned = resolve;
  });

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
    try {
      await this.initUnlocked();
    } finally {
      this.markScanned(); // 扫描抛错时也放行等待者(幂等)
    }
  }

  private markScanned(): void {
    this.scanDone = true;
    this.resolveScanned();
  }

  /**
   * main 推送事件的启动门控(见 scanned):扫描完成前 → 等扫描;之后同步返回 null,调用方同步进生命周期锁(不多让一拍,
   * 与本地操作的先后不被打乱)。扫描前到达的多个事件按到达顺序恢复(同一 Promise 的回调 FIFO)。须先调 init()。
   */
  private untilScanned(): Promise<void> | null {
    return this.scanDone ? null : this.scanned;
  }

  /**
   * 扫描完成:listAll() 已含本次 init 发现的全部插件(激活可能仍在进行)。perf:启动更新检查只需 manifest,
   * 挂在这里而非整个 init 上 —— 某插件激活挂起时不再永不检查。init 失败也 resolve。
   */
  whenScanned(): Promise<void> {
    return this.scanned;
  }

  private async initUnlocked(): Promise<void> {
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

    // 准入(manifest schema + minLMVersion)与重复 manifest.id 取舍:与 reload 同一函数。重复 id 两个都激活的话,
    // 后一个 entries.set 覆盖前一个却不停用它 → 孤儿实例(disable/uninstall 都够不着)。
    const selected = selectPluginDirs(dirs, this.app.version);

    // 两阶段:先登记全部 entry(扫描完成 → whenScanned),再按同一顺序逐个激活。
    const registered: PluginEntry[] = [];
    for (const { dir, manifest } of selected.values()) {
      // 快照之后已收到禁用 / 卸载(见 deactivationIntents)→ 不按旧快照激活,以 disabled 建 entry。
      const intended = enabledIds.has(manifest.id) && !this.deactivationIntents.has(manifest.id);
      const entry: PluginEntry = {
        id: manifest.id,
        manifest,
        dirInfo: dir,
        status: intended ? 'enabled' : 'disabled',
        enabledIntent: intended, // race(R77):持久启用意图,reload 据此重激活
      };
      this.entries.set(manifest.id, entry);
      registered.push(entry);
    }
    this.invalidateListCache();
    this.markScanned();

    // perf:串行激活前,有界并发预取已启用插件的源码(不 import、不执行插件代码);激活仍按原顺序串行,命中预取。
    const prefetched = this.prefetchEnabledModules(registered);

    for (const entry of registered) {
      try {
        if (entry.status === 'enabled') await this.initActivate(entry);
      } finally {
        // 激活所用的就是预取那份 → import 后已不受影响;未用上(禁用 / 卸载 / 授权拒绝 / 热重载换了 dirInfo
        // 即换了 manifest 令牌)→ 丢弃,释放 Blob URL。
        const url = prefetched.get(entry);
        if (url !== undefined) this.host.releasePrefetchedModule?.(url);
      }
    }
  }

  /**
   * 对 status==='enabled' 的 entry 以有界并发(PREFETCH_CONCURRENCY)发起 host.prefetchModule,不等待完成。
   * 返回 entry → 预取所用 moduleUrl(激活后据此释放未用上的预取)。host 未实现 → 空表。
   */
  private prefetchEnabledModules(registered: readonly PluginEntry[]): Map<PluginEntry, string> {
    const urls = new Map<PluginEntry, string>();
    const prefetch = this.host.prefetchModule?.bind(this.host);
    if (!prefetch) return urls;
    const queue: [PluginEntry, string][] = [];
    for (const entry of registered) {
      if (entry.status !== 'enabled') continue;
      const url = entry.dirInfo.moduleUrl;
      urls.set(entry, url);
      queue.push([entry, url]);
    }
    // 有界并发;fn 在轮到该项时才调用 —— 轮到时已不会按这份 dirInfo 激活(禁用 / 卸载 / 已换 dirInfo)→ 不再预取。
    // host 契约不 reject;防御:单项失败记为 rejected,不影响其它项与激活(激活照常拉取)。
    void allSettledWithConcurrency(queue, PREFETCH_CONCURRENCY, async ([entry, url]) => {
      if (
        this.entries.get(entry.id) !== entry ||
        entry.status !== 'enabled' ||
        entry.instance ||
        entry.dirInfo.moduleUrl !== url ||
        this.deactivationIntents.has(entry.id)
      ) {
        return;
      }
      await prefetch(url);
    });
    return urls;
  }

  private async initActivate(entry: PluginEntry): Promise<void> {
    // init 的激活也必须走生命周期锁:activateEntry 在 ensureAuthorized 处 await
    // 用户权限弹窗(可挂数秒),而 main-app 紧接 init 就接线 mtime watcher 的
    // onChanged→reload(走锁)。若 init 不上锁,弹窗挂起期间被改动文件触发的
    // reload 会拿到空锁并发执行 → 与 reload/enable 同源的 token 泄漏/双激活。
    await this.withLifecycleLock(entry.id, async () => {
      // 登记后、轮到激活前,锁内操作可能已改变它:已卸载(entry 移除)/ 已禁用(status 落 disabled)→ 跳过。
      if (this.entries.get(entry.id) !== entry || entry.status !== 'enabled' || entry.instance) return;
      // 登记后到达的禁用 / 卸载意图 → 不激活,落 disabled(同 activateEntry 中止收尾:启用意图由排队的停用清除 / 落盘)。
      if (this.deactivationIntents.has(entry.id)) {
        this.setStatus(entry, 'disabled');
        return;
      }
      await this.activateEntry(entry);
    });
  }

  /**
   * 本窗口刚装好的新插件(尚不在列表):不重启即登记,并按 _enabled.json 的启用状态激活 —— main 在全新安装时已写入启用
   *(对齐 VSCode 安装即启用),激活照常走权限授权。与启动同一准入 + 选目录(selectPluginDirs)。已在列表 → 无操作(更新由
   * 文件监视热重载)。返回该 id 是否已在列表(目录不存在 / 准入不过 → false,调用方保留「待重启」)。per-id 串行。
   *
   * `prompt: false`:别的窗口装的(main 广播 plugins:installed)。授权弹窗只在发起安装的窗口出现(不多窗同时弹):激活
   * 需要弹窗(声明的权限尚有未决定的)→ 只登记为禁用(列表 / 市场显示已安装),用户在本窗口启用或下次启动时再激活;
   * 无需弹窗(无权限 / 已全部决定)→ 照常激活。
   */
  async adoptInstalled(id: string, { prompt = true }: { readonly prompt?: boolean } = {}): Promise<boolean> {
    // 重装是显式意图:清掉同 id 先前卸载留下的停用意图(否则同会话卸载后重装永不激活)。须在进锁前同步清 ——
    // 之后到达的卸载 / 禁用会重新记下,登记时按停用处理。
    const reinstall = this.deactivationIntents.get(id) === 'uninstalled';
    if (reinstall) this.deactivationIntents.delete(id);
    const scanning = this.untilScanned();
    if (scanning) await scanning;
    return this.withLifecycleLock(id, async () => {
      if (this.entries.has(id)) return true;
      const own = (await this.host.listPluginDirs()).filter((d) => rawManifestId(d.manifestText) === id);
      const selected = selectPluginDirs(own, this.app.version).get(id);
      if (!selected) return false;
      let enabledIds: ReadonlySet<string>;
      try {
        enabledIds = await this.host.readEnabledIds();
      } catch (err) {
        console.warn(`[PluginManager] readEnabledIds failed adopting ${id} — registering disabled`, err);
        enabledIds = new Set();
      }
      const intended = enabledIds.has(id) && !this.deactivationIntents.has(id);
      // 只登记的不记启用意图:否则之后的热重载会按意图激活、在本窗口弹授权。
      const activate = intended && (prompt || !(await this.needsPermissionPrompt(id, selected.manifest)));
      const entry: PluginEntry = {
        id,
        manifest: selected.manifest,
        dirInfo: selected.dir,
        status: activate ? 'enabled' : 'disabled',
        enabledIntent: activate,
        ...(intended && !activate ? { awaitingGrantElsewhere: true } : {}),
        ...(reinstall
          ? {
              adoptedSnapshot: {
                manifestText: selected.dir.manifestText,
                mainMtime: selected.dir.mainMtime,
                until: Date.now() + ADOPT_RELOAD_SKIP_MS,
              },
            }
          : {}),
      };
      this.entries.set(id, entry);
      this.invalidateListCache();
      if (activate) await this.activateEntry(entry);
      return true;
    });
  }

  /** 激活该插件是否会弹授权窗(权限门生效且声明的权限尚有未决定的);读授权失败按「会弹」处理。 */
  private async needsPermissionPrompt(id: string, manifest: PluginManifest): Promise<boolean> {
    const requested = manifest.permissions ?? EMPTY_PLUGIN_PERMISSIONS;
    const { permissionStore, promptFn } = this.host;
    if (requested.length === 0 || !permissionStore || !promptFn) return false;
    try {
      const decided = new Set((await permissionStore.get(id)).map((d) => d.permission));
      return requested.some((p) => !decided.has(p));
    } catch {
      return true;
    }
  }

  /** 启用单个插件(若已 active 幂等). per-id 串行. */
  async enable(id: string): Promise<void> {
    // 显式启用:同步清除停用意图(须在进锁前 —— 若在锁内清,排在本次启用之后的禁用请求会被抹掉,
    // 其吊销早于新激活发生、中止不到新实例)。
    this.clearDisabledIntent(id);
    return this.withLifecycleLock(id, () => this.enableLocked(id));
  }

  private async enableLocked(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin ${id} not found`);
    if (entry.status === 'enabled') return; // 幂等

    // 因权限被拒而 FAILED 的重试:清掉旧的 deny 决策,让 ensureAuthorized 重新 prompt 用户
    // (允许用户改主意 — 上次拒绝 ≠ 永远拒绝)。其它原因失败(onload 抛错 / 渲染出错 / 加载失败)的重试
    // 保留拒绝记录 —— 对齐 VSCode,不未经用户选择再次询问其已明确拒绝的项(部分授权的拒绝项可在权限编辑器改)。
    if (entry.status === 'failed' && entry.error?.code === 'PERMISSION_DENIED') {
      await this.host.permissionStore?.clearDenied(id);
    }

    await this.activateEntry(entry);
    // 以「激活成功」(有实例)为准记启用意图,不看瞬时 status:激活一完成贡献就渲染,渲染出错会在本 await 期间把
    // status 改成 failed(markRenderFailed,实例仍在运行)—— 对齐 VSCode,视图出错不改变启用状态。
    if (this.activated(entry)) {
      entry.enabledIntent = true; // race(R77):与 _enabled.json 持久化同步置意图
      await this.host.mutateEnabledId(id, true);
    }
  }

  /** 禁用单个插件(若已 disabled 幂等). per-id 串行. */
  async disable(id: string): Promise<void> {
    // 终审 P1:锁外立即吊销(激活挂在 onload 上时锁可能永不释放),锁内停用照旧排队。
    this.revokeImmediately(id);
    return this.withLifecycleLock(id, () => this.disableLocked(id));
  }

  private async disableLocked(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin ${id} not found`);
    // 未运行且无启用意图 → 幂等。有启用意图但无实例(激活被本次禁用中止 / 激活失败)仍须停用并落盘,
    // 否则 _enabled.json 仍记启用,下次启动复活。
    if (!entry.instance && !entry.enabledIntent) return;

    await this.markDisabled(entry, `disable ${id}`);
    await this.host.mutateEnabledId(id, false);
  }

  /** 停用实例(若有)并落到 disabled + 清启用意图;不写盘(本地禁用与远端禁用广播共用). */
  private async markDisabled(entry: PluginEntry, label: string): Promise<void> {
    if (entry.instance) await this.deactivateEntry(entry, label);
    entry.enabledIntent = false; // race(R77):用户禁用 → 清持久启用意图(reload 不再重激活)
    entry.awaitingGrantElsewhere = undefined;
    this.setStatus(entry, 'disabled');
  }

  /**
   * 别的窗口(或本窗口)启用 / 禁用了插件(main 在 _enabled.json 写入成功后广播 plugins:enabled-changed,
   * 终审 P1):本窗口同步到同一启用状态,**不写盘**。幂等:发起窗口自身也会收到广播,状态已一致 → 无操作。
   * - enabled=false:与本地禁用相同的停用(吊销 scoped app / 注销贡献点 / 回收 token / 终止 shell 进程)。
   * - enabled=true:与本地启用相同的激活(权限门按已授权放行;不清拒绝项 —— 那是发起窗口用户的重试意图)。
   * 本窗口不认识的 id(此窗口启动后才安装)→ 忽略,沿用「重载窗口后生效」。
   */
  async handleEnabledChanged(id: string, enabled: boolean): Promise<void> {
    // 同步部分(终审 P1):不等扫描 / 生命周期锁 —— 禁用立即吊销并中止挂起的激活(激活可能挂在 onload 上、锁永不释放);
    // 启用立即清除停用意图(否则 init / 热重载 / 下方锁内启用仍按该意图跳过激活)。
    if (enabled) this.markEnabled(id);
    else this.revokeImmediately(id);
    const scanning = this.untilScanned();
    if (scanning) await scanning;
    return this.withLifecycleLock(id, async () => {
      const entry = this.entries.get(id);
      if (!entry) return;
      if (!enabled) {
        if (entry.status === 'disabled' && !entry.instance && !entry.enabledIntent && !entry.awaitingGrantElsewhere) return;
        await this.markDisabled(entry, `disabled elsewhere ${id}`);
        return;
      }
      // 已一致 = 实例在运行(不只看 status):启用后贡献渲染出错会把 status 改成 failed(RENDER_FAILED,实例保留),
      // 此时收到本窗口写盘引发的启用广播若再激活 → 插件被无故重启(第二次激活 / 第二条失败通知,已打开的面板被关掉)。
      if (entry.status === 'enabled' || this.activated(entry)) {
        entry.enabledIntent = true;
        return;
      }
      await this.activateEntry(entry);
      if (this.activated(entry)) entry.enabledIntent = true; // 同 enableLocked:以激活成功为准
    });
  }

  /**
   * 插件授权记录变更(main 广播 plugins:permissions-changed,终审 P1;调用方已先失效权限缓存):
   * 重查当前实例的 mcp-tools 授权,已撤销 → 注销其全部 MCP 工具(main 侧 stub 同步移除)。
   * 调用期的逐次重查是兜底,这里保证工具列表准确。未激活 / 未知 id → 无操作。
   */
  async handlePermissionsChanged(id: string): Promise<void> {
    await this.entries.get(id)?.scoped?.recheckMcpPermission();
    if (this.entries.get(id)?.awaitingGrantElsewhere) {
      await this.withLifecycleLock(id, () => this.followGrantElsewhereLocked(id));
    }
  }

  /**
   * 别的窗口装的、只登记的条目:发起窗口授权后跟进激活(不弹窗)—— 盘上仍启用、无停用意图、已无未决定权限。
   * 仍有未决定的 → 继续等待;盘上已不启用(别处已禁用)→ 不激活。激活结果(成功 / 拒绝致 failed)与发起窗口一致。
   */
  private async followGrantElsewhereLocked(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry?.awaitingGrantElsewhere || entry.status !== 'disabled' || this.deactivationIntents.has(id)) return;
    let enabledIds: ReadonlySet<string>;
    try {
      enabledIds = await this.host.readEnabledIds();
    } catch (err) {
      console.warn(`[PluginManager] readEnabledIds failed following grant of ${id}`, err);
      return;
    }
    if (!enabledIds.has(id)) {
      entry.awaitingGrantElsewhere = undefined;
      this.invalidateListCache();
      return;
    }
    if (await this.needsPermissionPrompt(id, entry.manifest)) return;
    await this.activateEntry(entry);
    if (this.activated(entry)) entry.enabledIntent = true; // 同 enableLocked:以激活成功为准
  }

  /**
   * 激活是否成功(条目仍在且有运行中的实例)。启用意图据此记,而非 status === 'enabled':激活成功后渲染出错会把
   * status 改成 failed(实例保留,见 markRenderFailed),那仍是一次成功启用。
   */
  private activated(entry: PluginEntry): boolean {
    return this.entries.get(entry.id) === entry && entry.instance !== undefined;
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
    const scanning = this.untilScanned();
    if (scanning) await scanning;
    return this.withLifecycleLock(id, () => this.reloadLocked(id));
  }

  private async reloadLocked(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin ${id} not found`);
    // 已卸载、拆除尚在排队(如扫描前排队的文件变化随后收到卸载广播):目录已删 / 将删,拆除由排队的卸载负责 → 不重载、不报错。
    if (this.deactivationIntents.get(id) === 'uninstalled') return;

    // 重新列举后用与启动同一个准入 + 选目录函数取目标 id(manifest.id 是真源;main 列举已保证目录名 = id):两者对同一份
    // 磁盘状态总选同一目录、同样拒绝不兼容版本。没有合格目录 → 仍有目录声明该 id 时标 failed(下方),否则不存在。
    // 只看声明了该 id 的目录(其它目录不可能被选为该 id,也免得为无关插件告警)。
    const own = (await this.host.listPluginDirs()).filter((d) => rawManifestId(d.manifestText) === id);
    if (own.length === 0) throw new Error(`Plugin ${id} no longer exists in plugins dir`);
    const selected = selectPluginDirs(own, this.app.version).get(id);
    // 没有合格目录 → 取按同一偏好排第一的声明目录的准入失败原因(它声明了该 id 却没被选中,准入必然失败)。
    const rejection = selected
      ? null
      : admitManifest(own.reduce((best, d) => (preferPluginDir(d, best, id) ? d : best)).manifestText, this.app.version);
    // 重装后 tombstone 引发的那次广播:目录仍是 adopt 时那份 manifest、main 未改、未过时限 → 已按它登记并激活,
    // 不再停用再激活(一次性)。
    const adopted = entry.adoptedSnapshot;
    entry.adoptedSnapshot = undefined;
    if (
      adopted !== undefined &&
      Date.now() <= adopted.until &&
      selected?.dir.manifestText === adopted.manifestText &&
      selected.dir.mainMtime === adopted.mainMtime
    ) {
      return;
    }

    // race(R77):据「用户启用意图」而非瞬时 status 判是否重激活。否则连续热重载中先读到
    // 坏 manifest 把已启用插件置 'failed',文件修好再 reload 时 status 已非 'enabled' →
    // 被推断成 disabled 不激活 → 持久启用的插件因一次坏快照在会话内停用,直到手动启用/重启。
    // 终审 P1:已请求禁用 / 卸载(停用意图)→ 只拆旧实例、刷新元数据,不再激活 —— 排队的禁用 / 卸载随后落地。
    const wasEnabled = entry.enabledIntent && !this.deactivationIntents.has(id);
    if (entry.instance) {
      await this.deactivateEntry(entry, `reload ${id}`);
    }

    // 新 manifest(可能 version / permissions 等变了)未通过准入 → failed
    if (!selected) {
      this.setStatus(
        entry,
        'failed',
        rejection && !rejection.ok
          ? { code: rejection.code, message: rejection.message }
          : // 类型兜底:own 中的目录都声明了该 id,没被选中即准入失败,走不到这里。
            { code: 'SCHEMA_ERROR', message: `no admissible directory for ${id}` },
      );
      return;
    }

    entry.manifest = selected.manifest;
    entry.dirInfo = selected.dir;
    // reload→enabled 随后走 activateEntry(先清 error / warning、再按本次授权重设);此处一并清亦无害。
    entry.error = undefined;
    entry.warning = undefined;
    this.setStatus(entry, wasEnabled ? 'enabled' : 'disabled');

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
    this.requestDeactivation(id, 'uninstalled'); // 终审 P1:同 disable,锁外立即记意图 + 吊销
    return this.withLifecycleLock(id, async () => {
      try {
        await this.uninstallLocked(id);
      } catch (err) {
        // 卸载失败、entry 仍在(目录未删)→ 降为禁用意图,用户可显式重新启用。
        if (this.entries.has(id) && this.deactivationIntents.get(id) === 'uninstalled') {
          this.deactivationIntents.set(id, 'disabled');
        }
        throw err;
      }
    });
  }

  private async uninstallLocked(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin ${id} not found`);
    if (!this.host.removePluginDir) {
      throw codedError('NOT_SUPPORTED', `host 未实现 removePluginDir`);
    }

    if (entry.instance || entry.enabledIntent) {
      // 注意:走 disableLocked(非 public disable),否则在已持有的同 id 锁上重入死锁
      await this.disableLocked(id);
    }
    // 停用时 _unregisterPlugin 失败会把 token 留在 entry 上待重试(见 revokePluginFsToken)。
    // 卸载会删 entry,丢掉这最后一个引用 → 主进程 token 仍 active、path scope 未撤销。故删目录
    // 前再重试回收;仍失败 → 卸载失败(不删目录、保留 entry),用户可重试。
    await this.revokePluginFsToken(entry);
    if (entry.pluginFsToken) {
      throw codedError(
        'PLUGIN_FS_TOKEN_REVOKE_FAILED',
        `plugin-fs token 回收失败,未卸载: ${id}`,
      );
    }
    await this.host.removePluginDir(id);
    this.entries.delete(id);
    this.invalidateListCache();
    // perf(#2):data.json 已随目录删除,淘汰本窗口内存里的插件数据缓存(禁用不淘汰:重新启用仍要用)。
    this.app.dataStore.forget?.(id);
  }

  /**
   * 别的窗口(或本窗口)卸载了插件(main 广播 plugins:uninstalled,终审 P1):对本窗口执行与本地卸载相同的
   * 停用 / 注销贡献点 / 回收 plugin-fs token / 移除 entry,并失效权限缓存;**不触盘**(main 已删目录、
   * 清 _enabled / _permissions)。幂等:发起卸载的窗口自身也会收到广播,entry 已不在 → 只清权限缓存。
   */
  async handleUninstalled(id: string): Promise<void> {
    // 先立即标记 + 取消弹窗 + 失效授权(等锁期间实例仍在,但已拿不到权限);锁内拆除后再清一次授权缓存
    //(防锁内在途激活写回)。
    this.markUninstalled(id);
    // 扫描完成前到达:等条目登记(init 已按停用意图把它建成 disabled)再拆除,否则 entry 残留为幽灵条目。
    const scanning = this.untilScanned();
    if (scanning) await scanning;
    return this.withLifecycleLock(id, async () => {
      const entry = this.entries.get(id);
      if (entry) {
        if (entry.instance) {
          await this.deactivateEntry(entry, `uninstalled ${id}`);
        }
        // 已停用但残留未回收的 token 再试一次;仍失败只记录(目录已删,不能像本地卸载那样中止)。
        await this.revokePluginFsToken(entry);
        this.entries.delete(id);
        this.invalidateListCache();
      }
      this.host.permissionStore?.forget?.(id);
      // perf(#2):实例已停用(onunload 的 saveData 已落地)后淘汰插件数据缓存;幂等。
      this.app.dataStore.forget?.(id);
    });
  }

  /**
   * 卸载广播到达时的同步部分(终审 P1,不等扫描 / 生命周期锁;handleUninstalled 开头调用):标记已卸载、
   * 取消该插件待决的授权弹窗(在途激活以 NOT_INSTALLED 失败、不写授权)、失效授权缓存。幂等。
   * 锁内拆除仍由 handleUninstalled 排队执行。
   */
  markUninstalled(id: string): void {
    this.requestDeactivation(id, 'uninstalled');
    this.host.cancelPermissionPrompt?.(id, uninstalledError(id));
    this.host.permissionStore?.forget?.(id);
  }

  /**
   * 禁用 / 卸载的同步部分(终审 P1:onload 挂起绕过禁用 / 卸载):不等生命周期锁、不等 init,立即吊销该插件当前
   * scoped app(激活中的实例在执行插件代码前就已挂上)、中止挂起的激活等待(锁随之释放),必要时立即终止其 shell 进程。
   * 锁内停用 / 卸载照旧排队执行。本地 disable / uninstall、远端禁用(handleEnabledChanged)与 markUninstalled 共用。幂等。
   */
  revokeImmediately(id: string): void {
    this.requestDeactivation(id, 'disabled');
  }

  /** 记录停用意图(见 deactivationIntents;'uninstalled' 不被 'disabled' 覆盖)并立即吊销。 */
  private requestDeactivation(id: string, kind: 'disabled' | 'uninstalled'): void {
    if (kind === 'uninstalled' || !this.deactivationIntents.has(id)) {
      this.deactivationIntents.set(id, kind);
    }
    // 尚无 entry(扫描未完成):意图已记下,init 建 entry 时按禁用处理。
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.scoped?.revoke();
    entry.abortActivation?.();
    // 正常运行的实例:锁空闲,锁内停用很快执行 —— 进程终止留在 onunload 之后(让插件先自行收尾)。
    // 激活挂起时锁内停用无法及时执行 → 此处立即终止。
    if (entry.activating) {
      void this.killPluginShellProcesses(id, `revoke ${id}`);
    }
  }

  /** 启用广播的同步部分(终审 P1,handleEnabledChanged 开头调用):显式启用 → 清除停用意图(见 deactivationIntents)。幂等。 */
  markEnabled(id: string): void {
    this.clearDisabledIntent(id);
  }

  /** 显式启用清除停用意图;已卸载('uninstalled')不清。 */
  private clearDisabledIntent(id: string): void {
    if (this.deactivationIntents.get(id) === 'disabled') this.deactivationIntents.delete(id);
  }

  /** 存在停用意图 → 抛(已卸载 NOT_INSTALLED / 已禁用 ACTIVATION_ABORTED)。在导入模块 / 构造实例前调用。 */
  private assertNoDeactivationIntent(id: string): void {
    const intent = this.deactivationIntents.get(id);
    if (intent === 'uninstalled') throw uninstalledError(id);
    if (intent === 'disabled') throw activationAbortedError(id);
  }

  /**
   * 插件贡献的界面渲染抛错(PluginRenderBoundary 接住后上报,BDD: plugin-render-isolation):运行中的插件标 failed
   *(RENDER_FAILED),实例保留 —— 对齐 VSCode,扩展视图出错不停用扩展,只就地显示错误。激活中(贡献已渲染、实例尚未
   * 就位)→ 记下,激活成功后直接落 failed。其余(已 failed / 停用中)→ 无操作(同一插件多处同时出错只记首个)。
   * 之后启用重试由 activateEntry 先停用这个仍在运行的实例。
   */
  markRenderFailed(id: string, err: unknown): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const error: PluginError = { code: 'RENDER_FAILED', message: errorMessage(err) };
    if (entry.status === 'enabled' && entry.instance) {
      this.setStatus(entry, 'failed', error);
      return;
    }
    // 激活中(onload 已注册贡献、界面已渲染,实例尚未就位):先记下,激活成功后直接落 failed(见 activateEntryUnguarded 结尾)。
    if (entry.activating && !entry.instance) entry.pendingRenderError ??= error;
  }

  /**
   * 订阅 listAll() 结果的变化(列表缓存每次失效时同步通知;此时条目状态已改完,listAll 返回新快照)。
   * 箭头属性:可直接交给 useSyncExternalStore。返回取消订阅。
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listListeners.add(listener);
    return () => {
      this.listListeners.delete(listener);
    };
  };

  /** 列出所有已发现插件状态(同一份列表在下次变化前返回同一引用)。 */
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
        ...(e.awaitingGrantElsewhere ? { awaitingGrantElsewhere: true as const } : {}),
      };
    }
    this.cachedList = list;
    return list;
  }

  // ── 内部 ────────────────────────────────────────────

  /**
   * 激活一个插件。任何一步抛错(权限门、注册 plugin-fs token、加载、构造、onload)都落成该插件的
   * `failed` 状态,绝不冒出本方法:init 逐个激活,冒出去会让后面的插件不进列表;reload 先把状态置为
   * 'enabled' 再激活,冒出去会留下「enabled 但没有实例」的半激活态(既关不掉也开不了)。
   */
  private async activateEntry(entry: PluginEntry): Promise<void> {
    // 渲染出错标 failed 的插件实例仍在运行(见 markRenderFailed):重试激活前先停用,不留双实例 / 重复贡献。
    if (entry.instance) await this.deactivateEntry(entry, `reactivate ${entry.id}`);
    entry.activating = true;
    entry.pendingRenderError = undefined;
    entry.awaitingGrantElsewhere = undefined; // 已在本窗口尝试激活(授权已决定或本窗口弹窗),不再等待别的窗口
    try {
      await this.activateEntryUnguarded(entry);
    } catch (err) {
      console.warn(`[plugin-manager] activate ${entry.id} failed`, err);
      entry.instance = undefined;
      this.setStatus(entry, 'failed', { code: errorCodeOf(err), message: errorMessage(err) });
      await this.revokePluginFsToken(entry);
    } finally {
      entry.activating = false;
      entry.abortActivation = undefined;
      entry.pendingRenderError = undefined;
      // 被禁用 / 卸载中止的激活落到 disabled(非失败);启用意图由排队的停用清除 / 落盘。
      if (this.deactivationIntents.has(entry.id) && !entry.instance) this.setStatus(entry, 'disabled');
    }
  }

  private async activateEntryUnguarded(entry: PluginEntry): Promise<void> {
    // 终审 P1:已请求禁用 / 卸载 → 任何激活路径都不激活(见 deactivationIntents)。
    this.assertNoDeactivationIntent(entry.id);
    // 先清前次的 error / warning,确保最终状态干净反映本次激活
    entry.error = undefined;
    entry.warning = undefined;
    this.invalidateListCache();

    // race(R29):若上次停用时 _unregisterPlugin 失败,entry.pluginFsToken 会被保留(见
    // revokePluginFsToken)。注册新 token 前先重试回收残留的旧 token,否则后面的赋值会用新
    // token 覆盖旧 token 引用 → 旧 token 在主进程仍 active 且永久失去引用。仍失败 → 中止本次
    // 激活(抛错由 activateEntry 落成 failed,残留 token 保留待下次重试);放在权限门 / 加载
    // 之前,中止时插件代码不会执行。生命周期锁串行化同 id 操作,此处无并发 deactivate 竞争。
    await this.revokePluginFsToken(entry);
    if (entry.pluginFsToken) {
      throw codedError(
        'PLUGIN_FS_TOKEN_REVOKE_FAILED',
        `plugin-fs token 回收失败,未激活: ${entry.id}`,
      );
    }
    // 已被禁用 / 卸载(请求已到、锁内拆除尚未执行)→ 不再为它弹授权窗。
    this.assertNoDeactivationIntent(entry.id);

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
        this.setStatus(entry, 'failed', {
          code: 'PERMISSION_DENIED',
          message: auth.deniedPerms.join(', '),
        });
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

    // 终审 P1:授权弹窗 / 授权写入 await 期间插件可能已被别的窗口卸载 → 不加载(import 即执行插件顶层代码)。
    this.assertNoDeactivationIntent(entry.id);
    // 终审 P1(onload 挂起 / 模块顶层 await 挂起):中止句柄在开始 import **之前**就挂到 entry —— 模块顶层 await 永不
    // 结束时,revokeImmediately 可中止等待,激活按禁用收尾、释放生命周期锁。import 本身无法取消:迟到完成的结果无人
    // 等待即被丢弃(不构造实例)。不设固定超时。句柄由 activateEntry 的 finally 清除。
    let abortActivation!: (err: Error) => void;
    const aborted = new Promise<never>((_, reject) => {
      abortActivation = reject;
    });
    aborted.catch(() => {});
    entry.abortActivation = () => abortActivation(activationAbortedError(entry.id));
    const loaded = await Promise.race([
      loadPluginModule({
        moduleUrl: entry.dirInfo.moduleUrl,
        manifest: entry.manifest,
        importer: (url) => this.host.importModule(url),
      }),
      aborted,
    ]);
    if (!loaded.ok) {
      console.warn(
        `[plugin-manager] load ${entry.id} failed: ${loaded.code} ${loaded.message}`,
      );
      this.setStatus(entry, 'failed', { code: loaded.code, message: loaded.message });
      return;
    }

    // 可维护性 M3:loader 现在把 PluginClass 类型为可构造的 PluginConstructor
    // (信任边界 runtime subclass 校验集中在 loader),此处直接 new,无需 as any。
    // v5 Phase 1:plugin 拿到的是 per-plugin scoped app(持 pluginId 给
    // permission.check;fs/network 等命名空间预留 Phase 3 启用 gating)
    this.assertNoDeactivationIntent(entry.id); // import await 期间被禁用 / 卸载 → 不构造实例
    const { token: pluginFsToken } =
      await coApi.pluginFsRaw._registerPlugin(entry.id);
    entry.pluginFsToken = pluginFsToken;
    const scoped = createScopedAppController(
      this.app,
      entry.id,
      this.host.permissionStore ?? null,
      pluginFsToken,
      // 有效权限 = 当前 manifest 声明 ∩ 已授权(升级删声明后旧授权失效)
      entry.manifest.permissions ?? EMPTY_PLUGIN_PERMISSIONS,
    );
    // 构造器必须和 _activate 同在 try/catch 内:token 已在上面注册并设 active,
    // 若 `new PluginClass()` 同步抛错(插件构造函数 throw)而它在 try 之外,就会跳出
    // activateEntry 既不撤 token 也不标 failed → entry 停在 status='enabled' 但
    // instance=undefined 的半激活态。后续 disableLocked 的 `!entry.instance` 守卫
    // 又会早退、不走 deactivateEntry → 泄漏的 plugin-fs capability token 永不回收
    // (复审 loop R1)。
    // 终审 P1(onload 挂起):控制面在执行插件代码(构造 / onload)**之前**挂到 entry(中止句柄已在 import 前备好)——
    // 激活挂起期间收到禁用 / 卸载,revokeImmediately 可立即吊销并中止等待(否则 entry.scoped 要等 onload 返回才写入)。
    entry.scoped = scoped;
    let instance: Plugin;
    try {
      // _registerPlugin await 期间被要求吊销 → 不构造实例。
      this.assertNoDeactivationIntent(entry.id);
      instance = new loaded.PluginClass(scoped.app, entry.manifest);
      await instance._activate(aborted);
    } catch (err) {
      console.warn(
        `[plugin-manager] activate ${entry.id} failed`,
        err,
      );
      // 终审 P1:失败实例已排程的延迟回调不能再使用能力 —— 先吊销 scoped app。
      scoped.revoke();
      entry.scoped = undefined;
      this.setStatus(entry, 'failed', { code: errorCodeOf(err), message: errorMessage(err) });
      await this.revokePluginFsToken(entry);
      // 终审 P1:构造函数 / onload 抛错前可能已 exec / execStream 启动 shell 进程;失败实例不挂
      // entry.instance,之后禁用 / 卸载都走不到 deactivateEntry → 此处同样终止。
      await this.killPluginShellProcesses(entry.id, `activate ${entry.id}`);
      return;
    }

    entry.instance = instance;
    // 激活期间界面已渲染出错:实例保留,直接落 failed(与激活后出错同一终态,通知由 PluginFailureNotifier 去重发出)。
    if (entry.pendingRenderError) this.setStatus(entry, 'failed', entry.pendingRenderError);
    else this.setStatus(entry, 'enabled');
    // entry.error / warning 已在方法开头清(成功路径不再重复 reset 错误,
    // warning 若 partial grant 已在权限段设了)
  }

  /**
   * 状态转换单一出口(此前 10 处各自手写 status + error / warning + 失效缓存,失败转换漏清 warning):
   * - failed:记 error,清 warning(partial-grant 只对 active 插件有意义;否则行同显错误与「⚠ 部分授权」)。
   * - disabled:清 error 与 warning(PluginsTab 行无 status 门控地渲染二者)。
   * - enabled:只改状态(保留本次激活权限段设的 partial-grant warning)。
   */
  private setStatus(entry: PluginEntry, status: 'failed', error: PluginError): void;
  private setStatus(entry: PluginEntry, status: 'enabled' | 'disabled'): void;
  private setStatus(entry: PluginEntry, status: Status, error?: PluginError): void {
    entry.status = status;
    if (status !== 'enabled') {
      entry.error = error;
      entry.warning = undefined;
    }
    this.invalidateListCache();
  }

  private invalidateListCache(): void {
    this.cachedList = null;
    for (const listener of [...this.listListeners]) listener();
  }

  private async deactivateEntry(
    entry: PluginEntry,
    label: string,
  ): Promise<void> {
    // 终审 P1:先吊销 scoped app,再调 onunload —— 延迟回调、超时后仍在跑的 onunload 调用有外部副作用的
    // 能力(shell / network / fs 写等)在 renderer 源头被拒,停用后不再起新进程(killPluginShellProcesses
    // 只能回收已登记的进程)。onunload 收尾仍可用 fs 读 / dataStore(见 scoped-app 文件头)。
    entry.scoped?.revoke();
    entry.scoped = undefined;
    try {
      await entry.instance?._deactivate();
    } catch (err) {
      console.warn(`[plugin-manager] ${label} failed`, err);
    } finally {
      entry.instance = undefined;
      await this.revokePluginFsToken(entry);
      // 终审 P1:disable / uninstall / 远端卸载 / reload 都经此处 —— 终止该插件在本窗口的
      // shell 进程(exec + 流式)。放在 _deactivate 之后:插件 onunload 可先自行收尾(_deactivate 对 onunload
      // 有等待上限,挂起的钩子不会阻塞这里的能力回收)。失败只记录,不阻断停用。
      await this.killPluginShellProcesses(entry.id, label);
    }
  }

  private async killPluginShellProcesses(id: string, label: string): Promise<void> {
    try {
      await this.host.killPluginShellProcesses?.(id);
    } catch (err) {
      console.warn(`[plugin-manager] ${label} kill shell processes failed`, err);
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
// main-app.ts 在 bootCorePlugins 后实例化并 init();其它地方通过 getter 访问
// 当前快照(用于 Plugins SettingTab 等 UI)。

let _userManager: PluginManager | null = null;

export function setUserPluginManager(m: PluginManager): void {
  _userManager = m;
}

export function getUserPluginManager(): PluginManager | null {
  return _userManager;
}
