// LM 插件抽象基类 + Disposable LIFO 自动清理(M-Plugin v1)。
// 仿 Obsidian Plugin/Component 的 disposable 模型。详见 doc/10。
//
// 子类必须实现 onload();可选 onunload()。所有贡献点(后续模块)
// 内部调用 this.register(d) 收集 Disposable,_deactivate 时反序清理。

import type { Disposable, CoPluginApp, PluginManifest } from './types';
import type { PanelSpec } from './registries/PanelRegistry';
import type { CommandSpec } from './registries/CommandRegistry';
import type { StatusBarItemSpec } from './registries/StatusBarRegistry';
import type { RibbonActionSpec } from './registries/RibbonRegistry';
import type { SettingItemSpec } from './registries/SettingItemRegistry';
import type { SettingTabSpec } from './registries/SettingTabRegistry';
import type { DecoratorFn } from './registries/ExplorerDecoratorRegistry';
import type { EditorActionSpec } from './registries/EditorActionRegistry';
import type { ExplorerContextMenuItemSpec } from './registries/ExplorerContextMenuRegistry';
import type { PluginMcpToolSpec } from './registries/PluginMcpRegistry';

export type { Disposable } from './types';

/**
 * onunload 等待上限。插件 onunload 挂起(永不 resolve)时,停用方(PluginManager.deactivateEntry)
 * 不能被它永久阻塞 —— 其后的 FS token 回收、shell 进程终止与禁用落盘都不依赖插件钩子是否返回。
 * 5s 足够正常的业务收尾(落盘 / 关连接),又不至于让禁用 / 卸载 / 退出明显卡住。
 */
export const PLUGIN_UNLOAD_TIMEOUT_MS = 5000;

export abstract class Plugin {
  /** v5 Phase 1:per-plugin scoped app(含 fs/network/clipboard/permission). */
  readonly app: CoPluginApp;
  readonly manifest: PluginManifest;
  private disposables: Disposable[] = [];
  private disposed = false;

  constructor(app: CoPluginApp, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }

  /** 必填:插件激活入口。 */
  abstract onload(): void | Promise<void>;

  /** 可选:插件卸载钩子,父类已自动清理 disposables,此处放业务卸载逻辑。 */
  onunload?(): void | Promise<void>;

  // ── 贡献点代理(M-Plugin v1.5)───────────────────────
  // 全部内部调 app.<reg>.register(spec) 拿 Disposable,自动 this.register(d)。
  // unload 时 LIFO 清理 → 该插件所有贡献从 registry 退出。

  protected registerPanel(spec: PanelSpec): Disposable {
    return this.register(this.app.panels.register(spec));
  }

  protected addCommand(spec: CommandSpec): Disposable {
    return this.register(this.app.commands.register(spec));
  }

  protected addStatusBarItem(spec: StatusBarItemSpec): Disposable {
    return this.register(this.app.statusBar.register(spec));
  }

  protected addRibbonAction(spec: RibbonActionSpec): Disposable {
    return this.register(this.app.ribbon.register(spec));
  }

  protected registerEvent(spec: {
    readonly name: string;
    readonly fn: (payload: unknown) => void;
  }): Disposable {
    return this.register(this.app.events.on(spec.name, spec.fn));
  }

  /** 读取该插件持久化数据;不存在 / IO 失败返 null. */
  protected async loadData<T = unknown>(): Promise<T | null> {
    try {
      return (await this.app.dataStore.read(this.manifest.id)) as T | null;
    } catch (err) {
      console.warn(
        `[plugin:${this.manifest.id}] loadData failed`,
        err,
      );
      return null;
    }
  }

  /** 保存该插件数据;data 必须 JSON-serializable;抛错向上传. */
  protected async saveData(data: unknown): Promise<void> {
    await this.app.dataStore.write(this.manifest.id, data);
  }

  protected addSettingTab(spec: SettingTabSpec): Disposable {
    return this.register(this.app.settingTabs.register(spec));
  }

  /** 注册单个设置项(v6),Plugin 卸载时自动 dispose. */
  protected addSettingItem(spec: SettingItemSpec): Disposable {
    return this.register(this.app.settingItems.register(spec));
  }

  protected registerExplorerDecorator(fn: DecoratorFn): Disposable {
    return this.register(this.app.explorerDecorators.register(fn));
  }

  protected registerEditorAction(spec: EditorActionSpec): Disposable {
    return this.register(this.app.editorActions.register(spec));
  }

