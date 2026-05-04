// LM 插件抽象基类 + Disposable LIFO 自动清理(M-Plugin v1)。
// 仿 Obsidian Plugin/Component 的 disposable 模型。详见 doc/10。
//
// 子类必须实现 onload();可选 onunload()。所有贡献点(后续模块)
// 内部调用 this.register(d) 收集 Disposable,_deactivate 时反序清理。

import type { Disposable, LMApp, PluginManifest } from './types';
import type { PanelSpec } from './registries/PanelRegistry';
import type { CommandSpec } from './registries/CommandRegistry';
import type { StatusBarItemSpec } from './registries/StatusBarRegistry';

export type { Disposable } from './types';

export abstract class Plugin {
  readonly app: LMApp;
  readonly manifest: PluginManifest;
  private disposables: Disposable[] = [];
  private disposed = false;

  constructor(app: LMApp, manifest: PluginManifest) {
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

  /** 内部:LM 内核调用。已 deactivate 的 plugin 不可复用。 */
  async _activate(): Promise<void> {
    if (this.disposed) {
      throw new Error(
        `Plugin ${this.manifest.id} already deactivated, cannot reuse`,
      );
    }
    await this.onload();
  }

  /** 内部:LM 内核调用。幂等;LIFO 反序 dispose;单 dispose 抛错不传染。 */
  async _deactivate(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
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
    if (this.onunload) await this.onunload();
  }
}
