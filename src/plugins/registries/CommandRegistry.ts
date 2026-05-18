// Plugin 贡献的命令注册表(M-Plugin v1.5)。
// 命令面板订阅本 registry 渲染列表;keybinding 解析时按 hotkey 分发。

import type { Disposable } from '../types';

export interface CommandSpec {
  readonly id: string;
  readonly title: string;
  /**
   * i18n key（topic-19）。类型 string 不绑死 keyof typeof en（开放第三方 plugin）；
   * 核心 plugin 可写 `'commands.terminal.new.title' satisfies TranslationKey` 编译验。
   * 渲染层 `tWithFallback(titleKey, title)` 兜底，缺 key 不退化为 key 字面量。
   */
  readonly titleKey?: string;
  /** Accelerator string,如 'mod+s' / 'mod+shift+p',可选. */
  readonly hotkey?: string;
  /**
   * 分类前缀(如 'Settings' / 'Editor' / 'Git')。CommandPalette 显示
   * `${category}: ${title}`,fuzzy 匹配同时覆盖 category + title。
   * VSCode 同款。可选,向后兼容。
   */
  readonly category?: string;
  /** i18n key for category（topic-19）。同 titleKey。 */
  readonly categoryKey?: string;
  readonly fn: () => void | Promise<void>;
}

type Listener = () => void;

export class CommandRegistry {
  private items = new Map<string, CommandSpec>();
  private listeners = new Set<Listener>();

  register(spec: CommandSpec): Disposable {
    if (this.items.has(spec.id)) {
      console.warn(
        `[command-registry] id "${spec.id}" 已注册,后注册赢覆盖前者`,
      );
    }
    if (spec.hotkey && this.findByHotkey(spec.hotkey)) {
      console.warn(
        `[command-registry] hotkey "${spec.hotkey}" 已被另一命令占用,后注册赢`,
      );
    }
    this.items.set(spec.id, spec);
    this.notify();

    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.items.get(spec.id) === spec) {
          this.items.delete(spec.id);
          this.notify();
        }
      },
    };
  }

  getAll(): readonly CommandSpec[] {
    return Array.from(this.items.values());
  }

  /** 按 hotkey 查命令(后注册者优先,因为 Map.values 保留插入序). */
  getByHotkey(hotkey: string): CommandSpec | undefined {
    let found: CommandSpec | undefined;
    for (const c of this.items.values()) {
      if (c.hotkey === hotkey) found = c;
    }
    return found;
  }

  async execute(id: string): Promise<void> {
    const cmd = this.items.get(id);
    if (!cmd) throw new Error(`Command ${id} not found`);
    await cmd.fn();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private findByHotkey(hotkey: string): CommandSpec | undefined {
    for (const c of this.items.values()) if (c.hotkey === hotkey) return c;
    return undefined;
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }
}