  /** Explorer 右键菜单贡献(V1,2026-05). 同步返 Disposable,_deactivate 自动清理. */
  protected registerExplorerContextMenuItem(
    spec: ExplorerContextMenuItemSpec,
  ): Disposable {
    return this.register(this.app.explorerContextMenu.register(spec));
  }

  /**
   * v5 Phase 4:注册 MCP tool 供 Agent 调用。
   *
   * 注意此 proxy 是 async(其他贡献点同步返回)— 因为权限检 + 上行 IPC 必须 await。
   * 失败(权限 / 重名 / IPC 错)→ reject,plugin 自行 try/catch 决定降级。
   * 成功的 Disposable 自动入 disposables,_deactivate 时 LIFO 反序 dispose →
   * 触发 main 端 host 摘掉 stub。
   *
   * 边界:已 _deactivate 后再 await 此方法,upstream.register 仍会被调,但
   * 返回的 Disposable 会被 this.register 立即 dispose(防泄漏)— 同其他贡献点契约。
   */
  protected async registerMcpTool<I, O>(
    spec: PluginMcpToolSpec<I, O>,
  ): Promise<Disposable> {
    const d = await this.app.mcp.register(spec);
    return this.register(d);
  }

  /**
   * 收集需要在 unload 时清理的 disposable。
   * 已 deactivate 后再 register → 立即 dispose 防泄漏,仍返回 d。
   */
  protected register<D extends Disposable>(d: D): D {
    if (this.disposed) {
      try {
        d.dispose();
      } catch (err) {
        console.warn(
          `[plugin:${this.manifest.id}] late dispose threw`,
          err,
        );
      }
      return d;
    }
    this.disposables.push(d);
    return d;
  }

  /**
   * 内部:LM 内核调用。已 deactivate 的 plugin 不可复用。
   *
   * onload 抛错时(plugin 中途 register 了一些 d 后失败),已收的 disposables
   * 被 LIFO 清理(防泄漏到 panel / command / mcp 等 registry),disposed
   * 标 true,**不调 onunload**(plugin 没完成初始化,业务卸载钩子无意义,
   * plugin 作者一般也不会写"半初始化态"的 onunload)。然后原错抛上去。
   * abort(可选):reject 时视同 onload 抛错(PluginManager 在激活挂起期间被禁用 / 卸载时中止)。
   */
  async _activate(abort?: Promise<never>): Promise<void> {
    if (this.disposed) {
      throw new Error(
        `Plugin ${this.manifest.id} already deactivated, cannot reuse`,
      );
    }
    try {
      if (abort) {
        // 终审 P1(onload 挂起):abort reject(激活期间被禁用 / 卸载)→ 不再等 onload,按 onload 抛错同样收尾;
        // 迟到的 onload 结果吞掉(防 unhandled rejection),其后的 register 因 disposed 立即 dispose。
        const loading = Promise.resolve(this.onload());
        loading.catch(() => {});
        await Promise.race([loading, abort]);
      } else {
        await this.onload();
      }
    } catch (err) {
      this.disposed = true;
      this.disposeCollected();
      throw err;
    }
  }

  /**
   * 内部:LM 内核调用。幂等;LIFO 反序 dispose;单 dispose 抛错不传染。
   * onunload 超过 PLUGIN_UNLOAD_TIMEOUT_MS 未返回 → warn 后放弃等待(钩子本身无法取消,任其后台结束)。
   */
  async _deactivate(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeCollected();
    if (!this.onunload) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), PLUGIN_UNLOAD_TIMEOUT_MS);
    });
    try {
      const r = await Promise.race([Promise.resolve(this.onunload()), timedOut]);
      if (r === 'timeout') {
        console.warn(
          `[plugin:${this.manifest.id}] onunload did not settle within ${PLUGIN_UNLOAD_TIMEOUT_MS}ms, continuing deactivation`,
        );
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** LIFO 清掉已收集的 disposables;单个抛错不传染。_activate 失败 / _deactivate 复用. */
  private disposeCollected(): void {
    for (let i = this.disposables.length - 1; i >= 0; i--) {
      const d = this.disposables[i];
      if (!d) continue;
      try {
        d.dispose();
      } catch (err) {
        console.warn(
          `[plugin:${this.manifest.id}] dispose failed`,
          err,
        );
      }
    }
    this.disposables = [];
  }
}
