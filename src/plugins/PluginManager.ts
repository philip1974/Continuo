// 插件目录扫描 + 启用禁用 + 生命周期编排(M-Plugin v1.4)。
// I/O 完全注入(ManagerHost),便于 jsdom 单测;生产由主进程 IPC 实现。

import { Plugin } from './Plugin';
import { loadPluginModule } from './loader';
import { isVersionCompatible, parseManifest } from './manifest';
import { ensureAuthorized, type PermissionStore, type PromptFn } from './permissions';
import type { LMApp, PluginManifest } from './types';

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
}

// ── PluginEntry / Status ───────────────────────────────

type Status = 'enabled' | 'disabled' | 'failed';

interface PluginEntry {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly dirInfo: PluginDirInfo;
  status: Status;
  instance?: Plugin;
  error?: string;
}

export interface PluginListItem {
  readonly id: string;
  readonly manifest: PluginManifest;
  readonly status: Status;
  readonly error?: string;
}

// ── PluginManager ──────────────────────────────────────

export class PluginManager {
  private entries = new Map<string, PluginEntry>();
  /** 已激活顺序(用于 shutdown LIFO). */
  private activationOrder: string[] = [];

  constructor(
    private readonly app: LMApp,
    private readonly host: ManagerHost,
  ) {}

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
        await this.activateEntry(entry);
      }
    }
  }

  /** 关闭所有 active 插件,LIFO 反序. */
  async shutdown(): Promise<void> {
    for (let i = this.activationOrder.length - 1; i >= 0; i--) {
      const id = this.activationOrder[i]!;
      const entry = this.entries.get(id);
      if (entry?.instance) {
        try {
          await entry.instance._deactivate();
        } catch (err) {
          console.warn(`[plugin-manager] shutdown ${id} failed`, err);
        }
      }
    }
    this.activationOrder = [];
  }

  /** 启用单个插件(若已 active 幂等). */
  async enable(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin ${id} not found`);
    if (entry.status === 'enabled') return; // 幂等

    await this.activateEntry(entry);
    // activateEntry 是 mutating 方法,TS 不知道 status 已变。
    // 重新从 map 取拿到 widening 后的类型。
    const after = this.entries.get(id);
    if (after?.status === 'enabled') {
      const ids = [...(await this.host.readEnabledIds()), id];
      await this.host.writeEnabledIds(Array.from(new Set(ids)));
    }
  }

  /** 禁用单个插件(若已 disabled 幂等). */
  async disable(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Plugin ${id} not found`);
    if (entry.status !== 'enabled' || !entry.instance) return;

    try {
      await entry.instance._deactivate();
    } catch (err) {
      console.warn(`[plugin-manager] disable ${id} failed`, err);
    }
    entry.instance = undefined;
    entry.status = 'disabled';
    this.activationOrder = this.activationOrder.filter((x) => x !== id);

    const remaining = [...(await this.host.readEnabledIds())].filter(
      (x) => x !== id,
    );
    await this.host.writeEnabledIds(remaining);
  }

  /** 列出所有已发现插件状态. */
  listAll(): readonly PluginListItem[] {
    return Array.from(this.entries.values()).map((e) => ({
      id: e.id,
      manifest: e.manifest,
      status: e.status,
      error: e.error,
    }));
  }

  // ── 内部 ────────────────────────────────────────────

  private async activateEntry(entry: PluginEntry): Promise<void> {
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

    // v3.4 权限门:manifest 声明了 permissions 且 host 配了 store + prompt
    // 才阻塞;否则放行(向后兼容)
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
    }

    // PluginClass 是 abstract,但实际传进来的是子类构造函数
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor = loaded.PluginClass as any;
    const instance: Plugin = new Ctor(this.app, entry.manifest);

    try {
      await instance._activate();
    } catch (err) {
      console.warn(
        `[plugin-manager] activate ${entry.id} failed`,
        err,
      );
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      return;
    }

    entry.instance = instance;
    entry.status = 'enabled';
    this.activationOrder.push(entry.id);
  }
}
